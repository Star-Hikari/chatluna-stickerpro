// 被动收集管道（设计 §6）：middleware 旁路（绝不 await 下载）+ 三类图片来源解析
// 覆盖旧插件收不到的场景：face children、quote/reply 嵌套图（设计附录 B）

import type { Context, Logger, Session } from 'koishi'
import { commitCollected } from './commit'
import type { ToolsDeps } from './commit'
import type { Config } from './config'
import type { Judge, JudgeVerdict } from './judge'
import type { StickerLibrary } from './library'
import type { SemanticIndex } from './semantic'
import type { Storage } from './storage'
import {
  CHATLUNA_STORAGE_PREFIX,
  fetchImageBytes,
  imageExtension,
  isLikelyImageUrl,
  looksLikeNonImage,
  Semaphore,
  sniffImageMime,
} from './utils'
import { rememberImages } from './recent'

/** 从消息元素树里收集所有图片来源 URL（顶层 img / face children / 递归一层 quote） */
export function extractImageSources(elements: readonly any[]): string[] {
  const out: string[] = []
  const seen = new Set<string>()
  const push = (u: unknown) => {
    if (typeof u === 'string' && u && !seen.has(u)) {
      seen.add(u)
      out.push(u)
    }
  }
  const walk = (els: readonly any[], depth: number) => {
    if (depth > 2 || !Array.isArray(els)) return
    for (const el of els) {
      if (!el || typeof el !== 'object') continue
      if (el.type === 'img' || el.type === 'image') {
        push(el.attrs?.src || el.attrs?.url || el.attrs?.file)
      } else if (el.type === 'file') {
        // chatluna-storage 会把附件转成 file 元素（src/url 指向本机临时图床）
        const src = el.attrs?.src || el.attrs?.url
        if (isLikelyImageUrl(src)) push(src)
      } else if (el.type === 'face') {
        // onebot 适配把渲染图挂在 face 的 children 里（adapter-onebot/index.js:314-319）
        for (const child of el.children ?? []) {
          if (child?.type === 'img' || child?.type === 'image') {
            push(child.attrs?.src || child.attrs?.url || child.attrs?.file)
          }
        }
      }
      walk(el.children ?? [], depth + 1)
    }
  }
  walk(elements, 0)
  return out
}

/** 当前消息 + 引用消息里的全部图片来源 */
export function collectImageSources(session: Session): string[] {
  const urls = extractImageSources(session.elements as readonly any[])
  // 引用消息：Satori 的 session.quote 是 event.message.quote 的访问器；
  // 这里同时兼容直接挂在 message 上的老结构（元素藏在 quote.elements/quote.message.elements）。
  const s: any = session
  const quote: any = s.quote ?? s.message?.quote ?? s.event?.message?.quote
  if (quote) {
    const qEls = Array.isArray(quote.elements) ? quote.elements : Array.isArray(quote.message?.elements) ? quote.message.elements : undefined
    if (qEls) for (const u of extractImageSources(qEls)) urls.push(u)
  }
  return urls
}

export interface CollectorDeps {
  ctx: Context
  config: Config
  library: StickerLibrary
  storage: Storage
  judge: Judge
  semantic: SemanticIndex
  logger: Logger
}

export class Collector {
  /** 收集侧并发闸门：群消息可以很密集，下载/pHash 不能无上限地并发 */
  private readonly sem = new Semaphore(4, 500)

  constructor(private readonly deps: CollectorDeps) {}

  /**
   * 装配收集入口（设计 §6.1 的"绝不阻塞消息管线"）。
   *
   * 这里用 `message` 事件而不是 middleware：收集器只观察、不参与应答，
   * 事件能看到被其它插件（chatluna 回复、命令处理）消费掉的消息；
   * middleware 会被前面不调用 next() 的插件截断，导致这些消息里的图收不到。
   */
  attach(): void {
    const { ctx, config, logger } = this.deps
    ctx.on('message', (session: Session) => {
      // 先记下这个会话最近收到的图（不受收集白名单限制）：
      // sticker_save(latest) 需要回溯"最近一条含图消息"，而工具运行时当前消息往往只有文字。
      const topLevel = extractImageSources(session.elements as readonly any[])
      if (topLevel.length) rememberImages(session, topLevel)
      if (!config.collect.enabled || !this.groupAllowed(session)) return
      setImmediate(() => {
        void this.sem
          .run(() => this.process(session))
          .catch((e) => logger.warn(`[collector] 处理异常：${e instanceof Error ? e.message : String(e)}`))
      })
    })
  }

  groupAllowed(session: Session): boolean {
    if (!session.guildId) return false
    if (session.userId && session.userId === session.selfId) return false
    return this.deps.config.collect.groups.includes(session.guildId)
  }

  /** 单条消息的完整收集流程（异步执行，不阻塞消息管线） */
  async process(session: Session): Promise<void> {
    const { config, library, storage, logger } = this.deps
    if (!library.isReady) return
    const urls = collectImageSources(session)
    if (!urls.length) return
    for (const url of urls) {
      const bytes = await this.fetchBytes(url)
      if (!bytes) continue
      const mime = sniffImageMime(bytes)
      if (!mime) {
        logger.debug('[collector] 魔数不是图片，跳过（可能是错误页/鉴权页）')
        continue
      }
      const ext = imageExtension(mime)
      const pHash = await library.computePHash(bytes)
      if (!pHash) continue
      const { canonical, isNew, reviewDue } = await library.recordOccurrence(pHash, {
        mime,
        ext,
        source: 'passive',
        guildId: session.guildId ?? '',
      })
      // 只有需要评审/新图才落盘（被拒图再现不重复写文件，继承旧版语义）
      if (isNew || reviewDue) {
        await storage.saveImage(canonical, bytes)
      }
      logger.debug(`[collector] ${canonical.slice(0, 8)} count+1${reviewDue ? '（达到阈值，进入待评审）' : ''}`)
      if (reviewDue) await this.triggerReview(canonical)
    }
  }

  /** 触发一次评审（fire-and-forget；模型调用可能较慢，不占用消息处理） */
  async triggerReview(pHash: string): Promise<void> {
    const { judge, logger } = this.deps
    const onCollected = async (ph: string, verdict: JudgeVerdict) =>
      commitCollected(this.toolsDeps, ph, verdict, 'passive')
    await judge.processPending(pHash, onCollected).catch((e) =>
      logger.warn(`[judge] ${pHash} 评审异常：${e instanceof Error ? e.message : String(e)}`),
    )
  }

  /** 给 tools.commitCollected 用的依赖包 */
  get toolsDeps(): ToolsDeps {
    const { ctx, config, library, storage, judge, semantic, logger } = this.deps
    return { ctx, config, library, storage, judge, semantic, collector: this, logger }
  }

  private async fetchBytes(url: string): Promise<Buffer | null> {
    const { ctx, config, logger } = this.deps
    const max = config.collect.maxDownloadKb * 1024
    const bytes = await fetchImageBytes(url, ctx.http as any, max, {
      allowedFileRoots: [config.storage.dir],
      allowLoopbackPrefixes: [CHATLUNA_STORAGE_PREFIX],
      onReject: (reason) => logger.debug(`[collector] 取图被拒（${url.slice(0, 100)}）：${reason}`),
    })
    if (!bytes || !bytes.length) return null
    if (looksLikeNonImage(bytes)) {
      logger.debug(`[collector] 取回的不是图片内容（错误页/鉴权页），跳过`)
      return null
    }
    return bytes
  }
}
