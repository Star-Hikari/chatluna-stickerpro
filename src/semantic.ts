// 语义索引（设计 §3.2）：自研内存余弦，不依赖 luna-vdb —— 千级向量全载内存 <6MB，
// 暴力点积 <1ms；换来零 WASM 并发冲突（不需要 isolate-loader）、按行持久化、换模型增量重算。

import type { Context, Logger } from 'koishi'
import type { Embeddings } from '@langchain/core/embeddings'
// 触发 chatluna 的服务类型增强（ctx.chatluna）；type-only
import type { ChatLunaService } from 'koishi-plugin-chatluna/services/chat'
import type { Config } from './config'
import type { StickerLibrary } from './library'
import { Semaphore, decodeVector, dot, encodeVector, isTransientNetworkError, l2normalize, sleep } from './utils'

/** 档案文本：description + usageHint + tags（同旧插件口径，换模型时重算依据） */
export function profileText(m: { description: string; usageHint: string; tags: string[] }): string {
  return [m.description || '', m.usageHint || '', (m.tags || []).join(' ')].join(' ').trim()
}

export interface SemanticHit {
  pHash: string
  score: number
}

export class SemanticIndex {
  private vectors = new Map<string, Float32Array>()
  /** createEmbeddings 返回 ComputedRef：存 ref 现读 value，模型晚就绪也能自动生效 */
  private embeddingsRef: { value: Embeddings | undefined } | null = null
  private activeModel = ''
  private sem: Semaphore
  /** 已完成一次成功初始化（载入向量 + 触发 backfill） */
  private started = false
  private starting = false

  constructor(
    private readonly ctx: Context,
    private readonly config: Config,
    private readonly library: StickerLibrary,
    private readonly logger: Logger,
  ) {
    this.sem = new Semaphore(Math.max(1, config.semantic.concurrency))
  }

  private get embeddings(): Embeddings | undefined {
    return this.embeddingsRef?.value
  }

  get ready(): boolean {
    return this.config.semantic.enabled && !!this.embeddings && this.vectors.size > 0
  }

  get stats(): { loaded: number; model: string; pending: number } {
    return { loaded: this.vectors.size, model: this.activeModel || '(none)', pending: this.sem.pending }
  }

  /**
   * 初始化：建 embeddings → 载入与当前模型匹配的向量行 → 缺的补算。
   * 幂等且可重试：模型尚未注册时不做"已启动"标记，后续 model-added 事件/手动调用还能再来一次。
   */
  async start(): Promise<void> {
    if (this.started || this.starting) return
    if (!this.config.semantic.enabled || !this.config.semantic.model || this.config.semantic.model === '无') {
      this.started = true
      this.logger.debug('[semantic] 语义检索未启用（开关关闭或模型为"无"），全部走关键词')
      return
    }
    this.starting = true
    try {
      this.embeddingsRef = await this.ctx.chatluna.createEmbeddings(this.config.semantic.model)
      if (!this.embeddings) {
        this.logger.warn(`[semantic] embeddings ${this.config.semantic.model} 暂不可用（等待 chatluna/model-added）`)
        return
      }
      this.activeModel = this.config.semantic.model

      const rows = await this.ctx.database.get('stickerpro_vector', { embeddingModel: this.activeModel })
      let loaded = 0
      for (const r of rows) {
        const v = decodeVector(r.data)
        if (v && v.length === r.dim) {
          this.vectors.set(r.pHash, v)
          loaded++
        }
      }
      this.started = true
      this.logger.debug(`[semantic] 载入向量 ${loaded} 条（model=${this.activeModel}）`)

      // 缺向量的收藏行后台补算
      void this.backfill().catch((e) =>
        this.logger.warn(`[semantic] backfill 异常：${e instanceof Error ? e.message : String(e)}`),
      )
    } catch (e) {
      this.logger.warn(`[semantic] embeddings 初始化失败：${e instanceof Error ? e.message : String(e)}`)
    } finally {
      this.starting = false
    }
  }

