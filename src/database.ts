// 数据表定义（设计 §4；全部 stickerpro_ 前缀，与旧插件 sticker_* 零冲突）
// minato 兼容性口径（继承旧插件已验证做法）：时间戳一律 unsigned 毫秒；数组用原生 list（JSON 单列）；
// 向量用 base64 text（sqlite/mongo 无压力；大库仍 < 单行 MB 级）

import type { Context } from 'koishi'
import type { MetaRow, OccurrenceRow, RecentSendRow, VectorRow } from './types'

// 把四张表注册进 koishi 的 Tables 类型（ctx.database.get/set/create/remove 才有推导）
declare module 'koishi' {
  interface Tables {
    stickerpro_occurrence: OccurrenceRow
    stickerpro_meta: MetaRow
    stickerpro_vector: VectorRow
    stickerpro_recent_send: RecentSendRow
  }
}

export function defineDatabase(ctx: Context) {
  // 被动收集计数与评审状态机
  ctx.model.extend(
    'stickerpro_occurrence',
    {
      pHash: 'string(64)',
      count: 'unsigned',
      status: 'string(24)',
      firstSeenAt: 'unsigned',
      lastSeenAt: 'unsigned',
      mime: 'string(48)',
      ext: 'string(8)',
      source: 'string(12)',
      guildId: 'string(48)',
      judgeError: { type: 'text', length: 65535 },
      judgeStartedAt: 'unsigned',
      judgeToken: 'string(32)',
    },
    { primary: 'pHash' },
  )

  // 收藏库（peek/send 数据源）
  ctx.model.extend(
    'stickerpro_meta',
    {
      pHash: 'string(64)',
      tags: 'list',
      description: { type: 'text', length: 65535 },
      usageHint: { type: 'text', length: 65535 },
      note: { type: 'text', length: 65535 },
      source: 'string(12)',
      useCount: 'unsigned',
      lastUsedAt: 'unsigned',
      collectedAt: 'unsigned',
      descModel: 'string(64)',
    },
    { primary: 'pHash' },
  )

  // 语义向量（按行存储；崩溃无整库一致性问题，见设计 §3.2）
  ctx.model.extend(
    'stickerpro_vector',
    {
      pHash: 'string(64)',
      embeddingModel: 'string(64)',
      dim: 'unsigned',
      data: { type: 'text', length: 16777215 },
      updatedAt: 'unsigned',
    },
    { primary: 'pHash' },
  )

  // 会话发送冷却（持久化，重启不丢"刚发过哪几张"）
  ctx.model.extend(
    'stickerpro_recent_send',
    {
      id: 'string(36)',
      conversationKey: 'string(96)',
      pHash: 'string(64)',
      at: 'unsigned',
    },
    { primary: 'id' },
  )
}
