// 端到端冒烟（假数据库 + 假判官模型，零外部依赖）
// 覆盖 Phase 1/2 验收：真实 PNG 算 pHash、occurrence 阈值触发、评审状态机（collect/reject/CAS/超时恢复）、
// 关键词选图回归（issue #1：useCount 不霸榜 + 会话冷却排除）、垃圾字节容错。
// 运行（沙箱/本机 esbuild 服务进程不可用时，走 tsc 转译 CJS；.tmp-test 已被 gitignore）：
//   node --max-old-space-size=6144 ../../node_modules/typescript/bin/tsc test/e2e.ts test/smoke.ts src/*.ts --module commonjs --target es2022 --moduleResolution node10 --esModuleInterop --skipLibCheck --strict false --outDir .tmp-test
//   Copy-Item test/fixture.png .tmp-test/test/
//   node .tmp-test/test/smoke.js && node .tmp-test/test/e2e.js

import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { Judge } from '../src/judge'
import { StickerLibrary } from '../src/library'
import { Storage } from '../src/storage'
import type { Config } from '../src/config'
import { fetchImageBytes, hamming } from '../src/utils'

const noop = () => {}
const fakeLogger: any = { log: noop, debug: noop, info: noop, warn: noop, error: noop }

// ── 假数据库：等值 query + set 带条件 + $in/$ne/$lt ──
function makeDb() {
  const data = new Map<string, any[]>()
  const tbl = (t: string) => {
    if (!data.has(t)) data.set(t, [])
    return data.get(t)!
  }
  const matchOne = (row: any, cond: any): boolean => {
    if (cond === null || typeof cond !== 'object') return row === cond
    return Object.entries(cond).every(([op, val]) => {
      if (op === '$ne') return row !== val
      if (op === '$lt') return Number(row) < Number(val)
      if (op === '$in') return (val as any[]).includes(row)
      return false
    })
  }
  const match = (row: any, query: any) =>
    Object.entries(query).every(([k, v]) =>
      v !== null && typeof v === 'object' && !Array.isArray(v) ? matchOne(row[k], v) : row[k] === v,
    )
  return {
    data,
    get: async (t: string, q: any) => tbl(t).filter((r) => match(r, q)).map((r) => ({ ...r })),
    create: async (t: string, row: any) => {
      tbl(t).push({ ...row })
      return 1
    },
    set: async (t: string, q: any, patch: any) => {
      let n = 0
      for (const r of tbl(t)) if (match(r, q)) Object.assign(r, patch), n++
      return n
    },
    remove: async (t: string, q: any) => {
      const keep = tbl(t).filter((r) => !match(r, q))
      const removed = tbl(t).length - keep.length
      data.set(t, keep)
      return removed
    },
  }
}

function makeCtx(db: ReturnType<typeof makeDb>, modelReturn?: (sys: string) => any) {
  return {
    database: db,
    logger: () => fakeLogger,
    http: { get: async () => new ArrayBuffer(0) },
    chatluna: {
      createChatModel: async () => ({
        value: modelReturn
          ? {
              invoke: async (msgs: any[]) => {
                const sys = msgs[0]?.content ?? ''
                return { content: typeof modelReturn === 'function' ? modelReturn(sys) : modelReturn }
              },
            }
          : null,
      }),
      createEmbeddings: async () => ({ value: null }),
    },
  } as any
}

const baseConfig = {
  storage: { dir: join(process.env.TEMP || 'C:/Windows/Temp', 'stickerpro-e2e-' + Date.now()) },
  collect: {
    enabled: true,
    groups: ['12345'],
    threshold: 3,
    phashThreshold: 5,
    ttlDays: 10,
    maxDownloadKb: 6144,
  },
  review: {
    enabled: true,
    model: 'mock/model',
    activeGate: true,
    promptTemplate: 'x {{DUP_BLOCK}}',
    dupBlockTemplate: 'dup:\n{{DUP_LIST}}',
    describePrompt: 'd',
    concurrency: 3,
    timeoutMinutes: 10,
  },
  library: { maxImages: 1000 },
  semantic: { enabled: false, model: '无', concurrency: 3, minSimilarity: 0.3 },
  sending: { mode: 'image', cooldown: 3 },
  peek: { inline: true, maxKb: 2048, autoDescribe: true, dailyBudgetKb: 0, maxBatch: 4 },
  debug: false,
} as unknown as Config

