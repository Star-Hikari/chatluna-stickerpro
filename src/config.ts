// 配置 Schema
//
// 分组方式：顶层 Schema.intersect([分组object, ...])，每个分组带 .description() 作为控制台卡片标题。
// 说明：
//   - 联动（intersect + union）只允许放在顶层；嵌套分组内不做条件隐藏（见规范"联动只能放顶层"）；
//   - 高级/低频调参项用 .hidden() 收起，值仍在 yml 中保留、可手改；
//   - 2026-10-31 已去掉 enabled 总开关与 collectExcludeGroups（用户决定）。
// 修改配置结构时务必同步 `koishi.yml` 中本插件的配置块（旧扁平键会被 schema 丢弃）。

import { Schema } from 'koishi'
import {
  DESCRIBE_PROMPT_DEFAULT,
  REVIEW_DUP_BLOCK_DEFAULT,
  REVIEW_JSON_CONTRACT,
  REVIEW_PROMPT_DEFAULT,
} from './prompt'

// 默认提示词集中在 prompt.ts（设计 §5.5）；这里保留同名导出，避免旧引用断裂。
export { DESCRIBE_PROMPT_DEFAULT, REVIEW_DUP_BLOCK_DEFAULT, REVIEW_JSON_CONTRACT, REVIEW_PROMPT_DEFAULT }

// ───────── Config ─────────

export interface Config {
  storage: {
    dir: string
    /** 手动导入目录：相对 storage.dir 或绝对路径（默认 temp） */
    importDir: string
  }
  collect: {
    enabled: boolean
    groups: string[]
    threshold: number
    phashThreshold: number
    ttlDays: number
    maxDownloadKb: number
  }
  review: {
    enabled: boolean
    model: string
    activeGate: boolean
    promptTemplate: string
    dupBlockTemplate: string
    describePrompt: string
    concurrency: number
    timeoutMinutes: number
  }
  library: {
    maxImages: number
  }
  semantic: {
    enabled: boolean
    model: string
    concurrency: number
    minSimilarity: number
  }
  sending: {
    mode: 'face' | 'image'
    cooldown: number
  }
  peek: {
    inline: boolean
    maxKb: number
    autoDescribe: boolean
    dailyBudgetKb: number
    maxBatch: number
  }
  debug: boolean
}

// ───────── 分组 1：存储 ─────────

const StorageGroup = Schema.object({
  dir: Schema.string()
    .default('data/stickerpro-library')
    .description('本地图片库目录，图片按 pHash 前两位分桶、按真实格式扩展名存储。'),
  importDir: Schema.string()
    .default('temp')
    .description('手动导入目录：相对图片库目录，或填绝对路径；导入命令会扫描这里的图片。'),
}).description('存储')

// ───────── 分组 2：被动收集 ─────────

const CollectGroup = Schema.object({
  enabled: Schema.boolean().default(true).description('是否监听群消息被动收集表情包。'),
  groups: Schema.array(String)
    .default([])
    .description('收集群列表（群号逐条填写）。只在这些群里计数与触发评审；留空=不收集。'),
  threshold: Schema.number()
    .default(5)
    .min(1)
    .description('同一张图（pHash 汉明合并后）全局累计出现达到此次数才提交评审——便宜地数、贵地判。'),
  ttlDays: Schema.number()
    .default(10)
    .min(0)
    .description('未收藏的计数记录超过此天数未再出现 → 清理记录与本地图片（0=不清理）。'),
  phashThreshold: Schema.number()
    .default(5)
    .min(1)
    .max(7)
    .hidden()
    .description('【高级】汉明距离 ≤ 该值视为同一张图（64bit pHash 分段索引）。'),
  maxDownloadKb: Schema.number()
    .default(6144)
    .min(256)
    .hidden()
    .description('【高级】单图下载/采集字节上限，超限丢弃。'),
}).description('被动收集')

// ───────── 分组 3：评审与档案 ─────────

