// 核心库：occurrence 追踪（分段索引去重）/ meta 收藏 / 检索 / 淘汰 / 会话冷却
// 设计 §4、§6、§8。issue #1 三缺陷的处置都落在本文件与 tools.ts：
//   - useCount 永不参与选图排序（只做统计）
//   - 关键词匹配方向反转 + 中文 2-gram（utils.keywordScore）
//   - 会话最近 N 张自动跳过（recent_send 持久化）

import { randomUUID } from 'node:crypto'
import type { Context, Logger } from 'koishi'
import imghash from 'imghash'
import type { Config } from './config'
import type { DeliveryChannel, MetaRow, OccurrenceRow, StickerSource, StickerStatus } from './types'
import { SegmentIndex, keywordScore, phashSegments, tokenize } from './utils'

export interface CollectedCandidate {
  meta: MetaRow
  score: number
  matchMode: 'semantic' | 'keyword'
}

export class StickerLibrary {
  /** 全库 pHash → 段值（occurrence ∪ meta 的并集；汉明合并的权威索引） */
  readonly segIndex = new SegmentIndex()
  private ready = false

  constructor(
    private readonly ctx: Context,
    private readonly config: Config,
    private readonly logger: Logger,
  ) {}

  // ───────── 初始化 ─────────

  /** 启动时把 occurrence 全表载入分段索引（万级 <100ms，设计 §6.5） */
  async load(): Promise<void> {
    const [rows, metas] = await Promise.all([
      this.ctx.database.get('stickerpro_occurrence', {}),
      this.ctx.database.get('stickerpro_meta', {}),
    ])
    for (const r of rows) this.segIndex.add(r.pHash)
    for (const m of metas) if (!this.segIndex.has(m.pHash)) this.segIndex.add(m.pHash)
    this.ready = true
    this.logger?.debug?.(`[library] 分段索引载入：occurrence=${rows.length} meta=${metas.length}`)
  }

  get isReady(): boolean {
    return this.ready
  }

  // ───────── pHash ─────────

  /** 64bit pHash → 16 hex（校验失败返回 null，同旧插件口径） */
  async computePHash(bytes: Buffer): Promise<string | null> {
    try {
      const h = await imghash.hash(bytes, 8)
      const s = String(h).toLowerCase()
      return /^[0-9a-f]{16}$/.test(s) ? s : null
    } catch (e) {
      this.logger.debug(`[library] pHash 计算失败：${e instanceof Error ? e.message : String(e)}`)
      return null
    }
  }

  // ───────── occurrence ─────────

  async getOccurrence(pHash: string): Promise<OccurrenceRow | undefined> {
    const rows = await this.ctx.database.get('stickerpro_occurrence', { pHash })
    return rows[0]
  }

  /**
   * 记录一次出现（汉明合并到 canonical）。
   * 返回：canonical pHash、是否新行、当前行、以及**本次是否到达评审触发点**。
   */
  async recordOccurrence(
    pHash: string,
    meta: { mime: string; ext: string; source: StickerSource; guildId: string },
  ): Promise<{ canonical: string; row: OccurrenceRow; isNew: boolean; reviewDue: boolean }> {
    const canonical = this.segIndex.findNearest(pHash, this.config.collect.phashThreshold) ?? pHash
    const existing = await this.getOccurrence(canonical)
    const now = Date.now()
    if (existing) {
      const wasNew = existing.status === 'new'
      const willTrigger = wasNew && existing.count + 1 >= this.config.collect.threshold
      const nextCount = existing.count + 1
      await this.ctx.database.set(
        'stickerpro_occurrence',
        { pHash: canonical },
        { count: nextCount, lastSeenAt: now, status: wasNew && nextCount >= this.config.collect.threshold ? 'pending_review' : existing.status },
      )
      const row: OccurrenceRow = { ...existing, count: nextCount, lastSeenAt: now, status: willTrigger ? 'pending_review' : existing.status }
      if (willTrigger) this.logger.debug(`[library] ${canonical} 达到阈值（${nextCount}），进入待评审`)
      return { canonical, row, isNew: false, reviewDue: willTrigger }
    }
    const row: OccurrenceRow = {
      pHash: canonical,
      count: 1,
      status: 'new',
      firstSeenAt: now,
      lastSeenAt: now,
      mime: meta.mime,
      ext: meta.ext,
      source: meta.source,
      guildId: meta.guildId,
      judgeError: '',
      judgeStartedAt: 0,
      judgeToken: '',
    }
    if (this.config.collect.threshold <= 1) row.status = 'pending_review'
    try {
      await this.ctx.database.create('stickerpro_occurrence', row)
      this.segIndex.add(canonical)
      return { canonical, row, isNew: true, reviewDue: row.status === 'pending_review' }
    } catch (e) {
      // 并发收集同一张新图：另一个协程已插入 → 退化为累加已有行，别把计数丢了
      const raced = await this.getOccurrence(canonical)
      if (!raced) throw e
      const nextCount = raced.count + 1
      const due = raced.status === 'new' && nextCount >= this.config.collect.threshold
      await this.ctx.database.set(
        'stickerpro_occurrence',
        { pHash: canonical },
        { count: nextCount, lastSeenAt: now, status: due ? 'pending_review' : raced.status },
      )
      if (!this.segIndex.has(canonical)) this.segIndex.add(canonical)
      return {
        canonical,
        row: { ...raced, count: nextCount, lastSeenAt: now, status: due ? 'pending_review' : raced.status },
        isNew: false,
        reviewDue: due,
      }
    }
  }

