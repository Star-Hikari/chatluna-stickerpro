// 本地图片库文件层（设计 §4.4：原格式原字节 + 真实扩展名，修复旧版"任意格式写 .png"）

import { access, mkdir, readFile, stat, unlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { Logger } from 'koishi'
import { imageExtension, sniffImageMime } from './utils'

export class Storage {
  constructor(
    private readonly baseDir: string,
    private readonly logger: Logger,
  ) {}

  private bucket(pHash: string): string {
    return join(this.baseDir, pHash.slice(0, 2))
  }

  /** 当前配置下的落盘路径（ext 缺省按 png 兼容旧行） */
  filePath(pHash: string, ext = 'png'): string {
    return join(this.bucket(pHash), `${pHash}.${ext}`)
  }

  /**
   * 保存字节（幂等：已存在即跳过）。
   * 真实 MIME 由魔数嗅探决定扩展名；嗅不出类型按 png 存并打日志。
   */
  async saveImage(pHash: string, bytes: Buffer): Promise<{ mime: string; ext: string; saved: boolean }> {
    const mime = sniffImageMime(bytes) ?? 'image/png'
    const ext = imageExtension(mime)
    if (!sniffImageMime(bytes)) this.logger.debug(`[storage] ${pHash} 魔数无法识别，按 png 存储`)
    const existing = await this.locate(pHash)
    if (existing) {
      return { mime: existing.mime, ext: existing.ext, saved: false }
    }
    await mkdir(this.bucket(pHash), { recursive: true })
    await writeFile(this.filePath(pHash, ext), bytes)
    return { mime, ext, saved: true }
  }

  /** 读字节：按目录扫描真实扩展名（无回退链需要——文件名即事实） */
  async readImage(pHash: string): Promise<{ bytes: Buffer; mime: string; ext: string } | null> {
    const found = await this.locate(pHash)
    if (!found) return null
    try {
      const bytes = await readFile(found.path)
      return { bytes, mime: found.mime, ext: found.ext }
    } catch (e) {
      this.logger.warn(`[storage] 读取 ${pHash} 失败：${e instanceof Error ? e.message : String(e)}`)
      return null
    }
  }

  /** 只取元信息（列表展示尺寸用，不读整份字节） */
  async statImage(pHash: string): Promise<{ size: number; mime: string; ext: string } | null> {
    const found = await this.locate(pHash)
    if (!found) return null
    try {
      const info = await stat(found.path)
      return { size: info.size, mime: found.mime, ext: found.ext }
    } catch {
      return null
    }
  }

  /** 定位已存文件（png/jpg/gif/webp/avif/heic 顺序尝试） */
  async locate(pHash: string): Promise<{ path: string; mime: string; ext: string } | null> {
    const exts = ['png', 'jpg', 'gif', 'webp', 'avif', 'heic']
    for (const ext of exts) {
      const path = this.filePath(pHash, ext)
      try {
        await access(path)
        return { path, mime: ext === 'jpg' ? 'image/jpeg' : `image/${ext}`, ext }
      } catch {
        // 继续试下一个扩展名
      }
    }
    return null
  }

  async removeImage(pHash: string): Promise<void> {
    const found = await this.locate(pHash)
    if (!found) return
    try {
      await unlink(found.path)
    } catch (e) {
      this.logger.debug(`[storage] 删除 ${pHash} 失败（忽略）：${e instanceof Error ? e.message : String(e)}`)
    }
  }
}
