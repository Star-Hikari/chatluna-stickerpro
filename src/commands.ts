// 人类管理命令（设计 §10；全部 authority(2)，修复旧插件裸命令问题）

import type { Context } from 'koishi'
import { h } from 'koishi'
import { commitCollected } from './commit'
import type { ToolsDeps } from './commit'
import type { Config } from './config'
import { importImageDirectory } from './importer'
import type { Judge } from './judge'
import type { StickerLibrary } from './library'
import type { SemanticIndex } from './semantic'
import type { Storage } from './storage'
import type { Collector } from './collector'
import { resolveUnder } from './utils'

/** 命令侧依赖与工具侧一致（多一个 logger），retry 命令复用同一个入库出口 */
export interface CmdDeps extends ToolsDeps {
  ctx: Context
  config: Config
  library: StickerLibrary
  storage: Storage
  judge: Judge
  semantic: SemanticIndex
  collector: Collector
}

export function registerCommands(deps: CmdDeps): void {
  const { ctx, config, library, storage, judge, semantic } = deps
  const base = { authority: 2 as number }

  // 根命令只用于在控制台挂描述与分组；具体功能都在 chatluna.stickerpro.* 子命令里
  ctx.command('chatluna.stickerpro', '表情包库管理：浏览、预览、删除、导入与重建索引', base)

  ctx.command('chatluna.stickerpro.status', '表情包库状态', base).action(async ({ session }) => {
    const metas = await library.listMeta()
    const occ = await ctx.database.get('stickerpro_occurrence', {})
    const byStatus = new Map<string, number>()
    for (const o of occ) byStatus.set(o.status, (byStatus.get(o.status) ?? 0) + 1)
    const last7 = metas.filter((m) => (m.lastUsedAt || 0) > Date.now() - 7 * 86400_000).length
    return [
      `表情包库（stickerpro）`,
      `- 收藏：${metas.length} / 上限 ${config.library.maxImages}`,
      `- 追踪记录：${occ.length}（${[...byStatus].map(([k, v]) => `${k}=${v}`).join(', ') || '空'}）`,
      `- 近 7 天被用过：${last7} 张`,
      `- ${semantic.describeState()}`,
      `- 判官模型：${config.review.model || '无'}（评审${config.review.enabled ? '开' : '关'}）`,
      `- 收集群：${config.collect.groups.length} 个（开关${config.collect.enabled ? '开' : '关'}）`,
    ].join('\n')
  })

  ctx
    .command(
      'chatluna.stickerpro.list [count:string] [keyword:string]',
      '浏览收藏库（默认 10 张，可指定数量与关键词）',
      base,
    )
    .action(async ({ session }, count, keyword) => {
      const metas = await library.listMeta()
      const raw = (count ?? '').trim()
      const isCount = /^\d+$/.test(raw)
      if (isCount && Number(raw) <= 0) return '数量要大于 0。'
      const limit = isCount ? Math.min(100, Number(raw)) : 10
      // 兼容旧用法：list <关键词>（第一个参数不是数字就当关键词）
      const filter = (isCount ? keyword : count)?.trim()
      const filtered = filter
        ? metas.filter((m) =>
            `${m.description} ${m.usageHint} ${m.note || ''} ${m.tags.join(' ')}`.toLowerCase().includes(filter.toLowerCase()),
          )
        : metas
      if (!filtered.length) return `库里${filter ? `没有匹配"${filter}"的` : '还是空的'}。`
      const page = filtered
        .sort((a, b) => (b.lastUsedAt || b.collectedAt) - (a.lastUsedAt || a.collectedAt))
        .slice(0, limit)
        .map(
          (m, i) =>
            `${i + 1}. ${m.pHash.slice(0, 8)}｜${m.description || '(无描述)'}｜用过 ${m.useCount} 次${m.note ? `｜备注：${m.note}` : ''}｜${m.pHash}`,
        )
      return `共 ${filtered.length} 张，最近收藏的 ${page.length} 张：\n${page.join('\n')}`
    })

  ctx
    .command('chatluna.stickerpro.show <ref:string>', '把某张表情发到当前会话预览', base)
    .action(async ({ session }, ref) => {
      if (!session) return '这条命令要在会话里用。'
      const metas = await library.listMeta()
      const hit = metas.find((m) => m.pHash === ref || m.pHash.startsWith(ref))
      if (!hit) return `没找到以"${ref}"开头的表情。`
      const image = await storage.readImage(hit.pHash)
      if (!image) return `${hit.pHash.slice(0, 8)} 的文件丢失了。`
      await session.send(h.image(`data:${image.mime};base64,${image.bytes.toString('base64')}`))
      return `${hit.pHash.slice(0, 8)}：${hit.description || '(无描述)'}`
    })

  ctx
    .command('chatluna.stickerpro.delete <ref:string> [-y]', '删除某张表情（meta+文件+向量）', base)
    .option('y', '-y 跳过确认')
    .action(async ({ session, options }, ref) => {
      if (!session) return '这条命令要在会话里用。'
      const metas = await library.listMeta()
      const hit = metas.find((m) => m.pHash === ref || m.pHash.startsWith(ref))
      if (!hit) return `没找到以"${ref}"开头的表情。`
      if (!options?.y) return `确定要删除 ${hit.pHash.slice(0, 8)}（${hit.description || '无描述'}）吗？加 -y 确认。`
      await library.deleteSticker(hit.pHash)
      await semantic.remove(hit.pHash)
      await storage.removeImage(hit.pHash)
      return `已删除 ${hit.pHash.slice(0, 8)}。`
    })

  ctx
    .command('chatluna.stickerpro.retry <ref:string>', '对 judge_failed 的图重新评审', base)
    .action(async ({ session }, ref) => {
      const rows = await ctx.database.get('stickerpro_occurrence', {})
      const hit = rows.find((r) => r.pHash === ref || r.pHash.startsWith(ref))
      if (!hit) return `没找到以"${ref}"开头的记录。`
      if (hit.status === 'judging') return `${hit.pHash.slice(0, 8)} 正在评审中，等它跑完。`
      await ctx.database.set('stickerpro_occurrence', { pHash: hit.pHash }, { status: 'pending_review', judgeToken: '', judgeError: '' })
      const status = await deps.judge.processPending(hit.pHash, async (ph, verdict) => {
        await commitCollected(deps, ph, verdict, 'passive')
      })
      return `${hit.pHash.slice(0, 8)} 重新评审结果：${status}`
    })

  ctx.command('chatluna.stickerpro.rebuild-index', '全量重建语义向量索引', base).action(async () => {
    if (!config.semantic.enabled || config.semantic.model === '无') return '语义检索未启用，无需重建。'
    const n = await semantic.rebuild()
    return `向量索引重建完成，本次生成 ${n} 条。`
  })

  ctx
    .command('chatluna.stickerpro.regen-desc <ref:string>', '用判官模型重新生成某张表情的文字档案', base)
    .action(async ({ session }, ref) => {
      const metas = await library.listMeta()
      const hit = metas.find((m) => m.pHash === ref || m.pHash.startsWith(ref))
      if (!hit) return `没找到以"${ref}"开头的表情。`
      const image = await storage.readImage(hit.pHash)
      if (!image) return `${hit.pHash.slice(0, 8)} 的文件丢失了。`
      const d = await judge.describe(image.bytes, image.mime)
      if (!d) return '判官模型没给出结果（检查 review.model 配置与可用性）。'
      await library.upsertMeta(hit.pHash, {
        description: d.description,
        tags: d.tags,
        usageHint: d.usageHint || hit.usageHint,
        descModel: config.review.model,
      })
      await semantic.upsert(hit.pHash, { description: d.description, usageHint: d.usageHint || hit.usageHint, tags: d.tags }).catch(() => {})
      return `新档案：${d.description}（tags：${d.tags.join('/')}；时机：${d.usageHint || '—'}）`
    })

  // 手动导入：把 storage.importDir 下人工放置的图片初始化进表情包库（免评审，生成描述）
  ctx
    .command(
      'chatluna.stickerpro.import [limit:number]',
      '导入手动放置的图片（免评审，自动生成描述）',
      base,
    )
    .alias('chatluna.stickerpro.init')
    .option('refresh', '-r, --refresh 重新生成已有图片的描述与标签（提示词升级后用）')
    .action(async ({ session, options }, limit) => {
      const dir = resolveUnder(config.storage.dir, config.storage.importDir)
      const refresh = !!options?.refresh
      // 逐张生成描述可能耗时数分钟，先回执避免看起来像卡死；不向聊天窗口暴露真实路径
      await session?.send(
        refresh ? '正在重新生成已有表情包的描述与标签，请稍候…' : '正在导入中~',
      )
      let report
      try {
        report = await importImageDirectory(deps, dir, { limit, refresh })
      } catch (e) {
        const reason = (e instanceof Error ? e.message : String(e)).split(dir).join('导入目录')
        return `导入失败：${reason}`
      }
      if (!report.scanned) {
        return '导入目录里没有可导入的图片。支持 png/jpg/gif/webp/bmp/avif/heic。'
      }
      // 聊天窗口只回结果；逐张描述、跳过/失败明细都在 importer 的日志里
      const done = refresh ? `已成功更新 ${report.updated} 张` : `已成功导入 ${report.imported} 张`
      return report.failed ? `${done}，失败 ${report.failed} 张（详见日志）` : done
    })
}
