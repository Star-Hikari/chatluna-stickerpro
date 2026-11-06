// collect 终态的统一落库出口（meta + 语义向量 + 状态 + 超限淘汰）
//
// 为什么单独成文件：collector / commands / index / tools 四边都要用它，而 tools 又会 import
// collector 里的元素解析函数。若把 commitCollected 留在 tools.ts，就会形成
// collector → tools → collector 的运行期循环依赖；本文件只有类型依赖、没有运行期 import，
// 因此任何一侧静态引入都不会产生循环。

import type { Context, Logger } from 'koishi'
import type { Config } from './config'
import type { Collector } from './collector'
import type { Judge, JudgeVerdict } from './judge'
import type { StickerLibrary } from './library'
import type { SemanticIndex } from './semantic'
import type { Storage } from './storage'

export interface ToolsDeps {
  ctx: Context
  config: Config
  library: StickerLibrary
  storage: Storage
  judge: Judge
  semantic: SemanticIndex
  collector: Collector
  logger: Logger
}

/**
 * 一张图通过评审（或跳过评审）后的唯一入库出口。
 * 调用方负责状态回写之前的图片落盘；这里只写 meta / 向量 / 淘汰。
 */
export async function commitCollected(
  deps: ToolsDeps,
  pHash: string,
  verdict: JudgeVerdict,
  source: 'passive' | 'active',
): Promise<void> {
  const { library, semantic, config } = deps
  await library.upsertMeta(pHash, {
    tags: verdict.tags,
    description: verdict.description,
    usageHint: verdict.usageHint,
    source,
    descModel: verdict.description ? config.review.model : '',
    // note 只在本次显式提供时写入：被动评审不能把主动收藏留的备注清空
    ...(verdict.note ? { note: verdict.note } : {}),
  })
  await library.setOccurrenceStatus(pHash, 'collected')
  if (config.semantic.enabled && (verdict.description || verdict.usageHint || verdict.tags.length)) {
    void semantic
      .upsert(pHash, { description: verdict.description, usageHint: verdict.usageHint, tags: verdict.tags })
      .catch(() => {})
  }
  await library.enforceLibraryLimit((ph) => deps.storage.removeImage(ph)).catch(() => {})
}