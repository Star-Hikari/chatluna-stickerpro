// 模型侧四工具（设计 §5、§5.5）。文案规范 r2：全部第一人称感知式，
// 参照 envsense（tools-group.ts 的 description 数组 + PERCEPTION_NOTE）与 livingmemory 写法。
// 关键通路：peek 返回 [image_url(dataURI), text] 多模态数组，经 chatluna coerceToAgentObservation
// 原样透传给模型（agent/index.mjs:311-332，envsense 实机验证）。

import type { Session } from 'koishi'
import { tool } from '@langchain/core/tools'
import { z } from 'zod'
import { ModelCapabilities } from 'koishi-plugin-chatluna/llm-core/platform/types'
import type { ChatLunaTool } from 'koishi-plugin-chatluna/llm-core/platform/types'
// 触发 chatluna 的服务类型增强（ctx.chatluna）；type-only
import type { ChatLunaService } from 'koishi-plugin-chatluna/services/chat'
import { extractImageSources } from './collector'
import { commitCollected } from './commit'
import type { ToolsDeps } from './commit'
import { deliverSticker } from './delivery'
import { compressForPeek } from './image'
import { forgetImages, recentImages } from './recent'
import {
  OBSERVATION_HINTS,
  PERCEPTION_NOTE,
  TOOL_MODEL_DESCRIPTIONS,
  TOOL_REGISTRY_DESCRIPTIONS,
} from './prompt'
import { CHATLUNA_STORAGE_PREFIX, fetchImageBytes, sniffImageMime } from './utils'

export type { ToolsDeps } from './commit'

/** 会话级内存表的容量上限（进程内缓存，超了淘汰最久未用的会话） */
const MAX_CONVERSATIONS = 200

/** Map 版 LRU：命中时重新插入刷新顺序，超限淘汰最早插入的键 */
function touch<K, V>(map: Map<K, V>, key: K, value: V): V {
  map.delete(key)
  map.set(key, value)
  while (map.size > MAX_CONVERSATIONS) {
    const oldest = map.keys().next().value as K | undefined
    if (oldest === undefined) break
    map.delete(oldest)
  }
  return value
}

/** 会话级 ref 表（r1 → pHash；进程内即可，丢了重新 search 就是） */
const refStore = new Map<string, Map<string, string>>()
/** 会话级"刚锁定的那张"（search 的首选 / peek 最后看过 / save 刚收的），供无参 send 使用 */
const lockedStore = new Map<string, string>()
/** 每日内联预算计数（conversationKey+day → KB） */
const inlineBudgetToday = new Map<string, number>()

function conversationKey(session: Session, agentContext?: any): string {
  if (agentContext?.conversationId) return String(agentContext.conversationId)
  return `${session.platform}:${session.guildId || session.channelId || ''}:${session.userId || ''}`
}

/** 主模型是否支持图片输入：true/false/undefined（无法判定按乐观放行，同 envsense） */
function modelImageSupport(runConfig?: any): boolean | undefined {
  const caps: any[] | undefined = runConfig?.configurable?.model?.modelInfo?.capabilities
  if (!Array.isArray(caps)) return undefined
  return caps.includes(ModelCapabilities.ImageInput)
}

function toolMeta(tags: string[]): NonNullable<ChatLunaTool['meta']> {
  return {
    source: 'extension',
    group: 'chatluna-stickerpro',
    tags: ['stickerpro', ...tags],
    defaultAvailability: {
      enabled: true,
      main: true,
      subAgent: false,
      chatluna: true,
      characterScope: 'all',
    },
  }
}

function register(name: string, def: ChatLunaTool, deps: ToolsDeps) {
  // 同名守卫（envsense 同款教训：chatluna 按名字覆盖注册）
  const existing = deps.ctx.chatluna.platform.getTool(name)
  if (existing && existing.description && !existing.description.includes('表情')) {
    deps.logger.warn(`[tools] ${name} 疑似已被其他插件注册，本次注册将覆盖它`)
  }
  deps.ctx.effect(() => deps.ctx.chatluna.platform.registerTool(name, def))
}

