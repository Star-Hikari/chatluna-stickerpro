// 评审状态机（设计 §6.4）：token CAS + 超时恢复（继承旧插件精华）+ 可配置提示词（r2）
// 排队在**占令牌之前**完成（修复旧版"持 judging 等信号量"导致的重复判断窗口）。

import type { Context, Logger } from 'koishi'
import { HumanMessage, SystemMessage } from '@langchain/core/messages'
import type { ChatLunaChatModel } from 'koishi-plugin-chatluna/llm-core/platform/model'
// 触发 chatluna 对 koishi Context 的服务增强（ctx.chatluna）；type-only，不产生运行期 import
import type { ChatLunaService } from 'koishi-plugin-chatluna/services/chat'
import { REVIEW_JSON_CONTRACT } from './config'
import type { Config } from './config'
import { planModelImages } from './image'
import type { StickerLibrary } from './library'
import type { StickerStatus } from './types'
import { Semaphore, extractJson, hamming, isVisionUnsupportedError, makeToken } from './utils'

export interface JudgeVerdict {
  collect: boolean
  tags: string[]
  description: string
  usageHint: string
  /** 人类/模型留下的独立备注（sticker_save 的 note；不参与检索，只做审计） */
  note?: string
  /** 与库内某张实质重复（dupOf 命中） */
  duplicateOf?: string
  error?: string
  /** 模型明确不支持图片输入 */
  visionUnsupported?: boolean
}

function contentToText(content: any): string {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content
      .map((c: any) => (typeof c === 'string' ? c : c?.type === 'text' ? c.text : ''))
      .join('')
  }
  return String(content ?? '')
}

export class Judge {
  /**
   * createChatModel 返回 ComputedRef：模型晚于本插件 ready 就绪时，值会随后出现。
   * 因此存 ref 而不是拍快照，hasModel 每次现读。
   */
  private modelRef: { value: ChatLunaChatModel | undefined } | null = null
  private sem: Semaphore
  /** 进程内短路（同旧插件 judging:Set 语义） */
  private inFlight = new Set<string>()
  /** 防止并发重复建模型（重试窗口/事件可能同时触发） */
  private starting = false

  constructor(
    private readonly ctx: Context,
    private readonly config: Config,
    private readonly library: StickerLibrary,
    private readonly logger: Logger,
  ) {
    this.sem = new Semaphore(Math.max(1, config.review.concurrency))
  }

  /** 当前可用的判官模型（未就绪为 undefined） */
  get model(): ChatLunaChatModel | undefined {
    return this.modelRef?.value
  }

  get hasModel(): boolean {
    return !!this.model
  }

  /**
   * 建判官模型（幂等、可重试）：已就绪直接返回；未配置返回 false；
   * 失败/暂不可用时不锁定状态，等下一次 start()（轮询或 chatluna/model-added 事件）。
   */
  async start(): Promise<boolean> {
    if (this.model) return true
    if (this.starting) return false
    if (!this.config.review.model || this.config.review.model === '无') {
      this.logger.debug('[judge] 未配置判官模型：评审关闭路径生效（达阈值直接入库）')
      return false
    }
    this.starting = true
    try {
      this.modelRef = await this.ctx.chatluna.createChatModel(this.config.review.model)
      if (!this.model) {
        this.logger.warn(`[judge] 模型 ${this.config.review.model} 暂不可用（等待 chatluna/model-added 或重试窗口）`)
      }
      return !!this.model
    } catch (e) {
      this.logger.warn(`[judge] createChatModel 失败：${e instanceof Error ? e.message : String(e)}`)
      return false
    } finally {
      this.starting = false
    }
  }

  // ───────── CAS 状态机 ─────────

  /** 抢占评审令牌：pending_review → judging（set 带条件 + 回读校验，同旧插件口径） */
  private async tryAcquire(pHash: string): Promise<string | null> {
    const token = makeToken()
    await this.ctx.database.set(
      'stickerpro_occurrence',
      { pHash, status: 'pending_review' },
      { status: 'judging', judgeStartedAt: Date.now(), judgeToken: token, judgeError: '' },
    )
    const rows = await this.ctx.database.get('stickerpro_occurrence', { pHash })
    const row = rows[0]
    if (!row || row.status !== 'judging' || row.judgeToken !== token) return null
    return token
  }

