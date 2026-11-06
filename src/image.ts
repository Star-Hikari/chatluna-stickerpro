// peek 内联前的压缩（设计 §5.2）：长边 ≤ 1024、JPEG q80；GIF/动图保持原样（重编码会丢帧）。
//
// jimp 是纯 JS（无原生绑定），而且只在图片真的超过 peek.maxKb 时才会走到这里，
// 正常尺寸的表情包不会付出解码成本。
//
// 另外这里是"喂给判官模型的图片"的全局投递链 planModelImages（设计附录 D 第 10 条，
// 2026-11-06 提升为全局）：小 GIF 直传 image/gif，大 GIF/直传失败等间隔抽帧为多图 JPEG，
// 最后兜底首帧 JPEG。评审（judge.judgeOne）与一切描述生成（judge.describe）都走它；
// sticker_peek 给主模型内联不在此列（保持原字节，动图价值高）。

import type { Logger } from 'koishi'
import { Jimp, JimpMime } from 'jimp'
import { GIF_DIRECT_HINT, gifFramesHint } from './prompt'
import { sampleGifFrames } from './gif'

export interface CompressedImage {
  bytes: Buffer
  mime: string
}

/** 是否值得尝试压缩：GIF/WebP/AVIF 保持原样，只压缩 PNG/JPEG/BMP */
export function compressibleMime(mime: string): boolean {
  return mime === 'image/png' || mime === 'image/jpeg' || mime === 'image/bmp'
}

/**
 * 转成"模型友好"的图片：GIF/WebP/AVIF 与超大图统一转 JPEG（保留首帧，用于生成描述）。
 * 入库仍然保存原始字节——这里只影响喂给判官模型的那一份。
 */
export async function toModelImage(
  bytes: Buffer,
  mime: string,
  options: { maxLongEdge?: number; quality?: number; logger?: Logger } = {},
): Promise<CompressedImage> {
  const maxLongEdge = options.maxLongEdge ?? 1280
  const quality = options.quality ?? 82
  const friendly = mime === 'image/png' || mime === 'image/jpeg' || mime === 'image/bmp'
  if (friendly && bytes.length <= 2 * 1024 * 1024) return { bytes, mime }
  try {
    const image: any = await Jimp.read(bytes)
    const width: number = image.bitmap?.width ?? 0
    const height: number = image.bitmap?.height ?? 0
    if (width && height && Math.max(width, height) > maxLongEdge) {
      image.scaleToFit({ w: maxLongEdge, h: maxLongEdge })
    }
    const out = await image.getBuffer(JimpMime.jpeg, { quality })
    options.logger?.debug(`[image] 转模型输入 JPEG（${mime}，${bytes.length} → ${out.length} 字节）`)
    return { bytes: Buffer.from(out), mime: 'image/jpeg' }
  } catch (e) {
    options.logger?.debug(`[image] 转模型输入失败（按原图）：${e instanceof Error ? e.message : String(e)}`)
    return { bytes, mime }
  }
}

/** peek 超限压缩：长边缩到 maxLongEdge，输出 JPEG（quality）；返回 null 表示不需要压缩或失败。 */
export async function compressForPeek(
  bytes: Buffer,
  mime: string,
  options: { maxLongEdge?: number; quality?: number; logger?: Logger } = {},
): Promise<CompressedImage | null> {
  const maxLongEdge = options.maxLongEdge ?? 1024
  const quality = options.quality ?? 80
  if (!compressibleMime(mime)) return null
  try {
    const image: any = await Jimp.read(bytes)
    const width: number = image.bitmap?.width ?? 0
    const height: number = image.bitmap?.height ?? 0
    if (!width || !height) return null
    if (width <= maxLongEdge && height <= maxLongEdge) return null
    image.scaleToFit({ w: maxLongEdge, h: maxLongEdge })
    const out = await image.getBuffer(JimpMime.jpeg, { quality })
    options.logger?.debug(`[peek] 压缩 ${width}x${height} → ${maxLongEdge}px JPEG（${bytes.length} → ${out.length} 字节）`)
    return { bytes: Buffer.from(out), mime: 'image/jpeg' }
  } catch (e) {
    options.logger?.debug(`[peek] 压缩失败（忽略，按原图处理）：${e instanceof Error ? e.message : String(e)}`)
    return null
  }
}

// ───────── 全局图片投递链（判官模型输入） ─────────

/** 小 GIF 直传给模型的体积上限（字节）；超过则等间隔抽帧 */
export const DEFAULT_GIF_DIRECT_MAX_BYTES = 5 * 1024 * 1024
/** 大 GIF 按帧序等间隔抽取的帧数 */
export const DEFAULT_GIF_EVEN_FRAMES = 9

export interface ModelImagePayload {
  images: { bytes: Buffer; mime: string }[]
  /** 附加在问题/档案请求前的说明（多图/动图时告诉模型拿到的是什么） */
  hint?: string
}

export interface ModelImageAttempt {
  label: 'gif-direct' | 'gif-frames' | 'single'
  /** 惰性构造输入（抽帧有解码成本，只有真要用到这一步才执行）；返回 null 表示这一步不可用，直接跳到下一步 */
  build: () => Promise<ModelImagePayload | null>
}

export interface ModelImagePlanOptions {
  gifDirectMaxBytes?: number
  evenFrames?: number
  logger?: Logger
}

/**
 * 为"喂给判官模型的一份图"生成分级尝试链（按顺序试，失败自动退下一级）：
 *   - GIF ≤ directMax：[直传 image/gif, 等间隔抽帧多图 JPEG, 首帧 JPEG]；
 *   - GIF > directMax：[等间隔抽帧多图 JPEG, 首帧 JPEG]（大 GIF 通常只是帧数多）；
 *   - 静态图：[toModelImage 单图]（png/jpeg/bmp 且 ≤2MB 时就是原字节直传）。
 */
export function planModelImages(bytes: Buffer, mime: string, options: ModelImagePlanOptions = {}): ModelImageAttempt[] {
  const directMax = options.gifDirectMaxBytes ?? DEFAULT_GIF_DIRECT_MAX_BYTES
  const evenFrames = options.evenFrames ?? DEFAULT_GIF_EVEN_FRAMES
  const single: ModelImageAttempt = {
    label: 'single',
    build: async () => {
      const image = await toModelImage(bytes, mime, { logger: options.logger })
      return { images: [image] }
    },
  }
  if (mime !== 'image/gif') return [single]

  const frames: ModelImageAttempt = {
    label: 'gif-frames',
    build: async () => {
      try {
        const gif = await sampleGifFrames(bytes, { mode: 'even', evenFrames })
        if (!gif || !gif.frames.length) return null
        options.logger?.debug(
          `[plan] GIF ${gif.totalFrames} 帧 / ${(gif.durationMs / 1000).toFixed(1)}s，等间隔采样 ${gif.frames.length} 帧`,
        )
        return {
          images: gif.frames.map((f) => ({ bytes: f.bytes, mime: f.mime })),
          hint: gifFramesHint(gif.frames.length, gif.durationMs),
        }
      } catch (e) {
        options.logger?.debug(`[plan] GIF 抽帧失败：${e instanceof Error ? e.message : String(e)}`)
        return null
      }
    },
  }
  const direct: ModelImageAttempt = {
    label: 'gif-direct',
    build: async () => ({ images: [{ bytes, mime }], hint: GIF_DIRECT_HINT }),
  }
  return bytes.length <= directMax ? [direct, frames, single] : [frames, single]
}