/** 选图主流程（search 打分 + 会话冷却排除；issue #1 的根治路径） */
async function pickCandidates(
  deps: ToolsDeps,
  query: string,
  limit: number,
  convKey: string,
  tags?: string[],
): Promise<{ candidates: { pHash: string; score: number; matchMode: 'semantic' | 'keyword' }[]; mode: string }> {
  const { config, library, semantic, logger } = deps
  const exclude = new Set(await library.recentSent(convKey))

  if (config.semantic.enabled && semantic.ready) {
    const hits = await semantic.search(query, limit + exclude.size, config.semantic.minSimilarity)
    if (hits && hits.length) {
      const kept = await filterByTags(deps, hits.filter((h) => !exclude.has(h.pHash)).map((h) => h.pHash), tags)
      const filtered = kept.slice(0, limit)
      if (filtered.length) {
        const scoreOf = new Map(hits.map((h) => [h.pHash, h.score]))
        return {
          candidates: filtered.map((ph) => ({
            pHash: ph,
            score: scoreOf.get(ph) ?? 0,
            matchMode: 'semantic' as const,
          })),
          mode: `语义匹配（最高余弦 ${hits[0].score.toFixed(3)}）`,
        }
      }
    }
    logger.debug('[tools] 语义无命中/低于阈值，回退关键词')
  }
  const kw = await library.searchByKeyword(query, { limit: limit + exclude.size, exclude, tags })
  return {
    candidates: kw.slice(0, limit).map((c) => ({ pHash: c.meta.pHash, score: c.score, matchMode: 'keyword' as const })),
    mode: kw.length ? '关键词匹配' : '（无命中，随机兜底）',
  }
}

/** 按标签过滤 pHash 列表（任一标签命中即可）；tags 为空时原样返回 */
async function filterByTags(deps: ToolsDeps, pHashes: string[], tags?: string[]): Promise<string[]> {
  const wanted = (tags ?? []).map((t) => String(t).trim().toLowerCase()).filter(Boolean)
  if (!wanted.length) return pHashes
  const metas = await deps.library.listMeta()
  const byHash = new Map(metas.map((m) => [m.pHash, m]))
  return pHashes.filter((ph) => {
    const m = byHash.get(ph)
    if (!m) return false
    const hay = (m.tags || []).join(' ').toLowerCase()
    return wanted.some((t) => hay.includes(t))
  })
}

/** Fisher-Yates 洗牌（避免 sort(random) 的有偏分布） */
function shuffle<T>(arr: T[]): T[] {
  const out = [...arr]
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1))
    ;[out[i], out[j]] = [out[j], out[i]]
  }
  return out
}

/** 兜底：无任何命中时从全库随机取（排除冷却集），绝不"永远同一张" */
async function fallbackRandom(deps: ToolsDeps, exclude: Set<string>, limit: number) {
  const metas = await deps.library.listMeta()
  const pool = metas.filter((m) => !exclude.has(m.pHash))
  const pick = pool.length ? pool : metas
  return shuffle(pick)
    .slice(0, limit)
    .map((m) => ({ pHash: m.pHash, score: 0, matchMode: 'keyword' as const }))
}

// ───────────────────────── 装配 ─────────────────────────