  /** 释放令牌：只有令牌仍属于自己才写回终态 */
  private async release(pHash: string, token: string, status: StickerStatus, error?: string): Promise<void> {
    await this.ctx.database.set(
      'stickerpro_occurrence',
      { pHash, status: 'judging', judgeToken: token },
      { status, judgeToken: '', judgeError: (error ?? '').slice(0, 500) },
    )
  }

  // ───────── 评审主流程 ─────────

  /**
   * 评审一张待判图片。调用方保证图已落盘。
   * collect=true 时返回档案数据供 caller 写 meta/向量；caller 负责后续状态回写。
   */
  async judgeOne(pHash: string, bytes: Buffer, mime: string): Promise<JudgeVerdict> {
    if (this.inFlight.has(pHash)) return { collect: false, tags: [], description: '', usageHint: '', error: 'in-flight' }
    if (!this.model) {
      // 兜底：调用方应在 processPending 里走"无模型直接入库"分支；走到这里按失败处理
      return { collect: false, tags: [], description: '', usageHint: '', error: 'judge model unavailable' }
    }
    this.inFlight.add(pHash)
    try {
      return await this.sem.run(() => this.judgeInner(pHash, bytes, mime))
    } finally {
      this.inFlight.delete(pHash)
    }
  }

  private async judgeInner(pHash: string, bytes: Buffer, mime: string): Promise<JudgeVerdict> {
    const model = this.model
    if (!model) return { collect: false, tags: [], description: '', usageHint: '', error: 'judge model unavailable' }
    const dupBlock = await this.buildDupBlock(pHash)
    const system =
      this.config.review.promptTemplate.replaceAll('{{DUP_BLOCK}}', dupBlock) +
      '\n\n' +
      REVIEW_JSON_CONTRACT
    if (this.config.debug) this.logger.debug(`[judge] 完整 system prompt：\n${system}`)

    // 全局投递链（设计附录 D 第 10 条，2026-11-06 起评审也走它）：
    // 小 GIF 直传 → 等间隔抽帧 → 首帧/单图兜底；某一级调用异常或输出无法解析时自动退下一级。
    // 唯一例外：模型明确不支持视觉时不重试（换输入形态无意义），直接熔断给上层。
    const attempts = planModelImages(bytes, mime, { logger: this.logger })
    let json: any = null
    let lastError: JudgeVerdict | null = null
    for (let i = 0; i < attempts.length; i++) {
      const attempt = attempts[i]
      const payload = await attempt.build()
      if (!payload) continue
      const user = new HumanMessage({
        content: [
          ...payload.images.map((image) => ({
            type: 'image_url',
            image_url: { url: `data:${image.mime};base64,${image.bytes.toString('base64')}` },
          })),
          {
            type: 'text',
            text: `${payload.hint ? payload.hint + '\n' : ''}这张图是否值得收藏为表情包？`,
          },
        ] as any,
      })
      let text = ''
      try {
        const reply = await model.invoke([new SystemMessage(system), user])
        text = contentToText((reply as any)?.content)
      } catch (e) {
        if (isVisionUnsupportedError(e)) {
          const msg = `模型 ${this.config.review.model} 不支持图片输入，请换多模态模型后重启插件`
          this.logger.warn(`[judge] ${msg}`)
          return { collect: false, tags: [], description: '', usageHint: '', error: msg, visionUnsupported: true }
        }
        const msg = e instanceof Error ? e.message : String(e)
        this.logger.debug(`[judge] ${attempt.label} 调用失败：${msg}`)
        lastError = { collect: false, tags: [], description: '', usageHint: '', error: msg }
        continue
      }
      json = extractJson(text)
      if (json) break
      this.logger.debug(`[judge] ${attempt.label} 输出无法解析：${text.slice(0, 200)}`)
      lastError = {
        collect: false,
        tags: [],
        description: '',
        usageHint: '',
        error: `模型输出无法解析：${text.slice(0, 200)}`,
      }
    }
    if (!json) {
      return lastError ?? { collect: false, tags: [], description: '', usageHint: '', error: '图片输入构造失败' }
    }
    const verdict: JudgeVerdict = {
      collect: json.collect === true,
      tags: Array.isArray(json.tags) ? json.tags.filter((t: any) => typeof t === 'string').slice(0, 8) : [],
      description: typeof json.description === 'string' ? json.description : '',
      usageHint: typeof json.usageHint === 'string' ? json.usageHint : '',
    }
    const dupOf = typeof json.dupOf === 'string' ? json.dupOf.trim() : ''
    if (dupOf && verdict.collect) {
      const canonical = await this.resolveDupRef(dupOf, pHash)
      if (canonical) {
        verdict.collect = false
        verdict.duplicateOf = canonical
        this.logger.debug(`[judge] ${pHash} 判为 ${canonical} 的重复变体`)
      }
    }
    return verdict
  }

