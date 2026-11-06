// koishi-plugin-chatluna-stickerpro —— 装配入口
// 时序（对齐 chatluna-dev-guide/生态惯例）：
//   apply: 定义数据表 → 建实例 → 挂 middleware → 注册命令
//   ready: library.load（分段索引）→ judge.start（模型，带重试窗口）→ semantic.start
//          → storageProvider 注入 → recoverStuck + drainPending → 注册四工具 → 挂定时任务

import type { Context } from 'koishi'
import { createLogger } from 'koishi-plugin-chatluna/utils/logger'
import { Collector } from './collector'
import type { Config } from './config'
import { commitCollected } from './commit'
import { defineDatabase } from './database'
import { Judge } from './judge'
import { StickerLibrary } from './library'
import { SemanticIndex } from './semantic'
import { Storage } from './storage'
import { registerCommands } from './commands'
import { registerTools } from './tools'

export const name = 'chatluna-stickerpro'

export const inject = {
  required: ['chatluna', 'database'],
  optional: ['console'],
} as const

// koishi 惯例：interface 与同名 const Schema 声明合并（config.ts 同时导出两者）
export { Config } from './config'

export function apply(ctx: Context, config: Config) {
  const logger = createLogger(ctx, 'chatluna-stickerpro')
  const cfg = config as any

  defineDatabase(ctx)

  const library = new StickerLibrary(ctx, cfg, logger)
  const storage = new Storage(cfg.storage.dir, logger)
  const judge = new Judge(ctx, cfg, library, logger)
  judge.storageProvider = async (pHash) => {
    const image = await storage.readImage(pHash)
    return image ? { bytes: image.bytes, mime: image.mime } : null
  }
  const semantic = new SemanticIndex(ctx, cfg, library, logger)
  const collector = new Collector({ ctx, config: cfg, library, storage, judge, semantic, logger })

  collector.attach()
  registerCommands({ ctx, config: cfg, library, storage, judge, semantic, collector, logger })

  ctx.on('ready', async () => {
    logger.info('[ready] 开始初始化')
    await library.load()

    // 判官模型可能比 ready 晚就绪（chatluna 适配器/模型注册时序）：先建一次，再由模型注册事件补建。
    // start() 失败不抛错（内部只 warn），这里不阻塞后续；最终就绪汇总里会体现评审开关状态。
    await judge.start()
    await semantic.start()

    // 模型注册事件 → 幂等补建（判官/embedding 任一未就绪时才有实际动作）
    ctx.on('chatluna/model-added' as any, () => {
      void judge.start()
      void semantic.start()
    })

    if (!judge.hasModel && cfg.review.model && cfg.review.model !== '无') {
      // 兜底轮询：3s × 10（事件偶发丢失时的保险丝，成功或到期即自行停止）
      let tries = 0
      const stop = ctx.setInterval(async () => {
        tries++
        await judge.start()
        if (judge.hasModel || tries >= 10) stop()
      }, 3000)
    }

    // 恢复卡死的评审 + 处理积压的待评审（重启后自愈闭环，继承旧插件）
    await judge.recoverStuck()
    const deps = { ctx, config: cfg, library, storage, judge, semantic, collector, logger }
    void judge
      .drainPending(async (ph, verdict) => commitCollected(deps, ph, verdict, 'passive'))
      .catch((e) => logger.warn(`[ready] drain 积压评审异常：${e instanceof Error ? e.message : String(e)}`))

    // 工具注册：platform.registerTool 返回 disposer，统一由 ctx.effect 清理（tools.ts 内部处理）
    registerTools(deps)

    // 定时维护：每小时超时恢复 + 待评审补跑；每 6h TTL/冷却清理/超限淘汰（设计 §6.6）
    ctx.setInterval(async () => {
      await judge.recoverStuck().catch(() => {})
      await judge
        .drainPending(async (ph, verdict) => commitCollected(deps, ph, verdict, 'passive'))
        .catch(() => {})
    }, 60 * 60 * 1000)
    ctx.setInterval(async () => {
      // TTL 过期行连同本地文件一起清（设计 §6.6：删行 + 删文件）
      const pruned = await library.pruneStaleOccurrences((ph) => storage.removeImage(ph)).catch(() => 0)
      if (pruned) logger.debug(`[cron] TTL 清理 ${pruned} 条未收藏记录`)
      await library.pruneRecentSends().catch(() => 0)
      await library.enforceLibraryLimit((ph) => storage.removeImage(ph)).catch(() => 0)
    }, 6 * 60 * 60 * 1000)

    logger.info(
      `chatluna-stickerpro 已就绪：收藏库 ${await library.countMeta()} 张 · 收集 ${cfg.collect.groups.length} 个群 · ` +
        `评审${cfg.review.enabled && judge.hasModel ? '开' : '关'} · ${semantic.describeState()}`,
    )
  })

  ctx.on('dispose', () => {
    logger.debug('stickerpro scope 释放（工具/消息监听/命令由 ctx.effect 自动清理）')
  })
}
