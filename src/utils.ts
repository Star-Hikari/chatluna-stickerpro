// 纯函数工具集：分词 / pHash 汉明与分段索引 / 魔数嗅探 / JSON 提取 / 信号量 / 向量编解码
// 本文件零依赖 koishi，可直接用 node 跑断言（test/utils.test.mjs）

import { fileURLToPath } from 'node:url'
import { readFile, stat } from 'node:fs/promises'
import { lookup } from 'node:dns/promises'
import { isIP } from 'node:net'
import { tmpdir } from 'node:os'
import { isAbsolute, resolve as resolvePath, sep } from 'node:path'

/** chatluna-storage 本地图床的路径前缀（端口不固定，仅回环主机放行） */
export const CHATLUNA_STORAGE_PREFIX = '/chatluna-storage/'

/** 判断一个地址看起来是不是图片（扩展名、data URI 或 chatluna-storage 临时图床） */
export function isLikelyImageUrl(url: unknown): url is string {
  if (typeof url !== 'string' || !url) return false
  if (/^data:image\//i.test(url)) return true
  if (/\.(png|jpe?g|gif|webp|bmp|avif|heic)(?:[?#]|$)/i.test(url)) return true
  return url.includes(CHATLUNA_STORAGE_PREFIX)
}

/** 相对路径挂到 base 目录下；绝对路径原样返回（空值回退到 base） */
export function resolveUnder(baseDir: string, target: string): string {
  const value = String(target ?? '').trim()
  if (!value) return baseDir
  return isAbsolute(value) ? value : resolvePath(baseDir, value)
}

// ───────────────────────── 文本 ─────────────────────────

/**
 * 检索分词（issue #1 修复点 2：中文 2-gram + 匹配方向反转）。
 * 返回小写 token 集合：标点/空格切段，整段保留，中文段追加全部 2-gram。
 * 例："开心可爱" → {开心可爱, 开心, 心可, 可爱}
 */
export function tokenize(text: string): string[] {
  const out = new Set<string>()
  for (const raw of String(text || '').toLowerCase().split(/[\s,，、;；。.!！?？/|、～~()（）【】\[\]"'“”]+/)) {
    const seg = raw.trim()
    if (!seg) continue
    out.add(seg)
    if (/[\u4e00-\u9fa5]/.test(seg)) {
      for (let i = 0; i + 1 < seg.length; i++) out.add(seg.slice(i, i + 2))
    }
  }
  return [...out]
}

/**
 * 关键词打分（方向：判断"搜索词的 token 是否出现在库文本里"，与旧插件相反）。
 * tag 命中 ×3，描述/使用提示命中 ×1。
 */
export function keywordScore(tokens: string[], tags: string[], description: string, usageHint: string): number {
  const tagHay = tags.join(' ').toLowerCase()
  const textHay = `${description || ''} ${usageHint || ''}`.toLowerCase()
  let score = 0
  for (const kw of tokens) {
    if (kw && tagHay.includes(kw)) score += 3
    else if (kw && textHay.includes(kw)) score += 1
  }
  return score
}

/** 从模型输出中提取 JSON（容忍 markdown 围栏与前后闲话；失败返回 null） */
export function extractJson(text: string): any | null {
  if (!text) return null
  const cleaned = text.replace(/```(?:json)?/gi, '')
  const m = /\{[\s\S]*\}/.exec(cleaned)
  if (!m) return null
  try {
    return JSON.parse(m[0])
  } catch {
    return null
  }
}

// ───────────────────────── pHash ─────────────────────────

/** 64bit pHash（16 hex）→ 8 段（每段 8bit，即每 2 个 hex 字符） */
export function phashSegments(pHash: string): number[] {
  const segs: number[] = []
  for (let i = 0; i < 8; i++) segs.push(parseInt(pHash.substr(i * 2, 2), 16))
  return segs
}

const POPCOUNT = new Uint8Array(256)
for (let i = 0; i < 256; i++) POPCOUNT[i] = ((i & 1) + POPCOUNT[i >> 1]) | 0

/** 两个 16-hex pHash 的汉明距离；长度非法返回 Infinity，长度不等按每字节差 4 bit 计罚 */
export function hamming(a: string, b: string): number {
  if (!a || !b || a.length !== 16 || b.length !== 16) return Infinity
  return hammingSegments(phashSegments(a), phashSegments(b))
}

/** 段数组直接比汉明（索引内部用，省一次 hex 解析） */
export function hammingSegments(a: number[], b: number[]): number {
  if (!a || !b || a.length !== 8 || b.length !== 8) return Infinity
  let d = 0
  for (let i = 0; i < 8; i++) d += POPCOUNT[a[i] ^ b[i]]
  return d
}

/**
 * 分段索引（设计 §6.5，兑现旧插件文案里承诺却没实现的东西）。
 *
 * 正确性口径：8 段各建一个桶（每段 8bit / 256 桶）。汉明距 d 必然修改 d 个段，
 * 因此 d ≤ threshold 时至少有 8-d 段完全相同 —— 查满 8 个桶取并集，候选集必然包含
 * 所有距离 ≤ 7 的既有项（threshold ≥ 8 时无此保证，退化为全量扫描）。
 *
 * ⚠️ 不要用"3 对不相邻段全等"之类的近似：d=3..5 时三对段可以各被改中一段而全部失效，
 * 会静默漏掉近重复图，导致同一张图被拆成多条 occurrence、永远到不了评审阈值。
 */
export class SegmentIndex {
  private readonly buckets: Array<Map<number, Set<string>>> = Array.from({ length: 8 }, () => new Map())
  private entries = new Map<string, number[]>()

  add(pHash: string, segs?: number[]): void {
    const s = segs ?? phashSegments(pHash)
    if (this.entries.has(pHash)) return
    this.entries.set(pHash, s)
    for (let i = 0; i < 8; i++) {
      let set = this.buckets[i].get(s[i])
      if (!set) this.buckets[i].set(s[i], (set = new Set()))
      set.add(pHash)
    }
  }

  remove(pHash: string): void {
    const s = this.entries.get(pHash)
    if (!s) return
    this.entries.delete(pHash)
    for (let i = 0; i < 8; i++) {
      const set = this.buckets[i].get(s[i])
      set?.delete(pHash)
      if (set && set.size === 0) this.buckets[i].delete(s[i])
    }
  }

  has(pHash: string): boolean {
    return this.entries.has(pHash)
  }

  get size(): number {
    return this.entries.size
  }

  all(): Iterable<[string, number[]]> {
    return this.entries.entries()
  }

  /**
   * 找与 pHash 汉明距 ≤ threshold 的既有项（返回最近的那个 pHash；未命中返回 null）。
   * 优先精确命中（旧插件同语义：PK 精确匹配在前）。
   */
  findNearest(pHash: string, threshold: number): string | null {
    if (this.entries.has(pHash)) return pHash
    const segs = phashSegments(pHash)

    // threshold ≥ 8：没有任何一段能保证全等，只能全量比一遍（宁慢勿漏）
    if (threshold >= 8) return this.scanAll(segs, threshold)

    const seen = new Set<string>()
    let best: string | null = null
    let bestD = threshold + 1
    for (let i = 0; i < 8; i++) {
      const set = this.buckets[i].get(segs[i])
      if (!set) continue
      for (const cand of set) {
        if (seen.has(cand)) continue
        seen.add(cand)
        const stored = this.entries.get(cand)
        if (!stored) continue
        const d = hammingSegments(stored, segs)
        if (d < bestD) {
          bestD = d
          best = cand
          if (d === 0) return cand
        }
      }
    }
    return best
  }

  private scanAll(segs: number[], threshold: number): string | null {
    let best: string | null = null
    let bestD = Infinity
    for (const [cand, stored] of this.entries) {
      const d = hammingSegments(stored, segs)
      if (d <= threshold && d < bestD) {
        bestD = d
        best = cand
        if (d === 0) return cand
      }
    }
    return best
  }
}

// ───────────────────────── 图片字节 ─────────────────────────

/** 魔数探测真实 MIME（外链扩展名不可信，只能看字节；同 envsense avatar.ts） */
export function sniffImageMime(bytes: Uint8Array): string | undefined {
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg'
  if (bytes.length >= 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return 'image/png'
  if (bytes.length >= 6) {
    const head = String.fromCharCode(...bytes.slice(0, 6))
    if (head === 'GIF87a' || head === 'GIF89a') return 'image/gif'
  }
  if (
    bytes.length >= 12 &&
    String.fromCharCode(...bytes.slice(0, 4)) === 'RIFF' &&
    String.fromCharCode(...bytes.slice(8, 12)) === 'WEBP'
  )
    return 'image/webp'
  if (bytes.length >= 12 && String.fromCharCode(...bytes.slice(4, 8)) === 'ftyp') {
    const brand = String.fromCharCode(...bytes.slice(8, 12))
    if (brand === 'avif') return 'image/avif'
    if (brand === 'heic' || brand === 'heix') return 'image/heic'
  }
  return undefined
}

const MIME_EXT: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/gif': 'gif',
  'image/webp': 'webp',
  'image/avif': 'avif',
  'image/heic': 'heic',
}

export function imageExtension(mime: string): string {
  return MIME_EXT[mime] ?? 'png'
}

/** HTML/JSON 错误页绝不能当图片处理（envsense 实测坑） */
export function looksLikeNonImage(bytes: Uint8Array): boolean {
  const head = Buffer.from(bytes.slice(0, 200)).toString('utf8').trimStart().toLowerCase()
  return head.startsWith('<!doctype') || head.startsWith('<html') || head.startsWith('{') || head.startsWith('[')
}

/**
 * 从 koishi 元素 attrs 解析图片地址（兼容三种适配器字段命名，同旧插件已验证的取值链）。
 */
export function elementImageUrl(attrs: Record<string, any> | undefined): string | undefined {
  if (!attrs) return undefined
  const v = attrs.src || attrs.url || attrs.file
  return typeof v === 'string' && v ? v : undefined
}

// ───────────────────────── 取字节（含 SSRF / 本机文件防护）─────────────────────────

/** 判断 IP 是否属于内网/回环/链路本地/保留段（SSRF 防护） */
export function isPrivateAddress(ip: string): boolean {
  const kind = isIP(ip)
  if (kind === 4) {
    const [a, b] = ip.split('.').map(Number)
    if (a === 0 || a === 10 || a === 127) return true
    if (a === 169 && b === 254) return true
    if (a === 172 && b >= 16 && b <= 31) return true
    if (a === 192 && b === 168) return true
    if (a === 100 && b >= 64 && b <= 127) return true // CGNAT
    if (a >= 224) return true // 组播与保留
    return false
  }
  if (kind === 6) {
    const low = ip.toLowerCase()
    if (low === '::1' || low === '::') return true
    if (low.startsWith('::ffff:')) return isPrivateAddress(low.slice('::ffff:'.length))
    if (low.startsWith('fc') || low.startsWith('fd')) return true // fc00::/7
    if (/^fe[89ab]/.test(low)) return true // fe80::/10
    return false
  }
  return false
}

const dnsCache = new Map<string, { private: boolean; at: number }>()
const DNS_CACHE_TTL = 10 * 60 * 1000

/** 是否回环地址（localhost / 127.x / ::1） */
export function isLoopbackHost(hostname: string): boolean {
  const host = String(hostname || '').replace(/^\[|\]$/g, '').toLowerCase()
  if (host === 'localhost') return true
  const kind = isIP(host)
  if (kind === 4) return host.startsWith('127.')
  if (kind === 6) return host === '::1'
  return false
}

/** 主机名是否指向内网（域名先解析再判断；解析失败按不安全处理，10 分钟缓存） */
export async function isPrivateHost(hostname: string): Promise<boolean> {
  const host = String(hostname || '').replace(/^\[|\]$/g, '').toLowerCase()
  if (!host) return true
  if (host === 'localhost' || host.endsWith('.localhost')) return true
  if (isIP(host)) return isPrivateAddress(host)
  const cached = dnsCache.get(host)
  if (cached && Date.now() - cached.at < DNS_CACHE_TTL) return cached.private
  try {
    const addresses = await lookup(host, { all: true })
    const privateHost = !addresses.length || addresses.some((item) => isPrivateAddress(item.address))
    if (dnsCache.size > 500) dnsCache.clear()
    dnsCache.set(host, { private: privateHost, at: Date.now() })
    return privateHost
  } catch {
    return true
  }
}

/**
 * 本地文件白名单：工作目录、系统临时目录、插件额外声明的目录（如图片库）。
 * 不在白名单内的路径一律拒绝，避免任意本地文件被读进表情库。
 */
export function filePathAllowed(filePath: string, roots?: string[]): boolean {
  const resolved = resolvePath(filePath).toLowerCase()
  const allow = [process.cwd(), tmpdir(), ...(roots ?? [])].map((root) => resolvePath(root).toLowerCase())
  return allow.some((root) => {
    const prefix = root.endsWith(sep) ? root : root + sep
    return resolved === root || resolved.startsWith(prefix)
  })
}

/**
 * dataURI / base64:// / http(s) / file:// / 本地绝对路径 统一取字节。
 * 安全约束：
 *   - http(s) 先做 SSRF 检查（内网/回环/链路本地直接拒绝），只接受图片 CDN 常用端口；
 *   - 本地路径（file:// 或 NapCat 只给 path 的情况）只允许白名单根目录；
 *   - 所有来源都先做体积预检，避免超大载荷把内存打满。
 *
 * onReject 用于把拒绝原因写进 debug 日志——排查"收不到图"时非常关键。
 */
export async function fetchImageBytes(
  url: string,
  http: { get: (url: string, opts?: any) => Promise<any> },
  maxSize: number,
  options: {
    allowedFileRoots?: string[]
    onReject?: (reason: string) => void
    /** 允许访问本机回环上的这些路径前缀（chatluna-storage 临时图床，端口不固定） */
    allowLoopbackPrefixes?: string[]
  } = {},
): Promise<Buffer | null> {
  const reject = (reason: string) => {
    options.onReject?.(reason)
    return null
  }
  try {
    if (url.startsWith('base64://')) {
      const encoded = url.slice(9)
      if (encoded.length * 0.75 > maxSize) return reject('base64 载荷超过上限')
      return Buffer.from(encoded, 'base64')
    }
    if (url.startsWith('data:')) {
      const m = /^data:[^;,]*;base64,(.*)$/s.exec(url)
      if (!m) return reject('dataURI 不是 base64 形式')
      if (m[1].length * 0.75 > maxSize) return reject('dataURI 载荷超过上限')
      return Buffer.from(m[1], 'base64')
    }
    if (url.startsWith('file://')) {
      const filePath = fileURLToPath(url)
      if (!filePathAllowed(filePath, options.allowedFileRoots)) return reject(`本地文件不在白名单：${filePath}`)
      const info = await stat(filePath)
      if (!info.isFile()) return reject(`不是普通文件：${filePath}`)
      if (info.size > maxSize) return reject(`文件超过上限：${info.size} 字节`)
      return await readFile(filePath)
    }
    // NapCat 有时只给本地路径（没有 file:// 前缀），这里一并支持
    if (!/^[a-z][a-z0-9+.-]*:/i.test(url) && isAbsolute(url) && !url.startsWith('\\\\')) {
      if (!filePathAllowed(url, options.allowedFileRoots)) return reject(`本地路径不在白名单：${url}`)
      const info = await stat(url)
      if (!info.isFile()) return reject(`不是普通文件：${url}`)
      if (info.size > maxSize) return reject(`文件超过上限：${info.size} 字节`)
      return await readFile(url)
    }
    if (/^https?:\/\//i.test(url)) {
      const parsed = new URL(url)
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return reject('非 http(s) 协议')
      const port = parsed.port ? Number(parsed.port) : parsed.protocol === 'https:' ? 443 : 80
      // chatluna-storage 的临时图床跑在本机（如 127.0.0.1:5140），端口不固定；
      // 仅对白名单路径前缀 + 回环主机放行，其余仍走 SSRF 校验。
      const loopbackStorage =
        isLoopbackHost(parsed.hostname) &&
        (options.allowLoopbackPrefixes ?? []).some((prefix) => parsed.pathname.startsWith(prefix))
      if (!loopbackStorage) {
        if (![80, 443, 8080, 8443].includes(port)) return reject(`端口不在白名单：${port}`)
        if (await isPrivateHost(parsed.hostname)) return reject(`主机解析到内网：${parsed.hostname}`)
      }
      const raw = await http.get(url, {
        responseType: 'arraybuffer',
        headers: { 'User-Agent': 'Mozilla/5.0 (compatible; chatluna-stickerpro)' },
        timeout: 15_000,
        maxRedirects: 2,
      })
      const buf = Buffer.from(raw instanceof ArrayBuffer ? raw : raw)
      if (!buf.length) return reject('下载结果为空')
      if (buf.length > maxSize) return reject(`下载超过上限：${buf.length} 字节`)
      return buf
    }
    return reject('无法识别的图片地址格式')
  } catch (e) {
    return reject(`取图异常：${e instanceof Error ? e.message : String(e)}`)
  }
}

// ───────────────────────── 向量 ─────────────────────────

export function l2normalize(vec: number[] | Float32Array): Float32Array {
  const out = new Float32Array(vec)
  let sum = 0
  for (let i = 0; i < out.length; i++) sum += out[i] * out[i]
  const norm = Math.sqrt(sum)
  if (norm > 0) for (let i = 0; i < out.length; i++) out[i] /= norm
  return out
}

/** 点积（两侧都预归一化 → 即余弦相似度） */
export function dot(a: Float32Array, b: Float32Array): number {
  const n = Math.min(a.length, b.length)
  let s = 0
  for (let i = 0; i < n; i++) s += a[i] * b[i]
  return s
}

export function encodeVector(v: Float32Array): string {
  return Buffer.from(v.buffer, v.byteOffset, v.byteLength).toString('base64')
}

export function decodeVector(b64: string): Float32Array | null {
  try {
    const buf = Buffer.from(b64, 'base64')
    return new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4)
  } catch {
    return null
  }
}

/** 归一化向量集合的平均向量（再归一化），用于语义索引的重心校验/批量构建 */
export function meanVector(vectors: Float32Array[]): Float32Array | null {
  if (!vectors.length) return null
  const dim = vectors[0].length
  const out = new Float32Array(dim)
  for (const v of vectors) for (let i = 0; i < dim; i++) out[i] += v[i]
  return l2normalize(out)
}

// ───────────────────────── 并发 ─────────────────────────

/** 极简信号量（同旧插件语义；带排队上限防泄漏） */
export class Semaphore {
  private count = 0
  private queue: Array<() => void> = []

  constructor(private readonly limit: number, private readonly maxQueue: number = 200) {}

  async acquire(): Promise<void> {
    if (this.count < this.limit) {
      this.count++
      return
    }
    if (this.queue.length >= this.maxQueue) throw new Error('queue is full')
    await new Promise<void>((resolve) => this.queue.push(resolve))
    this.count++
  }

  release(): void {
    this.count--
    const next = this.queue.shift()
    if (next) next()
  }

  async run<T>(fn: () => Promise<T>): Promise<T> {
    await this.acquire()
    try {
      return await fn()
    } finally {
      this.release()
    }
  }

  get pending(): number {
    return this.queue.length
  }
}

/** 判断瞬时网络错误（embedding 退避重试用；同旧插件口径） */
export function isTransientNetworkError(e: unknown): boolean {
  const msg = e instanceof Error ? e.message : String(e)
  return /ECONNRESET|ECONNREFUSED|ETIMEDOUT|fetch failed|socket hang up|EAI_AGAIN|network/i.test(msg)
}

/** 判断"模型不支持图片输入"类报错（继承旧插件的中英文正则口径） */
export function isVisionUnsupportedError(e: unknown): boolean {
  const msg = e instanceof Error ? e.message : String(e)
  return /not support|unsupported|image_url|多模态|不支持.*图|invalid.*image|does not support/i.test(msg)
}

/** CAS 令牌（时间戳 + 随机，同旧插件格式） */
export function makeToken(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
}

/** sleep */
export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}