  /** 近邻候选段（汉明距 ≤8 的已收藏表情 top-3；千级库全表扫描一次 <5ms，可接受） */
  private async buildDupBlock(pHash: string): Promise<string> {
    const metas = await this.library.listMeta()
    if (!metas.length) return ''
    const near = metas
      .map((m) => ({ m, d: hamming(m.pHash, pHash) }))
      .filter((x) => Number.isFinite(x.d) && x.d <= 8)
      .sort((a, b) => a.d - b.d)
      .slice(0, 3)
    if (!near.length) return ''
    const list = near
      .map((x, i) => `${i + 1}. 编号前缀 ${x.m.pHash.slice(0, 8)}（汉明 ${x.d}）：${x.m.description || x.m.usageHint || '(无档案)'}`)
      .join('\n')
    return this.config.review.dupBlockTemplate.replace('{{DUP_LIST}}', list)
  }

  /** dupOf 可能是"编号"（1-based，与 buildDupBlock 一致）也可能是 pHash 前缀 */
  private async resolveDupRef(dupOf: string, pHash: string): Promise<string | null> {
    const metas = await this.library.listMeta()
    const near = metas
      .map((m) => ({ m, d: hamming(m.pHash, pHash) }))
      .filter((x) => Number.isFinite(x.d) && x.d <= 8)
      .sort((a, b) => a.d - b.d)
      .slice(0, 3)
    if (/^\d+$/.test(dupOf)) {
      const idx = parseInt(dupOf, 10) - 1
      return near[idx]?.m.pHash ?? null
    }
    const hit = near.find((x) => x.m.pHash.startsWith(dupOf))
    return hit?.m.pHash ?? null
  }

  // ───────── 描述生成（无视觉兜底 / 评审关闭时补档案）─────────

  /**
   * 多图描述（底层调用）：把一组图片块 + 档案请求交给判官模型。
   * 首选走 describe() 的投递链；这里保留公开入口供自定义多图场景使用。
   */
  async describeImages(
    images: { bytes: Buffer; mime: string }[],
    hint?: string,
  ): Promise<{ description: string; tags: string[]; usageHint: string } | null> {
    const model = this.model
    if (!model || !images.length) return null
    const selected = images.slice(0, 12)
    return this.sem.run(async () => {
      try {
        const content: any[] = selected.map((image) => ({
          type: 'image_url',
          image_url: { url: `data:${image.mime};base64,${image.bytes.toString('base64')}` },
        }))
        content.push({
          type: 'text',
          text: hint ? `${hint}\n请为这张表情包图片生成档案。` : '请为这张表情包图片生成档案。',
        })
        const reply = await model.invoke([
          new SystemMessage(this.config.review.describePrompt),
          new HumanMessage({ content } as any),
        ])
        const json = extractJson(contentToText((reply as any)?.content))
        if (!json || typeof json.description !== 'string') return null
        return {
          description: json.description,
          tags: Array.isArray(json.tags) ? json.tags.filter((t: any) => typeof t === 'string').slice(0, 8) : [],
          usageHint: typeof json.usageHint === 'string' ? json.usageHint : '',
        }
      } catch (e) {
        this.logger.debug(`[judge] describe 失败：${e instanceof Error ? e.message : String(e)}`)
        return null
      }
    })
  }

  /**
   * 生成文字档案的全局入口：走 image.ts 的投递链（设计附录 D 第 10 条）——
   * 小 GIF 直传 image/gif、大 GIF/直传失败等间隔抽帧多图 JPEG、最后首帧 JPEG 兜底；
   * 静态图 png/jpeg/bmp 且 ≤2MB 时就是原字节单图。
   */
  async describe(
    bytes: Buffer,
    mime: string,
    options: { gifDirectMaxBytes?: number } = {},
  ): Promise<{ description: string; tags: string[]; usageHint: string } | null> {
    const attempts = planModelImages(bytes, mime, { ...options, logger: this.logger })
    for (let i = 0; i < attempts.length; i++) {
      const payload = await attempts[i].build()
      if (!payload) continue
      const result = await this.describeImages(payload.images, payload.hint)
      if (result) return result
      if (i < attempts.length - 1) {
        this.logger.debug(`[judge] ${attempts[i].label} 档案生成失败，降级下一级输入（${attempts[i + 1].label}）`)
      }
    }
    return null
  }

