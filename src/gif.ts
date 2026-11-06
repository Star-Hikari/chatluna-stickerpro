// GIF 逐帧采样：按"自然播放时间"抽帧，交给多模态模型综合描述。
// 因此这里自己按 disposal 规则合成完整画布再导出 JPEG（白底，避免透明区域变黑）。

import { GifCodec } from 'gifwrap'
import { Jimp, JimpMime } from 'jimp'

export interface GifSampleFrame {
  bytes: Buffer
  mime: string
  /** 该帧在 GIF 时间轴上的大致时刻（毫秒） */
  atMs: number
}

export interface GifSampleResult {
  frames: GifSampleFrame[]
  durationMs: number
  totalFrames: number
  fps: number
  mode: 'time' | 'even'
}

export interface GifSampleOptions {
  /** time=按播放时间抽帧（旧策略）；even=按帧序等间隔抽帧（大 GIF 用） */
  mode?: 'time' | 'even'
  /** even 模式的目标帧数（默认 9） */
  evenFrames?: number
  shortThresholdMs?: number
  shortFps?: number
  longFps?: number
  maxFrames?: number
  minFrames?: number
  maxEdge?: number
  quality?: number
}

/** 把一帧的局部位图按偏移混合到整幅画布上（RGBA，白底） */
function drawFrame(
  canvas: Buffer,
  width: number,
  height: number,
  frame: { bitmap: { width: number; height: number; data: Buffer }; xOffset?: number; yOffset?: number },
): void {
  const fw = frame.bitmap.width
  const fh = frame.bitmap.height
  const data = frame.bitmap.data
  const ox = frame.xOffset ?? 0
  const oy = frame.yOffset ?? 0
  for (let y = 0; y < fh; y++) {
    const cy = oy + y
    if (cy < 0 || cy >= height) continue
    for (let x = 0; x < fw; x++) {
      const cx = ox + x
      if (cx < 0 || cx >= width) continue
      const si = (y * fw + x) * 4
      const alpha = data[si + 3]
      if (!alpha) continue
      const di = (cy * width + cx) * 4
      if (alpha === 255) {
        canvas[di] = data[si]
        canvas[di + 1] = data[si + 1]
        canvas[di + 2] = data[si + 2]
        canvas[di + 3] = 255
        continue
      }
      const a = alpha / 255
      canvas[di] = Math.round(data[si] * a + canvas[di] * (1 - a))
      canvas[di + 1] = Math.round(data[si + 1] * a + canvas[di + 1] * (1 - a))
      canvas[di + 2] = Math.round(data[si + 2] * a + canvas[di + 2] * (1 - a))
      canvas[di + 3] = 255
    }
  }
}

/** disposal=2：把该帧矩形恢复成背景（白） */
function clearFrameRect(
  canvas: Buffer,
  width: number,
  height: number,
  frame: { bitmap: { width: number; height: number }; xOffset?: number; yOffset?: number },
): void {
  const ox = frame.xOffset ?? 0
  const oy = frame.yOffset ?? 0
  for (let y = 0; y < frame.bitmap.height; y++) {
    const cy = oy + y
    if (cy < 0 || cy >= height) continue
    for (let x = 0; x < frame.bitmap.width; x++) {
      const cx = ox + x
      if (cx < 0 || cx >= width) continue
      const di = (cy * width + cx) * 4
      canvas[di] = 255
      canvas[di + 1] = 255
      canvas[di + 2] = 255
      canvas[di + 3] = 255
    }
  }
}

/**
 * 解码 GIF 并按时间采样若干帧（返回 JPEG）。
 * 解码失败/空帧返回 null，调用方回退到单帧描述。
 */
export async function sampleGifFrames(
  bytes: Buffer,
  options: GifSampleOptions = {},
): Promise<GifSampleResult | null> {
  try {
    const gif = await new GifCodec().decodeGif(bytes)
    const frames = gif.frames
    if (!frames.length) return null

    const delays = frames.map((frame) => Math.max(20, (frame.delayCentisecs || 0) * 10))
    const durationMs = delays.reduce((sum, delay) => sum + delay, 0)
    const mode = options.mode ?? 'time'
    const shortThresholdMs = options.shortThresholdMs ?? 5000
    const fps = durationMs <= shortThresholdMs ? (options.shortFps ?? 3) : (options.longFps ?? 1)
    const minFrames = options.minFrames ?? 3
    const maxFrames = options.maxFrames ?? 12

    const ends: number[] = []
    let acc = 0
    for (const delay of delays) {
      acc += delay
      ends.push(acc)
    }

    const indexes = new Set<number>()
    if (mode === 'even') {
      // 大 GIF 通常只是帧数多：按帧序等间隔抽，固定目标帧数
      const count = Math.min(maxFrames, Math.max(minFrames, options.evenFrames ?? 9))
      for (let i = 0; i < count; i++) {
        const index = Math.round((i / Math.max(1, count - 1)) * (frames.length - 1))
        indexes.add(index)
      }
    } else {
      const wanted = Math.min(maxFrames, Math.max(minFrames, Math.round((durationMs / 1000) * fps)))
      for (let i = 0; i < wanted; i++) {
        const t = ((i + 0.5) / wanted) * durationMs
        let index = ends.findIndex((end) => end >= t)
        if (index < 0) index = frames.length - 1
        indexes.add(index)
      }
      // 极短 GIF（如 0.2s）也保证至少 3 帧，便于看清动作
      if (indexes.size < minFrames) {
        indexes.add(0)
        indexes.add(Math.floor((frames.length - 1) / 2))
        indexes.add(frames.length - 1)
      }
    }
    const sampled = [...indexes].sort((a, b) => a - b).slice(0, maxFrames)

    const width = gif.width
    const height = gif.height
    const maxEdge = options.maxEdge ?? 640
    const quality = options.quality ?? 80
    let canvas = Buffer.alloc(width * height * 4)
    for (let i = 0; i < canvas.length; i += 4) {
      canvas[i] = 255
      canvas[i + 1] = 255
      canvas[i + 2] = 255
      canvas[i + 3] = 255
    }

    const out: GifSampleFrame[] = []
    for (let fi = 0; fi < frames.length; fi++) {
      const frame = frames[fi]
      const disposal = frame.disposalMethod ?? 0
      const saved = disposal === 3 ? Buffer.from(canvas) : null

      drawFrame(canvas, width, height, frame)

      if (sampled.includes(fi)) {
        const image: any = Jimp.fromBitmap({ width, height, data: Buffer.from(canvas) })
        if (Math.max(width, height) > maxEdge) image.scaleToFit({ w: maxEdge, h: maxEdge })
        const jpeg = await image.getBuffer(JimpMime.jpeg, { quality })
        out.push({
          bytes: Buffer.from(jpeg),
          mime: 'image/jpeg',
          atMs: Math.round(ends[fi] - delays[fi] / 2),
        })
      }

      if (disposal === 2) clearFrameRect(canvas, width, height, frame)
      else if (disposal === 3 && saved) canvas = saved
    }

    return { frames: out, durationMs, totalFrames: frames.length, fps, mode }
  } catch {
    return null
  }
}