  /** 评审结束回写状态（judging 行由 judge.ts 管理，这里只处理终态同步） */
  async setOccurrenceStatus(pHash: string, status: StickerStatus, extra?: Partial<OccurrenceRow>): Promise<void> {
    const terminal = status === 'collected' || status === 'rejected' || status === 'judge_failed'
    await this.ctx.database.set('stickerpro_occurrence', { pHash }, {
      status,
      // 终态必须把 CAS 令牌清干净：否则 commit 之后的 release() 条件更新会 no-op，行里永远留着一个旧 token
      ...(terminal ? { judgeToken: '', judgeStartedAt: 0 } : {}),
      ...extra,
    } as any)
  }

  /** TTL 清理：未收藏且久未再出现的记录 + 本地文件（$in 500 分批，继承旧插件正确姿势） */
  async pruneStaleOccurrences(onPurge?: (pHash: string) => Promise<void> | void): Promise<number> {
    const deadline = Date.now() - this.config.collect.ttlDays * 24 * 60 * 60 * 1000
    if (this.config.collect.ttlDays <= 0) return 0
    const stale = await this.ctx.database.get('stickerpro_occurrence', {
      status: { $ne: 'collected' },
      lastSeenAt: { $lt: deadline },
    })
    let removed = 0
    for (let i = 0; i < stale.length; i += 500) {
      const batch = stale.slice(i, i + 500)
      await this.ctx.database.remove('stickerpro_occurrence', { pHash: { $in: batch.map((r) => r.pHash) } })
      for (const row of batch) {
        // 行删了索引不删会留脏指针（resolveRef 前缀匹配/去重命中都会指向空记录）
        this.segIndex.remove(row.pHash)
        if (onPurge) {
          try {
            await onPurge(row.pHash)
          } catch (e) {
            this.logger.debug(`[library] 清理 ${row.pHash} 文件失败（忽略）：${e instanceof Error ? e.message : String(e)}`)
          }
        }
      }
      removed += batch.length
    }
    return removed
  }

  // ───────── meta（收藏库）─────────

  async getMeta(pHash: string): Promise<MetaRow | undefined> {
    const rows = await this.ctx.database.get('stickerpro_meta', { pHash })
    return rows[0]
  }

  async listMeta(): Promise<MetaRow[]> {
    return this.ctx.database.get('stickerpro_meta', {})
  }

  async upsertMeta(pHash: string, patch: Partial<MetaRow>): Promise<void> {
    const existing = await this.getMeta(pHash)
    if (existing) {
      await this.ctx.database.set('stickerpro_meta', { pHash }, patch as any)
      return
    }
    const now = Date.now()
    await this.ctx.database.create('stickerpro_meta', {
      pHash,
      tags: [],
      description: '',
      usageHint: '',
      note: '',
      source: 'passive',
      useCount: 0,
      lastUsedAt: 0,
      collectedAt: now,
      descModel: '',
      ...patch,
    } as MetaRow)
    if (!this.segIndex.has(pHash)) this.segIndex.add(pHash)
  }