export function registerTools(deps: ToolsDeps): void {
  const { config, library, storage, judge, semantic } = deps

  // ── sticker_search ──
  register('sticker_search', {
    description: TOOL_REGISTRY_DESCRIPTIONS.search,
    selector: () => true,
    meta: toolMeta(['search']),
    createTool: () =>
      tool(
        async (input: { query: string; limit?: number; tags?: string[] }, runConfig: any) => {
          const session: Session | undefined = runConfig?.configurable?.session
          if (!session) return '现在没在任何一个聊天里，先别翻表情了。'
          const convKey = conversationKey(session, runConfig?.configurable?.agentContext)
          const limit = Math.min(Math.max(1, input.limit ?? 8), 20)
          const { candidates, mode } = await pickCandidates(deps, input.query, limit, convKey, input.tags)
          const list = candidates.length
            ? candidates
            : await fallbackRandom(deps, new Set(await library.recentSent(convKey)), limit)
          if (!list.length) return '我的表情包里还是空的，先用文字回复吧。'

          const refs = touch(refStore, convKey, refStore.get(convKey) ?? new Map<string, string>())
          refs.clear() // 本轮候选整体替换，避免旧编号串台
          const lines: string[] = []
          for (let i = 0; i < list.length; i++) {
            const ref = `r${i + 1}`
            refs.set(ref, list[i].pHash)
            const meta = await library.getMeta(list[i].pHash)
            const tagText = (meta?.tags || []).join('/')
            const info = await storage.statImage(list[i].pHash)
            const kb = info ? Math.max(1, Math.round(info.size / 1024)) : 0
            lines.push(
              `- ${ref}｜${list[i].pHash.slice(0, 8)}｜${meta?.description || '(没写描述)'}｜tag：${tagText || '无'}｜${kb}KB｜来源：${meta?.source || '未知'}`,
            )
          }
          if (list.length) touch(lockedStore, convKey, list[0].pHash)
          return (
            `我翻到了这些表情（${mode}，共 ${lines.length} 个候选）：\n` +
            lines.join('\n') +
            `\n想确认哪张合适就说编号（比如 r2）"看一眼"，看中了再发出去。刚在这个会话发过的我已经自动跳过了。`
          )
        },
        {
          name: 'sticker_search',
          description: TOOL_MODEL_DESCRIPTIONS.search,
          schema: z.object({
            query: z.string().describe('想要的情绪/场景关键词，如"嘲笑""开心""无语""点赞"'),
            limit: z.number().int().min(1).max(20).optional().describe('最多列几个候选，默认 8'),
            tags: z.array(z.string()).optional().describe('按标签收窄（如 ["无语","猫"]），任一命中即可'),
          }),
        },
      ),
  } as ChatLunaTool, deps)

  /**
   * peek 的目标解析：r#/pHash 前缀，或特殊词 latest（库里最新收的那张）/ reply（被引用消息里那张）。
   * reply 走"下载 → pHash → 库内归并查找"，没入库就如实告诉模型，别假装看到。
   */
  async function resolvePeekTarget(
    raw: string,
    session: Session,
    refs: Map<string, string>,
  ): Promise<{ pHash?: string; error?: string }> {
    const token = String(raw ?? '').trim().toLowerCase()

    if (token === 'latest') {
      const metas = await library.listMeta()
      if (!metas.length) return { error: '库里还是空的，没有最新的可看' }
      const latest = metas.reduce((a, b) => ((b.collectedAt || 0) > (a.collectedAt || 0) ? b : a))
      return { pHash: latest.pHash }
    }

    if (token === 'reply') {
      const quote: any = (session as any).message?.quote
      const qEls = Array.isArray(quote?.elements) ? quote.elements : quote?.message?.elements
      if (!qEls) return { error: '这条消息没有引用内容' }
      const urls = extractImageSources(qEls)
      const url = urls[urls.length - 1]
      if (!url) return { error: '引用里没有图片' }
      const bytes = await fetchImageBytes(url, deps.ctx.http as any, config.collect.maxDownloadKb * 1024, {
        allowedFileRoots: [config.storage.dir],
        allowLoopbackPrefixes: [CHATLUNA_STORAGE_PREFIX],
      })
      if (!bytes) return { error: '引用那张图取不回来' }
      const ph = await library.computePHash(bytes)
      if (!ph) return { error: '引用那张图算不出特征' }
      const canonical = library.segIndex.findNearest(ph, config.collect.phashThreshold) ?? ph
      if (!(await library.getMeta(canonical))) {
        return { error: '引用那张还没进库（可以让 sticker_save 收进来）' }
      }
      return { pHash: canonical }
    }

    const pHash = await library.resolveRef(raw, refs)
    return pHash ? { pHash } : { error: '我没找到这张，可能编号过期了，先再翻一次库' }
  }

  // ── sticker_peek ──
  register('sticker_peek', {
    description: TOOL_REGISTRY_DESCRIPTIONS.peek,
    selector: () => true,
    meta: toolMeta(['peek', 'vision']),
    createTool: () =>
      tool(
        async (input: { refs: string[] }, runConfig: any) => {
          const session: Session | undefined = runConfig?.configurable?.session
          if (!session) return '现在没在任何一个聊天里。'
          const convKey = conversationKey(session, runConfig?.configurable?.agentContext)
          const refs = refStore.get(convKey) ?? new Map<string, string>()
          const wanted = (input.refs || []).slice(0, config.peek.maxBatch)
          if (!wanted.length) return '要告诉我看哪一张（编号 r1/r2… 或 pHash 前缀）。'

          const vision = modelImageSupport(runConfig)
          // 预算按天计数：跨天时清掉旧 key，避免内存无限增长
          const today = new Date().toISOString().slice(0, 10)
          for (const key of inlineBudgetToday.keys()) {
            if (!key.endsWith(`|${today}`)) inlineBudgetToday.delete(key)
          }
          const dayKey = `${convKey}|${today}`
          const blocks: any[] = []
          const notes: string[] = []

          for (const raw of wanted) {
            const target = await resolvePeekTarget(raw, session, refs)
            if (!target.pHash) {
              notes.push(`${raw}：${target.error ?? '我没找到这张'}`)
              continue
            }
            const pHash = target.pHash
            touch(lockedStore, convKey, pHash)
            const meta = await library.getMeta(pHash)
            if (!meta) {
              notes.push(`${raw}：这张还没进库（或已被淘汰）。`)
              continue
            }
            const image = await storage.readImage(pHash)
            if (!image) {
              notes.push(`${pHash.slice(0, 8)}：这张的文件丢失了，看不了。`)
              continue
            }
            const caption =
              `这是表情 ${pHash.slice(0, 8)}：${meta.description || '（没写描述）'}。` +
              (meta.usageHint ? `适合：${meta.usageHint}。` : '') +
              ((meta.tags || []).length ? `标签：${meta.tags.join('/')}。` : '')

            // 内联条件：开关 + 主模型支持视觉(未知按乐观) + 字节在上限内（超限先压缩）+ 预算未超
            const maxBytes = config.peek.maxKb * 1024
            let sendBytes = image.bytes
            let sendMime = image.mime
            if (config.peek.inline && vision !== false && sendBytes.length > maxBytes) {
              const compressed = await compressForPeek(sendBytes, sendMime, { logger: deps.logger })
              // 只有确实变小才采用（纯色/线条图转 JPEG 可能反而更大）
              if (compressed && compressed.bytes.length < sendBytes.length) {
                sendBytes = compressed.bytes
                sendMime = compressed.mime
              }
            }
            const budgetOk =
              config.peek.dailyBudgetKb <= 0 ||
              (inlineBudgetToday.get(dayKey) ?? 0) + sendBytes.length / 1024 <= config.peek.dailyBudgetKb
            if (config.peek.inline && vision !== false && sendBytes.length <= maxBytes && budgetOk) {
              blocks.push({
                type: 'image_url',
                image_url: { url: `data:${sendMime};base64,${sendBytes.toString('base64')}` },
              })
              blocks.push({
                type: 'text',
                text: `${caption}\n${OBSERVATION_HINTS.inline}`,
              })
              inlineBudgetToday.set(dayKey, (inlineBudgetToday.get(dayKey) ?? 0) + sendBytes.length / 1024)
              continue
            }

            // 文字档案路径：meta 缺描述则尽力补写（判官模型可用 + autoDescribe）
            let desc = meta.description
            if (!desc && config.peek.autoDescribe && judge.hasModel && vision !== true) {
              const d = await judge.describe(image.bytes, image.mime)
              if (d) {
                desc = d.description
                const nextUsage = meta.usageHint || d.usageHint
                await library.upsertMeta(pHash, {
                  description: d.description,
                  tags: meta.tags.length ? meta.tags : d.tags,
                  usageHint: nextUsage,
                  descModel: config.review.model,
                })
                void semantic
                  .upsert(pHash, { description: d.description, usageHint: nextUsage, tags: d.tags })
                  .catch(() => {})
              }
            }
            const why =
              vision === false
                ? '当前跟我说话的模型这会儿看不了图'
                : !config.peek.inline
                  ? '看图内联被关了'
                  : sendBytes.length > maxBytes
                    ? '这张图太大装不进眼前'
                    : '今天的看图预算用完了'
            notes.push(`${pHash.slice(0, 8)} 的文字档案：${desc || meta.usageHint || '(还没有描述)'}。${why}，${OBSERVATION_HINTS.textOnly}`)
          }

          if (!blocks.length) {
            return notes.join('\n') || '这次一张都没看到。'
          }
          const tail = notes.length ? `\n另外几张：${notes.join(' ')}` : ''
          blocks.push({ type: 'text', text: `以上是你要看的表情。\n${PERCEPTION_NOTE}。${tail}` })
          return blocks as unknown as string
        },
        {
          name: 'sticker_peek',
          description: TOOL_MODEL_DESCRIPTIONS.peek,
          schema: z.object({
            refs: z
              .array(z.string())
              .describe('要看哪几张：编号（r1、r2）、pHash 前缀，或 latest（最新收的那张）/ reply（被引用的那张）'),
          }),
        },
      ),
  } as ChatLunaTool, deps)

  // ── sticker_send ──
  register('sticker_send', {
    description: TOOL_REGISTRY_DESCRIPTIONS.send,
    selector: () => true,
    meta: toolMeta(['send']),
    createTool: () =>
      tool(
        async (input: { ref?: string; intent?: string }, runConfig: any) => {
          const session: Session | undefined = runConfig?.configurable?.session
          if (!session) return '现在没在任何一个聊天里，发不出去。'
          const convKey = conversationKey(session, runConfig?.configurable?.agentContext)
          const refs = refStore.get(convKey) ?? new Map<string, string>()

          let pHash: string | null = null
          if (input.ref) {
            pHash = await library.resolveRef(input.ref, refs)
            if (!pHash) {
              return `我没找到编号 ${input.ref} 这张（可能过期了），让我再翻一次库（sticker_search）再发。`
            }
          } else if (input.intent) {
            const { candidates } = await pickCandidates(deps, input.intent, 1, convKey)
            if (candidates.length) pHash = candidates[0].pHash
            else {
              const fb = await fallbackRandom(deps, new Set(await library.recentSent(convKey)), 1)
              pHash = fb[0]?.pHash ?? null
            }
          } else {
            // 无参形态（设计 §5.3）：发上一轮 search/peek/save 锁定的那张
            pHash = lockedStore.get(convKey) ?? null
            if (!pHash) return '我还不知道该发哪张：先让我翻翻库（sticker_search），或说一句想要什么感觉。'
          }

          // 刚在这个会话发过的自动顺延到下一候选；库不足 3 张时不启用（允许重复，设计 §5.3）
          const recent = new Set(await library.recentSent(convKey))
          if (pHash && recent.has(pHash) && (await library.countMeta()) >= 3) {
            const alt = await fallbackRandom(deps, recent, 1)
            if (alt.length) pHash = alt[0].pHash
          }
          if (!pHash) return '这回我没能挑出一张合适的表情，先用文字回吧；也可以让我再翻翻库（sticker_search）。'

          const meta = await library.getMeta(pHash)
          if (!meta) return `那张（${pHash.slice(0, 8)}）还没进库，发不出去。`
          const image = await storage.readImage(pHash)
          if (!image) {
            // 文件缺失的自愈：meta/occurrence/向量/索引一起清，之后群友再发还能重新收集
            await library.deleteSticker(pHash, true).catch(() => {})
            await semantic.remove(pHash).catch(() => {})
            return `${meta.description || pHash.slice(0, 8)} 的文件丢失了，我把它从库里清掉了，再挑一张吧。`
          }

          const result = await deliverSticker(config, session, image.bytes, image.mime, deps.logger)
          if (!result.ok) return `这张没能发出去（${result.reason ?? '未知原因'}），换一张或先用文字回。`

          await library.markUsed(pHash)
          await library.recordSent(convKey, pHash, result.channel)
          const channelWord = result.channel === 'sticker' ? '以表情的样子' : '发成了图片'
          return `这个表情我${channelWord}发出去了：${meta.description || pHash.slice(0, 8)}。`
        },
        {
          name: 'sticker_send',
          description: TOOL_MODEL_DESCRIPTIONS.send,
          schema: z.object({
            ref: z.string().optional().describe('要发的编号（r1…）或 pHash 前缀；留空不填则发上一轮锁定/刚看过的那张'),
            intent: z.string().optional().describe('不指定 ref 时：想表达的情绪/场景，如"无语""庆贺"'),
          }),
        },
      ),
  } as ChatLunaTool, deps)

  // ── sticker_save ──
  register('sticker_save', {
    description: TOOL_REGISTRY_DESCRIPTIONS.save,
    selector: () => true,
    meta: toolMeta(['save']),
    createTool: () =>
      tool(
        async (input: { target?: 'reply' | 'latest'; note?: string }, runConfig: any) => {
          const session: Session | undefined = runConfig?.configurable?.session
          if (!session) return '现在没在任何一个聊天里，收不了图。'
          const convKey = conversationKey(session, runConfig?.configurable?.agentContext)
          const refs = refStore.get(convKey) ?? new Map<string, string>()

          const target = input.target ?? 'reply'
          let urls: string[] = []
          let sourceHint = ''
          if (target === 'reply') {
            // session.quote 是 Satori 的访问器（event.message.quote），比手挖 session.message 更稳
            const quote: any = (session as any).quote ?? (session as any).message?.quote ?? (session as any).event?.message?.quote
            if (!quote) {
              return '这条消息没有引用任何内容，我没法收"引用里那张图"。可以改用 latest 收刚发的那张。'
            }
            const qEls = Array.isArray(quote.elements) ? quote.elements : quote.message?.elements
            urls = qEls ? extractImageSources(qEls) : []
            sourceHint = '引用的那张'
          } else {
            urls = extractImageSources(session.elements as readonly any[])
            sourceHint = '刚发的这张'
            if (!urls.length) {
              // 当前消息往往只是"把这张收起来"这句话，图在更早的消息里（设计 §5.4）。
              // 优先取「本次触发者」最近 5 分钟发的图，避免把别的图/机器人自己发的图收进来。
              const now = Date.now()
              const recent = recentImages(session, 8)
              const mine = recent.filter(
                (item) => item.userId === session.userId && now - item.at <= 5 * 60_000,
              )
              const picked = mine.length ? mine : recent
              urls = picked.map((item) => item.url)
              sourceHint = mine.length ? '刚发的' : '最近收到的'
              if (picked.length) {
                deps.logger.debug(
                  `[save] latest 回溯 ${picked.length} 张（${mine.length ? '本人近 5 分钟' : '会话最近'}）：${picked[0].url.slice(0, 100)}`,
                )
              }
            }
          }
          if (!urls.length) {
            return '这次没能从消息里拿到图片：当前消息没有图，也没找到这个会话最近含图的记录。可以让对方再发一次，或引用那张图再让我收。'
          }

          // 依次尝试最近几张：某张地址失效（NapCat 缓存过期等）时顺延，而不是直接失败
          let bytes: Buffer | null = null
          const failures: string[] = []
          for (const candidate of urls.slice(-3).reverse()) {
            const got = await fetchImageBytes(candidate, deps.ctx.http as any, config.collect.maxDownloadKb * 1024, {
              allowedFileRoots: [config.storage.dir],
              // chatluna-storage 的临时图床在本机（端口 5140 之类），只对它的路径前缀放行回环
              allowLoopbackPrefixes: [CHATLUNA_STORAGE_PREFIX],
              onReject: (reason) => {
                failures.push(reason)
                deps.logger.debug(`[save] 取图被拒（${candidate.slice(0, 120)}）：${reason}`)
              },
            })
            if (got) {
              bytes = got
              break
            }
          }
          if (!bytes) {
            const last = failures[failures.length - 1]
            deps.logger.debug(`[save] ${sourceHint}取图失败，候选 ${urls.length} 个；最后原因：${last ?? '未知'}`)
            return `我取回${sourceHint}图失败了${last ? `（${last}）` : ''}，这会儿收不了。`
          }
          const mime = sniffImageMime(bytes)
          if (!mime) return '那张图的内容我识别不了格式（可能不是真图片），没法收。'
          const pHash = await library.computePHash(bytes)
          if (!pHash) return '算这张图的特征时出了点问题，收不了。'

          const canonical = library.segIndex.findNearest(pHash, config.collect.phashThreshold) ?? pHash
          const existed = await library.getMeta(canonical)
          if (existed) {
            forgetImages(session, urls)
            return `这张库里已经有了（${canonical.slice(0, 8)}：${existed.description || '没写描述'}），不用重复收。`
          }

          const saved = await storage.saveImage(canonical, bytes)
          // 已成功落盘，把用过的候选移出缓存，避免下一次 latest 又取到同一张
          forgetImages(session, urls)
          const note = input.note?.trim() || undefined
          if (config.review.activeGate && config.review.enabled && judge.hasModel) {
            const verdict = await judge.judgeOne(canonical, bytes, mime)
            if (verdict.collect) {
              verdict.note = note
              await commitCollected(deps, canonical, verdict, 'active')
              const ref = `r${refs.size + 1}`
              refs.set(ref, canonical)
              touch(lockedStore, convKey, canonical)
              return `我把这张收进库里了（${ref}｜${canonical.slice(0, 8)}）：${verdict.description || '没写描述'}`
            }
            await library.setOccurrenceStatus(canonical, 'rejected', {
              judgeError: verdict.duplicateOf ? `dupOf ${verdict.duplicateOf}` : verdict.error || '评审未通过',
            })
            // 只有本次真正落盘的文件才删（已有文件可能被被动收集引用，删了会让那条记录再也评审不了）
            if (saved.saved) await storage.removeImage(canonical)
            return verdict.duplicateOf
              ? `这张和库里 ${verdict.duplicateOf.slice(0, 8)} 那张是重复的，我没再收。`
              : '这张我过目后觉得不太合适收（可能尺度或质量问题），就让它留在聊天里吧。'
          }
          // 不把关：直接入库，尽力补档案
          let description = ''
          let tags: string[] = []
          let usageHint = ''
          if (judge.hasModel) {
            const d = await judge.describe(bytes, mime)
            if (d) {
              description = d.description
              tags = d.tags
              usageHint = d.usageHint
            }
          }
          await commitCollected(deps, canonical, { collect: true, description, tags, usageHint, note }, 'active')
          const ref = `r${refs.size + 1}`
          refs.set(ref, canonical)
          touch(lockedStore, convKey, canonical)
          return `我把这张收进库里了（${ref}｜${canonical.slice(0, 8)}）${description ? `：${description}` : ''}`
        },
        {
          name: 'sticker_save',
          description: TOOL_MODEL_DESCRIPTIONS.save,
          schema: z.object({
            target: z
              .enum(['reply', 'latest'])
              .optional()
              .describe('收引用消息里的图（reply，默认）还是最近收到的图（latest，当前消息没图时会回看最近记录）'),
            note: z.string().max(200).optional().describe('可选备注：为什么收它（独立保存，不影响检索）'),
          }),
        },
      ),
  } as ChatLunaTool, deps)

  // ── sticker_update ──
  register('sticker_update', {
    description: TOOL_REGISTRY_DESCRIPTIONS.update,
    selector: () => true,
    meta: toolMeta(['update']),
    createTool: () =>
      tool(
        async (
          input: { ref: string; description?: string; tags?: string[]; usageHint?: string; note?: string },
          runConfig: any,
        ) => {
          const session: Session | undefined = runConfig?.configurable?.session
          if (!session) return '现在没在任何一个聊天里。'
          const convKey = conversationKey(session, runConfig?.configurable?.agentContext)
          const refs = refStore.get(convKey) ?? new Map<string, string>()
          const raw = String(input.ref ?? '').trim()

          let pHash: string | null = null
          if (raw.toLowerCase() === 'latest') {
            const metas = await library.listMeta()
            if (!metas.length) return '库里还是空的，没有可改的档案。'
            pHash = metas.reduce((a, b) => ((b.collectedAt || 0) > (a.collectedAt || 0) ? b : a)).pHash
          } else {
            pHash = await library.resolveRef(raw, refs)
          }
          if (!pHash) return `我没找到 ${raw} 这张（编号可能过期了），先再翻一次库。`
          const meta = await library.getMeta(pHash)
          if (!meta) return `那张（${pHash.slice(0, 8)}）还没进库。`

          const patch: Partial<typeof meta> = {}
          if (typeof input.description === 'string') patch.description = input.description.trim()
          if (Array.isArray(input.tags)) {
            patch.tags = input.tags.map((tag) => String(tag).trim()).filter(Boolean).slice(0, 8)
          }
          if (typeof input.usageHint === 'string') patch.usageHint = input.usageHint.trim()
          if (typeof input.note === 'string') patch.note = input.note.trim()
          if (!Object.keys(patch).length) {
            return '要改点什么？给我 description、tags、usageHint 或 note 里的至少一项。'
          }

          await library.upsertMeta(pHash, patch)
          const updated = (await library.getMeta(pHash)) ?? meta
          if (semantic.ready) {
            void semantic
              .upsert(pHash, {
                description: updated.description,
                usageHint: updated.usageHint,
                tags: updated.tags,
              })
              .catch(() => {})
          }
          return (
            `改好了（${pHash.slice(0, 8)}）：${updated.description || '(无描述)'}` +
            `｜标签：${(updated.tags || []).join('/') || '无'}` +
            `｜时机：${updated.usageHint || '未写'}`
          )
        },
        {
          name: 'sticker_update',
          description: TOOL_MODEL_DESCRIPTIONS.update,
          schema: z.object({
            ref: z.string().describe('要改的表情编号（r1…）、pHash 前缀，或 latest（最近收的那张）'),
            description: z.string().max(300).optional().describe('改写后的简短描述（氛围/用途为主，不猜身份）'),
            tags: z.array(z.string()).optional().describe('新的标签列表（3-6 个情绪/场景短词）'),
            usageHint: z.string().max(120).optional().describe('聊天里什么时候发这张最合适'),
            note: z.string().max(200).optional().describe('备注：为什么收它'),
          }),
        },
      ),
  } as ChatLunaTool, deps)
}


