// 会话级"最近收到的图片"缓存（设计 §5.4：sticker_save 的 latest 要能找到
// "当前会话最近一条含图消息"，而不是只看当前这条）。
//
// 只存地址不存字节；每个会话保留最近 N 条，进程内即可——重启丢缓存，用户重发一张图即可。

import type { Session } from 'koishi'

export interface RecentImage {
  url: string
  at: number
  userId?: string
  messageId?: string
}

const MAX_PER_CHANNEL = 20
const MAX_CHANNELS = 200
const cache = new Map<string, RecentImage[]>()

/** 频道级键：同一会话里谁发的都算（收藏通常针对这个群/私聊里最近那张图） */
export function channelKey(session: Session): string {
  return `${session.platform}:${session.guildId || session.channelId || ''}`
}

/** 记录一条消息里的图片（同一 URL 去重并刷新到最新） */
export function rememberImages(session: Session, urls: string[]): void {
  if (!urls.length) return
  // 机器人自己发出的图（表情、预览）不算"用户最近发的图"，否则 sticker_save(latest) 会存成自己发的
  if (session.userId && session.userId === session.selfId) return
  const key = channelKey(session)
  const list = cache.get(key) ?? []
  for (const url of urls) {
    const index = list.findIndex((item) => item.url === url)
    if (index >= 0) list.splice(index, 1)
    list.push({ url, at: Date.now(), userId: session.userId, messageId: session.messageId })
  }
  while (list.length > MAX_PER_CHANNEL) list.shift()
  // 重新插入以刷新 LRU 顺序，并限制会话数量
  cache.delete(key)
  cache.set(key, list)
  while (cache.size > MAX_CHANNELS) {
    const oldest = cache.keys().next().value as string | undefined
    if (oldest === undefined) break
    cache.delete(oldest)
  }
}

/** 最近收到的图片（新的在前）；limit 默认 3，便于"最近那张"失败时顺延 */
export function recentImages(session: Session, limit = 3): RecentImage[] {
  const list = cache.get(channelKey(session)) ?? []
  return [...list].reverse().slice(0, limit)
}

/** 成功消费（保存/预览）后把这些地址移出缓存，避免下一次 latest 又取到同一张 */
export function forgetImages(session: Session, urls: string[]): void {
  if (!urls.length) return
  const key = channelKey(session)
  const list = cache.get(key)
  if (!list) return
  const drop = new Set(urls)
  const next = list.filter((item) => !drop.has(item.url))
  if (next.length) cache.set(key, next)
  else cache.delete(key)
}

/** 清空（测试用） */
export function clearRecentImages(): void {
  cache.clear()
}