  /** 为所有缺向量的 meta 行生成 embedding（锁外并发生成、串行落盘） */
  async backfill(): Promise<number> {
    if (!this.embeddings) return 0
    const metas = await this.library.listMeta()
    const missing = metas.filter((m) => !this.vectors.has(m.pHash))
    if (!missing.length) return 0
    this.logger.debug(`[semantic] backfill ${missing.length} 条缺失向量`)
    let done = 0
    const batchSize = Math.max(2 * this.config.semantic.concurrency, 10)
    for (let i = 0; i < missing.length; i += batchSize) {
      const batch = missing.slice(i, i + batchSize)
      await Promise.all(
        batch.map(async (m) => {
          try {
            const v = await this.embedText(profileText(m))
            if (v) {
              await this.store(m.pHash, v)
              done++
            }
          } catch (e) {
            this.logger.debug(`[semantic] backfill ${m.pHash} 失败：${e instanceof Error ? e.message : String(e)}`)
          }
        }),
      )
    }
    this.logger.debug(`[semantic] backfill 完成 ${done}/${missing.length}`)
    return done
  }

  /** 向量生成：并发闸门 + 20ms 间隔（undici keep-alive FIN 竞态规避，继承旧插件实测）+ 瞬时错误退避 */
  private async embedText(text: string): Promise<Float32Array | null> {
    const embeddings = this.embeddings
    if (!embeddings || !text) return null
    return this.sem.run(async () => {
      await sleep(20)
      for (let attempt = 0; attempt <= 3; attempt++) {
        try {
          const raw = await embeddings.embedQuery(text)
          return l2normalize(raw)
        } catch (e) {
          if (!isTransientNetworkError(e) || attempt === 3) {
            this.logger.debug(`[semantic] embed 失败（非瞬时或已达上限）：${e instanceof Error ? e.message : String(e)}`)
            return null
          }
          await sleep(20 * (attempt + 1))
        }
      }
      return null
    })
  }

  private async store(pHash: string, v: Float32Array): Promise<void> {
    this.vectors.set(pHash, v)
    const row = {
      pHash,
      embeddingModel: this.activeModel,
      dim: v.length,
      data: encodeVector(v),
      updatedAt: Date.now(),
    }
    const existing = await this.ctx.database.get('stickerpro_vector', { pHash })
    if (existing.length) await this.ctx.database.set('stickerpro_vector', { pHash }, row as any)
    else await this.ctx.database.create('stickerpro_vector', row as any)
  }

  /** 收藏/更新档案时调用：重算该条向量 */
  async upsert(pHash: string, profile: { description: string; usageHint: string; tags: string[] }): Promise<boolean> {
    if (!this.embeddings) return false
    const v = await this.embedText(profileText(profile))
    if (!v) return false
    await this.store(pHash, v)
    return true
  }

  async remove(pHash: string): Promise<void> {
    this.vectors.delete(pHash)
    await this.ctx.database.remove('stickerpro_vector', { pHash })
  }

  /** 全量重建（换模型 / 手动 rebuild-index） */
  async rebuild(): Promise<number> {
    if (!this.embeddings) await this.start()
    if (!this.embeddings) {
      // 模型不可用就清库等于自毁索引，直接放弃（原实现会先清空再返回 0）
      this.logger.warn('[semantic] embeddings 不可用，已放弃重建（向量库保持不变）')
      return 0
    }
    this.vectors.clear()
    await this.ctx.database.remove('stickerpro_vector', {})
    return this.backfill()
  }

  /** 语义检索：query 向量与各行的点积（两侧均归一化 → 即余弦） */
  async search(query: string, limit: number, minScore: number): Promise<SemanticHit[] | null> {
    if (!this.embeddings || !this.vectors.size) return null
    const qv = await this.embedText(query)
    if (!qv) return null
    const hits: SemanticHit[] = []
    for (const [pHash, v] of this.vectors) {
      if (v.length !== qv.length) continue
      const score = dot(qv, v)
      if (score >= minScore) hits.push({ pHash, score })
    }
    hits.sort((a, b) => b.score - a.score)
    return hits.slice(0, limit)
  }

  /** 主模型/embedding 就绪情况（status 命令用） */
  describeState(): string {
    if (!this.config.semantic.enabled) return '语义检索：开关关闭'
    if (!this.embeddings) return '语义检索：embedding 模型未就绪（走关键词）'
    return `语义检索：model=${this.activeModel} vectors=${this.vectors.size}`
  }
}