  /**
   * 手动导入（免评审）后的状态登记：
   * occurrence 直接标 collected，避免这张图之后被群友再发时又走一遍阈值评审；
   * 没有 occurrence 行就补一条（source=manual，计数从 1 起）。
   */
  async registerCollected(pHash: string, mime: string, ext: string): Promise<void> {
    const existing = await this.getOccurrence(pHash)
    if (existing) {
      if (existing.status !== 'collected') await this.setOccurrenceStatus(pHash, 'collected')
      return
    }
    const now = Date.now()
    try {
      await this.ctx.database.create('stickerpro_occurrence', {
        pHash,
        count: 1,
        status: 'collected',
        firstSeenAt: now,
        lastSeenAt: now,
        mime,
        ext,
        source: 'manual',
        guildId: '',
        judgeError: '',
        judgeStartedAt: 0,
        judgeToken: '',
      } as OccurrenceRow)
    } catch {
      // 并发下已被别的协程插入：忽略即可
    }
    if (!this.segIndex.has(pHash)) this.segIndex.add(pHash)
  }

  /** 收藏删除的统一出口：meta + occurrence + 文件 +（由 caller 删向量） */
  async deleteSticker(pHash: string, removeOccurrence = true): Promise<void> {
    await this.ctx.database.remove('stickerpro_meta', { pHash })
    if (removeOccurrence) {
      await this.ctx.database.remove('stickerpro_occurrence', { pHash })
      // 仅当 occurrence 行也删掉时才从去重索引摘除，否则索引与库仍应对得上
      this.segIndex.remove(pHash)
    }
  }

  async countMeta(): Promise<number> {
    const metas = await this.ctx.database.get('stickerpro_meta', {})
    return metas.length
  }

  /**
   * 超限淘汰（设计 §6.6）：按页扫描 + 内存里只保留"最该淘汰的 overflow 条"，不再整表拉取；
   * LRU 键 lastUsedAt || collectedAt —— 刚收藏还没用过的不会被立刻挤掉（继承旧版兜底）。
   */
  async enforceLibraryLimit(onPurge?: (pHash: string) => Promise<void> | void): Promise<number> {
    const total = await this.countMeta()
    const overflow = total - this.config.library.maxImages
    if (overflow <= 0) return 0

    const victims: { pHash: string; lru: number }[] = []
    const pageSize = 200
    for (let offset = 0; ; offset += pageSize) {
      const page = await this.ctx.database.get('stickerpro_meta', {}, { limit: pageSize, offset })
      if (!page.length) break
      for (const m of page) {
        const lru = m.lastUsedAt || m.collectedAt || 0
        const worst = victims[victims.length - 1]
        if (victims.length < overflow) {
          victims.push({ pHash: m.pHash, lru })
          victims.sort((a, b) => a.lru - b.lru)
        } else if (worst && lru < worst.lru) {
          victims[victims.length - 1] = { pHash: m.pHash, lru }
          victims.sort((a, b) => a.lru - b.lru)
        }
      }
      if (page.length < pageSize) break
    }

    let evicted = 0
    for (const victim of victims) {
      // 连同 occurrence 一起去掉：只删 meta 会让这张图永远无法再次被收集（status 仍是 collected）
      await this.deleteSticker(victim.pHash, true)
      await this.ctx.database.remove('stickerpro_vector', { pHash: victim.pHash }).catch(() => {})
      if (onPurge) {
        try {
          await onPurge(victim.pHash)
        } catch (e) {
          this.logger.debug(`[library] 淘汰 ${victim.pHash} 时删文件失败（忽略）：${e instanceof Error ? e.message : String(e)}`)
        }
      }
      evicted++
      this.logger.debug(`[library] LRU 淘汰 ${victim.pHash}（lru=${new Date(victim.lru || 0).toISOString()}）`)
    }
    return evicted
  }

  // ───────── 选图（issue #1 根治，设计 §8）─────────