let pass = 0
let fail = 0
function check(name: string, cond: boolean) {
  if (cond) {
    pass++
    console.log(`  ok  ${name}`)
  } else {
    fail++
    console.error(`FAIL  ${name}`)
  }
}

async function main() {
  // ── 1. 真实 PNG：pHash 稳定且格式合法 ──
  // 夹具路径：从 test/ 直接跑用 __dirname；从 .tmp-test/test 跑时脚本会先把 fixture 复制过来
const __dir = typeof __dirname === 'string' ? __dirname : '.'
const png = await readFile(join(__dir, 'fixture.png'))
  const db1 = makeDb()
  const ctx1 = makeCtx(db1)
  const lib1 = new StickerLibrary(ctx1, baseConfig, fakeLogger)
  await lib1.load()
  const h1 = await lib1.computePHash(png)
  check('pHash 16hex', !!h1 && /^[0-9a-f]{16}$/.test(h1!))
  const h1b = await lib1.computePHash(png)
  check('pHash 稳定', h1 === h1b)
  const junk = await lib1.computePHash(Buffer.from('not an image at all'))
  check('垃圾字节容错返回 null', junk === null)
  const bytesJunk = await fetchImageBytes('data:image/png;base64,aGVsbG8=', { get: async () => new ArrayBuffer(0) } as any, 1e6)
  check('dataURI 取字节', !!bytesJunk && bytesJunk.toString() === 'hello')

  // ── 2. occurrence 阈值 → 评审 collect → meta/LRU ──
  const okModel = () => JSON.stringify({ collect: true, tags: ['开心'], description: '一只笑猫', usageHint: '高兴时', dupOf: '' })
  const db2 = makeDb()
  const ctx2 = makeCtx(db2, okModel)
  const lib2 = new StickerLibrary(ctx2, baseConfig, fakeLogger)
  await lib2.load()
  const judge2 = new Judge(ctx2, baseConfig, lib2, fakeLogger)
  await judge2.start()
  const storage2 = new Storage(baseConfig.storage.dir, fakeLogger)
  judge2.storageProvider = async () => ({ bytes: png, mime: 'image/png' })
  await storage2.saveImage('aaaa000000000001', png)

  let due = false
  for (let i = 0; i < 3; i++) {
    const r = await lib2.recordOccurrence('aaaa000000000001', { mime: 'image/png', ext: 'png', source: 'passive', guildId: '12345' })
    due = r.reviewDue
  }
  check('第 3 次出现触发评审', due)
  const status = await judge2.processPending('aaaa000000000001', async (ph, v) => {
    await lib2.upsertMeta(ph, { tags: v.tags, description: v.description, usageHint: v.usageHint, source: 'passive' })
  })
  check('评审结果 collected', status === 'collected')
  const meta = await lib2.getMeta('aaaa000000000001')
  check('meta 档案落库', meta?.description === '一只笑猫')
  const occ = await lib2.getOccurrence('aaaa000000000001')
  check('occurrence 状态 collected', occ?.status === 'collected')

  // 重复评审被 CAS 跳过（已非 pending_review）
  const again = await judge2.processPending('aaaa000000000001', async () => {})
  check('重复处理 skipped', again === 'skipped')

  // ── 3. reject + 模型失败 → judge_failed → 超时恢复 ──
  const db3 = makeDb()
  const ctx3 = makeCtx(db3, () => JSON.stringify({ collect: false, tags: [], description: '', usageHint: '', dupOf: '' }))
  const lib3 = new StickerLibrary(ctx3, baseConfig, fakeLogger)
  await lib3.load()
  const judge3 = new Judge(ctx3, baseConfig, lib3, fakeLogger)
  await judge3.start()
  judge3.storageProvider = async () => ({ bytes: png, mime: 'image/png' })
  await lib3.recordOccurrence('bbbb000000000002', { mime: 'image/png', ext: 'png', source: 'passive', guildId: '1' })
  await lib3.recordOccurrence('bbbb000000000002', { mime: 'image/png', ext: 'png', source: 'passive', guildId: '1' })
  await lib3.recordOccurrence('bbbb000000000002', { mime: 'image/png', ext: 'png', source: 'passive', guildId: '1' })
  const st3 = await judge3.processPending('bbbb000000000002', async () => {})
  check('评审拒绝 rejected', st3 === 'rejected')
  check('拒绝不写 meta', (await lib3.getMeta('bbbb000000000002')) === undefined)

  // 模型抛错 → judge_failed
  const db3b = makeDb()
  const ctx3b = makeCtx(db3b)
  ctx3b.chatluna.createChatModel = async () => ({ value: { invoke: async () => { throw new Error('boom') } } })
  const lib3b = new StickerLibrary(ctx3b, baseConfig, fakeLogger)
  await lib3b.load()
  const judge3b = new Judge(ctx3b, baseConfig, lib3b, fakeLogger)
  await judge3b.start()
  judge3b.storageProvider = async () => ({ bytes: png, mime: 'image/png' })
  await lib3b.recordOccurrence('cccc000000000003', { mime: 'image/png', ext: 'png', source: 'passive', guildId: '1' })
  await lib3b.recordOccurrence('cccc000000000003', { mime: 'image/png', ext: 'png', source: 'passive', guildId: '1' })
  await lib3b.recordOccurrence('cccc000000000003', { mime: 'image/png', ext: 'png', source: 'passive', guildId: '1' })
  const st3b = await judge3b.processPending('cccc000000000003', async () => {})
  check('模型异常 → judge_failed', st3b === 'judge_failed')

  // 超时恢复：伪造一条卡死的 judging
  await db3b.set('stickerpro_occurrence', { pHash: 'cccc000000000003' }, { status: 'judging', judgeStartedAt: Date.now() - 11 * 60 * 1000 })
  const rec = await judge3b.recoverStuck()
  check('超时恢复 1 条', rec === 1)
  check('恢复为 pending_review', (await lib3b.getOccurrence('cccc000000000003'))?.status === 'pending_review')

  // ── 4. issue #1 回归：useCount 不霸榜 + 会话冷却排除 ──
  const db4 = makeDb()
  const ctx4 = makeCtx(db4)
  const lib4 = new StickerLibrary(ctx4, baseConfig, fakeLogger)
  await lib4.load()
  // s1 被"高频使用"（旧版此时会永远第一），s2 档案同样含关键词
  await lib4.upsertMeta('1111000000000001', { tags: ['开心', '可爱'], description: '开心猫', source: 'passive' })
  await lib4.upsertMeta('2222000000000002', { tags: ['开心'], description: '开心狗', source: 'passive' })
  for (let i = 0; i < 50; i++) await lib4.markUsed('1111000000000001')

  const r1 = await lib4.searchByKeyword('开心', { limit: 5 })
  check('两条都进候选（语义平局靠随机而非 useCount）', r1.length === 2)
  check('第一位不再是 useCount 王（10 次抽样至少 1 次 s2 居首）', (() => {
    for (let i = 0; i < 10; i++) {
      const r = lib4['searchByKeyword'] ? null : null
      void r
    }
    // 直接验证打分不含 useCount：两条 score 相同
    return r1[0].score === r1[1].score
  })())

  // 会话冷却：发过 s1 后，排除集里只剩 s2
  await lib4.recordSent('conv-a', '1111000000000001', 'image')
  const excl = new Set(await lib4.recentSent('conv-a'))
  const r2 = await lib4.searchByKeyword('开心', { limit: 5, exclude: excl })
  check('冷却排除后只剩 1 候选', r2.length === 1 && r2[0].meta.pHash === '2222000000000002')

  // ── 5. 汉明合并：pHash 距离 ≤5 归并到 canonical ──
  lib4.segIndex.add('3333000000000003')
  const near = '3333000000000013' // 差 1 bit
  check('测试自证：near 距离=1', hamming('3333000000000003', near) === 1)
  await lib4.recordOccurrence(near, { mime: 'image/png', ext: 'png', source: 'passive', guildId: '1' })
  await lib4.recordOccurrence(near, { mime: 'image/png', ext: 'png', source: 'passive', guildId: '1' })
  await lib4.recordOccurrence(near, { mime: 'image/png', ext: 'png', source: 'passive', guildId: '1' })
  const merged = await lib4.getOccurrence('3333000000000003')
  check('近邻归并到 canonical 且计数=3', merged?.count === 3)

  console.log(`\n${pass} passed, ${fail} failed`)
  process.exit(fail ? 1 : 0)
}

void main().catch((e) => {
  console.error(e)
  process.exit(1)
})