  // ───────── 待评审驱动 / 超时恢复 ─────────

  /** 图片字节提供者（index.ts 装配时注入，避免 Judge 直接依赖 Storage 实例） */
  storageProvider?: (pHash: string) => Promise<{ bytes: Buffer; mime: string } | null>

  /**
   * 处理一条 pending_review：抢占 → 读图 → 评审 → 回写状态。
   * 返回处理后的最终状态（caller 不再需要关心细节）。
   */
  async processPending(
    pHash: string,
    onCollected: (pHash: string, verdict: JudgeVerdict) => Promise<void>,
  ): Promise<'collected' | 'rejected' | 'judge_failed' | 'skipped'> {
    const token = await this.tryAcquire(pHash)
    if (!token) return 'skipped'

    const rows = await this.ctx.database.get('stickerpro_occurrence', { pHash })
    const occ = rows[0]
    if (!occ) {
      await this.release(pHash, token, 'rejected', 'occurrence 行不存在')
      return 'rejected'
    }
    const image = this.storageProvider ? await this.storageProvider(pHash) : null
    if (!image) {
      await this.release(pHash, token, 'judge_failed', '本地图片缺失，无法评审')
      return 'judge_failed'
    }

    // 评审关闭 或 无判官模型：直接入库
    const model = this.model
    if (!this.config.review.enabled || !model) {
      const verdict: JudgeVerdict = { collect: true, tags: [], description: '', usageHint: '' }
      // 尽力补档案（有模型才调）
      if (model) {
        const d = await this.describe(image.bytes, image.mime)
        if (d) {
          verdict.description = d.description
          verdict.tags = d.tags
        }
      }
      await onCollected(pHash, verdict)
      await this.release(pHash, token, 'collected')
      return 'collected'
    }

    const verdict = await this.judgeOne(pHash, image.bytes, image.mime)
    if (verdict.visionUnsupported) {
      // 模型不支持视觉：熔断为 judge_failed，等用户换模型（旧插件同款保护）
      await this.release(pHash, token, 'judge_failed', verdict.error)
      return 'judge_failed'
    }
    if (verdict.error && !verdict.collect && !verdict.duplicateOf) {
      await this.release(pHash, token, 'judge_failed', verdict.error)
      return 'judge_failed'
    }
    if (verdict.collect) {
      await onCollected(pHash, verdict)
      await this.release(pHash, token, 'collected')
      return 'collected'
    }
    await this.release(pHash, token, 'rejected', verdict.duplicateOf ? `dupOf ${verdict.duplicateOf}` : undefined)
    return 'rejected'
  }

  /** 超时恢复：卡死的 judging 重置为 pending_review（继承旧插件） */
  async recoverStuck(): Promise<number> {
    const deadline = Date.now() - this.config.review.timeoutMinutes * 60 * 1000
    if (this.config.review.timeoutMinutes <= 0) return 0
    const stuck = await this.ctx.database.get('stickerpro_occurrence', { status: 'judging' })
    let recovered = 0
    for (const row of stuck) {
      if (row.judgeStartedAt && row.judgeStartedAt < deadline) {
        await this.ctx.database.set('stickerpro_occurrence', { pHash: row.pHash }, { status: 'pending_review', judgeToken: '' })
        recovered++
      }
    }
    if (recovered) this.logger.debug(`[judge] 超时恢复 ${recovered} 条 judging`)
    return recovered
  }

  /** 遍历待评审逐条处理（重启后积压 / 定时补跑） */
  async drainPending(onCollected: (pHash: string, verdict: JudgeVerdict) => Promise<void>): Promise<void> {
    const rows = await this.ctx.database.get('stickerpro_occurrence', { status: 'pending_review' })
    for (const row of rows) {
      await this.processPending(row.pHash, onCollected).catch((e) =>
        this.logger.warn(`[judge] 处理 ${row.pHash} 异常：${e instanceof Error ? e.message : String(e)}`),
      )
    }
  }
}