  /**
   * 关键词候选：全库排除会话冷却集合 → 2-gram 打分（tag×3 文本×1）→ 同分随机洗牌。
   * ⚠️ 不使用 useCount 参与排序——这是旧版"永远同一张"的根因。
   */
  async searchByKeyword(
    query: string,
    opts: { limit?: number; exclude?: Set<string>; tags?: string[] } = {},
  ): Promise<CollectedCandidate[]> {
    const tokens = tokenize(query)
    const wantedTags = (opts.tags ?? []).map((t) => String(t).trim().toLowerCase()).filter(Boolean)
    const metas = await this.listMeta()
    const scored = metas
      .filter((m) => !opts.exclude?.has(m.pHash))
      .filter((m) => {
        if (!wantedTags.length) return true
        const hay = (m.tags || []).join(' ').toLowerCase()
        return wantedTags.some((tag) => hay.includes(tag))
      })
      .map((m) => ({
        meta: m,
        score: tokens.length ? keywordScore(tokens, m.tags || [], m.description, m.usageHint) : 0,
        matchMode: 'keyword' as const,
      }))
      .filter((x) => x.score > 0)
    // 同分随机（洗牌后稳定排序）：彻底打散"第一名恒定"的可能
    shuffledSortByScore(scored)
    return scored.slice(0, opts.limit ?? 10)
  }

  // ───────── markUsed ─────────

  async markUsed(pHash: string): Promise<void> {
    const meta = await this.getMeta(pHash)
    if (!meta) return
    await this.ctx.database.set(
      'stickerpro_meta',
      { pHash },
      { useCount: (meta.useCount || 0) + 1, lastUsedAt: Date.now() },
    )
  }

  // ───────── 会话发送冷却（issue #1 建议 3）─────────

  /** 最近 N 张已发 pHash（默认 3；跨重启持久化） */
  async recentSent(conversationKey: string): Promise<string[]> {
    if (this.config.sending.cooldown <= 0) return []
    const rows = await this.ctx.database.get('stickerpro_recent_send', { conversationKey })
    return rows
      .sort((a, b) => b.at - a.at)
      .slice(0, this.config.sending.cooldown)
      .map((r) => r.pHash)
  }

  async recordSent(conversationKey: string, pHash: string, channel: DeliveryChannel): Promise<void> {
    if (this.config.sending.cooldown <= 0) return
    await this.ctx.database.create('stickerpro_recent_send', {
      id: randomUUID(),
      conversationKey,
      pHash,
      at: Date.now(),
    } as any)
    // 修剪：只保留该会话最近 10 条
    const rows = await this.ctx.database.get('stickerpro_recent_send', { conversationKey })
    if (rows.length > 10) {
      const keep = new Set(
        rows
          .sort((a, b) => b.at - a.at)
          .slice(0, 10)
          .map((r) => r.id),
      )
      for (const r of rows) if (!keep.has(r.id)) await this.ctx.database.remove('stickerpro_recent_send', { id: r.id })
    }
    this.logger.debug(`[library] 发送记录 ${conversationKey} ← ${pHash}（通道 ${channel}）`)
  }

  /** 全量清理冷却（超过 30 天的记录），随定时任务跑 */
  async pruneRecentSends(): Promise<number> {
    const deadline = Date.now() - 30 * 24 * 60 * 60 * 1000
    const old = await this.ctx.database.get('stickerpro_recent_send', { at: { $lt: deadline } })
    for (let i = 0; i < old.length; i += 500) {
      const batch = old.slice(i, i + 500)
      await this.ctx.database.remove('stickerpro_recent_send', { id: { $in: batch.map((r) => r.id) } })
    }
    return old.length
  }

  // ───────── ref 寻址（设计 §5.1：r# / pHash 前缀）─────────

  /** 把 ref/pHash 前缀解析成完整 pHash：先查会话候选表，再按库前缀唯一匹配 */
  async resolveRef(ref: string, sessionRefs: Map<string, string>): Promise<string | null> {
    if (!ref) return null
    const key = ref.trim().toLowerCase()
    if (sessionRefs.has(key)) return sessionRefs.get(key)!
    const byPrefix = /^[0-9a-f]{4,16}$/.test(key)
      ? [...this.segIndex.all()].map(([p]) => p).filter((p) => p.startsWith(key))
      : []
    return byPrefix.length === 1 ? byPrefix[0] : null
  }

  /** 校验段数工具（judge/调试用） */
  static segmentsOf(pHash: string): number[] {
    return phashSegments(pHash)
  }
}

/** 同分随机洗牌 + 分数降序稳定排序 */
function shuffledSortByScore<T extends { score: number }>(arr: T[]): void {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]]
  }
  arr.sort((a, b) => b.score - a.score)
}
