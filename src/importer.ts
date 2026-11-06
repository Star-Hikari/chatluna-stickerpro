// 手动导入：把 <storage.dir>/temp 下放置的图片批量初始化进表情包库。
//
// 与被动收集的区别：
//   - 免评审（人工放进去的图默认是想要的），但仍用判官模型生成 description/tags；
//   - occurrence 直接标 collected，之后群友再发同一张图不会触发阈值评审；
//   - 原图原字节入库；喂给模型的输入与其他入口一致，走 judge.describe 的全局投递链
//     （image.ts planModelImages：小 GIF 直传 image/gif、大 GIF/失败回退等间隔抽帧、静态超大图转 JPEG）。

import { readFile, readdir } from 'node:fs/promises'
import { extname, join } from 'node:path'
import type { ToolsDeps } from './commit'
import type { MetaRow } from './types'
import { imageExtension, sniffImageMime } from './utils'

const IMAGE_EXTS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.avif', '.heic'])

export interface ImportItem {
  file: string
  status: 'imported' | 'updated' | 'skipped' | 'failed'
  pHash?: string
  description?: string
  reason?: string
}

export interface ImportReport {
  dir: string
  scanned: number
  imported: number
  updated: number
  skipped: number
  failed: number
  items: ImportItem[]
}

export interface ImportOptions {
  /** 最多处理几张（按文件名自然排序取前 N） */
  limit?: number
  /** 库里已有也重新生成描述/标签（用于提示词升级后刷新旧档案） */
  refresh?: boolean
  /** GIF 直接传给模型的体积上限（字节）；超过则等间隔抽帧。默认见 image.ts */
  gifDirectMaxBytes?: number
}

/**
 * 扫描目录并逐张导入。目录不存在/没有图片时返回空报告（不抛错）。
 * 判官模型未就绪时抛错——调用方把原因转成人类可读提示。
 */
export async function importImageDirectory(
  deps: ToolsDeps,
  dir: string,
  options: ImportOptions = {},
): Promise<ImportReport> {
  const { config, library, storage, judge, semantic, logger } = deps
  if (!judge.hasModel) {
    throw new Error('判官模型未就绪：请先在「评审与档案」里选择 review.model（需支持图片输入）')
  }

  let names: string[] = []
  try {
    const entries = await readdir(dir, { withFileTypes: true })
    names = entries
      .filter((entry) => entry.isFile() && IMAGE_EXTS.has(extname(entry.name).toLowerCase()))
      .map((entry) => entry.name)
      .sort((a, b) => a.localeCompare(b, 'zh-CN', { numeric: true }))
  } catch {
    return { dir, scanned: 0, imported: 0, updated: 0, skipped: 0, failed: 0, items: [] }
  }

  const limit = options.limit && options.limit > 0 ? Math.min(options.limit, names.length) : names.length
  const report: ImportReport = { dir, scanned: 0, imported: 0, updated: 0, skipped: 0, failed: 0, items: [] }

  for (const file of names.slice(0, limit)) {
    report.scanned++
    const path = join(dir, file)
    try {
      const bytes = await readFile(path)
      const mime = sniffImageMime(bytes)
      if (!mime) {
        report.failed++
        report.items.push({ file, status: 'failed', reason: '魔数不是图片（可能不是真实图片文件）' })
        continue
      }
      const pHash = await library.computePHash(bytes)
      if (!pHash) {
        report.failed++
        report.items.push({ file, status: 'failed', reason: 'pHash 计算失败' })
        continue
      }
      const canonical = library.segIndex.findNearest(pHash, config.collect.phashThreshold) ?? pHash
      const existed = await library.getMeta(canonical)
      if (existed && !options.refresh) {
        report.skipped++
        report.items.push({ file, status: 'skipped', pHash: canonical, reason: '库中已有这张图' })
        continue
      }

      // 描述输入：全局投递链（小 GIF 直传 → 等间隔抽帧 → 首帧/单图兜底），与评审/peek/save 一致。
      const profile = await judge.describe(bytes, mime, { gifDirectMaxBytes: options.gifDirectMaxBytes })
      if (!profile) {
        report.failed++
        report.items.push({ file, status: 'failed', reason: '描述生成失败（模型不可用或输出无法解析）' })
        logger.warn(`[import] ${file} 描述生成失败，未入库`)
        continue
      }

      const saved = await storage.saveImage(canonical, bytes)
      const now = Date.now()
      const patch: Partial<MetaRow> = {
        description: profile.description,
        tags: profile.tags,
        usageHint: profile.usageHint || '',
        descModel: config.review.model,
      }
      if (!existed) {
        patch.source = 'manual'
        patch.collectedAt = now
        patch.note = `手动导入：${file}`
      }
      await library.upsertMeta(canonical, patch)
      await library.registerCollected(canonical, saved.mime || mime, saved.ext || imageExtension(mime))
      if (config.semantic.enabled) {
        await semantic
          .upsert(canonical, {
            description: profile.description,
            usageHint: profile.usageHint || '',
            tags: profile.tags,
          })
          .catch(() => {})
      }

      if (existed) {
        report.updated++
        report.items.push({ file, status: 'updated', pHash: canonical, description: profile.description })
        logger.info(`[import] 更新 ${file} → ${canonical.slice(0, 8)}：${profile.description.slice(0, 50)}`)
      } else {
        report.imported++
        report.items.push({ file, status: 'imported', pHash: canonical, description: profile.description })
        logger.info(`[import] ${file} → ${canonical.slice(0, 8)}：${profile.description.slice(0, 50)}`)
      }
    } catch (e) {
      report.failed++
      const reason = e instanceof Error ? e.message : String(e)
      report.items.push({ file, status: 'failed', reason })
      logger.warn(`[import] ${file} 导入异常：${reason}`)
    }
  }

  logger.info(
    `[import] 完成：扫描 ${report.scanned}、导入 ${report.imported}、更新 ${report.updated}、跳过 ${report.skipped}、失败 ${report.failed}（目录 ${dir}）`,
  )
  return report
}