const ReviewGroup = Schema.object({
  enabled: Schema.boolean().default(true).description('关闭后达到阈值直接入库，不再调用判官模型评审。'),
  model: Schema.dynamic('model')
    .default('无')
    .description('评审/描述用多模态模型（ChatLuna 已加载模型下拉）。必须支持图片输入；"无"=不评审不描述。'),
  activeGate: Schema.boolean().default(true).description('模型主动收藏（sticker_save）是否也要过评审。关闭=主动收的一律入库。'),
  promptTemplate: Schema.string()
    .role('textarea')
    .default(REVIEW_PROMPT_DEFAULT)
    .description('评审 system prompt（收藏口味判据，可自行修改措辞）。{{DUP_BLOCK}} 为近邻重复段占位符；输出 JSON 契约由程序追加、不可被本配置破坏。'),
  describePrompt: Schema.string()
    .role('textarea')
    .default(DESCRIBE_PROMPT_DEFAULT)
    .description('文字档案生成 prompt：用于主模型不支持看图时的兜底描述、以及评审关闭时的档案补写。'),
  dupBlockTemplate: Schema.string()
    .role('textarea')
    .default(REVIEW_DUP_BLOCK_DEFAULT)
    .hidden()
    .description('【高级】近邻去重段模板，{{DUP_LIST}} 占位符由程序填充候选清单（编号 + 描述）。'),
  concurrency: Schema.number()
    .default(3)
    .min(1)
    .hidden()
    .description('【高级】评审并发数。'),
  timeoutMinutes: Schema.number()
    .default(10)
    .min(1)
    .max(60)
    .hidden()
    .description('【高级】单次评审超时（分钟）。超时残留的 judging 会被自动重置重判。'),
}).description('评审与档案')

// ───────── 分组 4：表情库 ─────────

const LibraryGroup = Schema.object({
  maxImages: Schema.number()
    .default(1000)
    .min(1)
    .max(10000)
    .description('收藏上限。超过后按最后使用时间淘汰最久未使用的（保护新收藏不被立刻挤掉）。'),
}).description('表情库')

// ───────── 分组 5：语义检索 ─────────

const SemanticGroup = Schema.object({
  enabled: Schema.boolean().default(true).description('启用后 sticker_search 优先用 embedding 语义检索；未启用/未命中自动回退关键词匹配。'),
  model: Schema.dynamic('embeddings').default('无').description('向量模型（ChatLuna embeddings 下拉）。"无"或模型不可用时走关键词。'),
  minSimilarity: Schema.number()
    .default(0.3)
    .min(-1)
    .max(1)
    .description('余弦相似度下限，低于的候选丢弃（不同模型分布差异大，可先开调试日志观察实际分数）。'),
  concurrency: Schema.number()
    .default(3)
    .min(1)
    .hidden()
    .description('【高级】向量生成并发数。'),
}).description('语义检索')

// ───────── 分组 6：发送 ─────────

const SendingGroup = Schema.object({
  mode: Schema.union([
    Schema.const('face').description('表情包形式（私聊/群聊均生效；失败自动退回图片）'),
    Schema.const('image').description('普通图片'),
  ])
    .default('face')
    .description('"表情包形式"依赖 NapCat 的 image.sub_type=1（QQ 客户端会归类并缩放）；非 onebot 平台会退回普通图片。'),
  cooldown: Schema.number()
    .default(3)
    .min(0)
    .max(10)
    .description('同一会话最近 N 张已发自动跳过（0=关闭）。'),
}).description('发送')

// ───────── 分组 7：看图（peek）─────────

const PeekGroup = Schema.object({
  inline: Schema.boolean().default(true).description('关闭后 peek 只回文字档案（极端省 token 场景）。'),
  maxKb: Schema.number()
    .default(2048)
    .min(64)
    .description('单图内联上限（KB）；超限会先尝试压缩（长边≤1024、JPEG），仍超限才走文字档案。'),
  autoDescribe: Schema.boolean().default(true).description('主模型不能看图时，允许用判官模型现场生成/补写文字描述（一次成本长期收益）。'),
  dailyBudgetKb: Schema.number()
    .default(0)
    .min(0)
    .hidden()
    .description('【高级】每会话每日内联字节预算，0=不限。超了就改走文字档案。'),
  maxBatch: Schema.number()
    .default(4)
    .min(1)
    .max(6)
    .hidden()
    .description('【高级】单次 peek 最多同时看几张（防上下文爆炸）。'),
}).description('看图')

// ───────── 分组 8：调试（顶层单字段，避免为一个开关多套一层）─────────

const DebugSchema = Schema.boolean()
  .default(false)
  .description('记录：元素解析/下载/汉明命中细节、发给模型的完整 prompt、实际评审返回、交付通道选择。')

// 说明：这里用嵌套 object 而不是顶层 intersect——intersect 会把各分组字段平铺到同一层，
// 本插件有多个同名语义字段（enabled/model/concurrency），平铺会互相覆盖；嵌套 object 同样按
// .description() 在控制台渲染分组，且运行期就是 config.collect.xxx 这种命名空间。
export const Config: Schema<Config> = Schema.object({
  storage: StorageGroup,
  collect: CollectGroup,
  review: ReviewGroup,
  library: LibraryGroup,
  semantic: SemanticGroup,
  sending: SendingGroup,
  peek: PeekGroup,
  debug: DebugSchema,
}) as Schema<Config>