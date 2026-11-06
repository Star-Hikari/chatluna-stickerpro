// koishi-plugin-chatluna-stickerpro —— 共享类型
// 设计文档：koishi-app/../../设计报告-chatluna-stickerpro.md（r2）

/** occurrence 状态机（设计 §4.1；去掉旧插件从未 set 过的僵尸态 evicted） */
export type StickerStatus =
  | 'new'
  | 'pending_review'
  | 'judging'
  | 'collected'
  | 'rejected'
  | 'judge_failed'

/** 图片来源 */
export type StickerSource = 'passive' | 'active' | 'manual'

/** 发送通道结果（sticker = image 段 + sub_type=1 的表情包形式） */
export type DeliveryChannel = 'sticker' | 'image' | 'file'

export interface OccurrenceRow {
  pHash: string
  count: number
  status: StickerStatus
  firstSeenAt: number
  lastSeenAt: number
  mime: string
  ext: string
  source: StickerSource
  guildId: string
  judgeError: string
  judgeStartedAt: number
  judgeToken: string
}

export interface MetaRow {
  pHash: string
  tags: string[]
  description: string
  usageHint: string
  /** 收藏者/人类留的备注（sticker_save 的 note），独立字段，不混进 usageHint */
  note: string
  source: StickerSource
  useCount: number
  lastUsedAt: number
  collectedAt: number
  /** 档案/描述生成所用模型（换模型后可选择性重生成） */
  descModel: string
}

export interface VectorRow {
  pHash: string
  embeddingModel: string
  dim: number
  /** Float32 向量的 base64（L2 归一化后存储） */
  data: string
  updatedAt: number
}

export interface RecentSendRow {
  id: string
  conversationKey: string
  pHash: string
  at: number
}

/** sticker_save / 被动收集 传给评审层的图片候选（已完成字节获取与解析） */
export interface ImageCandidate {
  bytes: Buffer
  mime: string
  /** 建议落盘扩展名 */
  ext: string
}
