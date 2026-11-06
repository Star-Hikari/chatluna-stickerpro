// utils 冒烟测试：node ..\..\node_modules\tsx\dist\cli.mjs test\smoke.ts
import { join, resolve } from 'node:path'
import { collectImageSources } from '../src/collector'
import { DEFAULT_GIF_DIRECT_MAX_BYTES, planModelImages } from '../src/image'
import {
  PERCEPTION_NOTE,
  REVIEW_JSON_CONTRACT,
  REVIEW_PROMPT_DEFAULT,
  TOOL_MODEL_DESCRIPTIONS,
  TOOL_REGISTRY_DESCRIPTIONS,
} from '../src/prompt'
import { clearRecentImages, forgetImages, recentImages, rememberImages } from '../src/recent'
import {
  SegmentIndex,
  decodeVector,
  dot,
  encodeVector,
  extractJson,
  filePathAllowed,
  hamming,
  imageExtension,
  isPrivateAddress,
  keywordScore,
  l2normalize,
  phashSegments,
  resolveUnder,
  sniffImageMime,
  tokenize,
} from '../src/utils'

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

// ── tokenize：中文 2-gram──
const t1 = tokenize('开心可爱')
check('整串保留', t1.includes('开心可爱'))
check('2-gram 齐全', t1.includes('开心') && t1.includes('心可') && t1.includes('可爱'))
const t2 = tokenize('疑惑 问号，嗯')
check('标点/空格切段', t2.includes('疑惑') && t2.includes('问号') && t2.includes('嗯'))

// ── keywordScore：方向是"库文本包含搜索 token"──
check('tag 命中 > 文本命中', keywordScore(['无语'], ['无语'], '这扯不扯', '') > keywordScore(['无语'], [], '他很无语', ''))
check('无命中为 0', keywordScore(['吃饭'], ['摸鱼'], '哈哈', '') === 0)

// ── hamming ──
check('同哈希=0', hamming('c3c3c1cb9f03871d', 'c3c3c1cb9f03871d') === 0)
check('一段全翻=8', hamming('00c3c1cb9f03871d', 'ffc3c1cb9f03871d') === 8)
check('非法长度=Infinity', hamming('abc', '00c3c1cb9f03871d') === Infinity)

// ── SegmentIndex：鸽笼分段召回 ──
const idx = new SegmentIndex()
const base = 'c3c3c1cb9f03871d'
idx.add(base)
// 距离 2（两个 nibble 各改 1bit）应被召回
const near2 = 'c3c3c0cb9f01871d'
check('汉明2 计算正确', hamming(base, near2) === 2)
check('分段索引召回近邻', idx.findNearest(near2, 5) === base)
// 距离 10+ 不应误合并
const far = '0f00000000000000'
check('远距离不误合并', idx.findNearest(far, 5) === null)
check('精确命中自身', idx.findNearest(base, 5) === base)
idx.add(near2)
idx.remove(base)
check('remove 后精确不命中', idx.findNearest(base, 5) !== base || idx.findNearest(base, 5) === near2)

// ── SegmentIndex 回归：距离 3~5 必须召回 ──
// 旧实现只查三对段 {0,3}{1,4}{2,6}，距离 3 时每对可各被改中一段而全部失效 → 静默漏召。
const idx2 = new SegmentIndex()
idx2.add(base)
const d3 = 'c2c2c0cb9f03871d' // 段 0/1/2 各翻 1bit
const d5 = 'c2c2c0ca9e03871d' // 段 0/1/2/3/4 各翻 1bit
check('汉明3 计算正确', hamming(base, d3) === 3)
check('汉明5 计算正确', hamming(base, d5) === 5)
check('距离3 可召回（旧实现会漏）', idx2.findNearest(d3, 5) === base)
check('距离5 可召回（旧实现会漏）', idx2.findNearest(d5, 5) === base)
check('阈值2 时不误召回距离3', idx2.findNearest(d3, 2) === null)
check('阈值8 全量兜底仍可召回', idx2.findNearest(d5, 8) === base)

// 超大阈值（≥8）走全量扫描：距离 9 不该命中
const far9 = '3c3c3c3c3c3c3c3c'
check('距离超过阈值不召回', idx2.findNearest(far9, 8) === null)

// ── phashSegments ──
const segs = phashSegments(base)
check('8 段且首段=0xc3', segs.length === 8 && segs[0] === 0xc3)

// ── extractJson ──
check('纯 JSON', extractJson('{"collect":true}')?.collect === true)
check('围栏包裹', extractJson('```json\n{"collect":false}\n```')?.collect === false)
check('前后闲话', extractJson('好的：{"a":1} 完毕')?.a === 1)
check('坏 JSON=null', extractJson('{collect:') === null)

// ── sniffImageMime / imageExtension ──
check('PNG 魔数', sniffImageMime(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) === 'image/png')
check('JPEG 魔数', sniffImageMime(new Uint8Array([0xff, 0xd8, 0xff, 0xe0])) === 'image/jpeg')
check('GIF 魔数', sniffImageMime(new Uint8Array([0x47, 0x49, 0x46, 0x38, 0x39, 0x61])) === 'image/gif')
check('HTML 非图片', imageExtension('image/webp') === 'webp')

// ── 向量编解码往返 ──
const v = l2normalize([1, 2, 3, 4])
const back = decodeVector(encodeVector(v))!
check('向量往返维度', back.length === v.length)
check('向量往返数值', Math.abs(dot(v, back) - 1) < 1e-5)
check('归一化自身点积=1', Math.abs(dot(v, v) - 1) < 1e-5)

// ── 文案断言（设计 §5.5：工具名防译名 / 感知式 / 不引导复述过程）──
for (const key of ['search', 'peek', 'send', 'save', 'update'] as const) {
  check(`文案含工具名（${key}）`, TOOL_MODEL_DESCRIPTIONS[key].includes(`（工具名 sticker_${key}）`))
  check(`注册表文案非空（${key}）`, !!TOOL_REGISTRY_DESCRIPTIONS[key])
  check(`文案不出现"调用本工具"（${key}）`, !TOOL_MODEL_DESCRIPTIONS[key].includes('调用本工具'))
}
check(
  'search/peek 带 PERCEPTION_NOTE',
  TOOL_MODEL_DESCRIPTIONS.search.includes(PERCEPTION_NOTE) && TOOL_MODEL_DESCRIPTIONS.peek.includes(PERCEPTION_NOTE),
)
check('评审契约含 collect 字段', REVIEW_JSON_CONTRACT.includes('"collect"'))
check('默认模板含 DUP_BLOCK 占位符', REVIEW_PROMPT_DEFAULT.includes('{{DUP_BLOCK}}'))
check('默认模板未被契约污染', !REVIEW_PROMPT_DEFAULT.includes('"collect"'))

// ── 安全校验（SSRF / 本机文件）──
check(
  '内网地址判定',
  isPrivateAddress('127.0.0.1') &&
    isPrivateAddress('10.1.2.3') &&
    isPrivateAddress('192.168.1.1') &&
    isPrivateAddress('172.16.0.1') &&
    isPrivateAddress('169.254.1.1') &&
    isPrivateAddress('::1'),
)
check('公网地址放行', !isPrivateAddress('8.8.8.8') && !isPrivateAddress('1.1.1.1'))
const cwd = process.cwd()
check('file:// 允许工作目录内', filePathAllowed(join(cwd, 'data', 'a.png')))
check('file:// 拒绝目录外', !filePathAllowed(resolve(cwd, '..', 'outside.png')))

// ── 导入目录解析（storage.importDir）──
const libRoot = resolve(cwd, 'data', 'stickerpro-library')
check('相对导入目录拼到库目录下', resolveUnder(libRoot, 'temp') === resolve(libRoot, 'temp'))
check('绝对导入目录原样使用', resolveUnder(libRoot, resolve(cwd, 'other-import')) === resolve(cwd, 'other-import'))
check('空值回退到库目录', resolveUnder(libRoot, '') === libRoot)

// ── 引用消息 / 最近图片回溯（sticker_save 取图故障的回归）──
const quoted: any = {
  platform: 'onebot',
  guildId: 'g1',
  channelId: 'g1',
  userId: 'u1',
  messageId: 'm1',
  elements: [{ type: 'img', attrs: { src: 'https://example.com/top.png' } }],
  quote: { elements: [{ type: 'img', attrs: { src: 'https://example.com/quote.png' } }] },
}
check('顶层图片可解析', collectImageSources(quoted).includes('https://example.com/top.png'))
check('引用图片可解析（session.quote）', collectImageSources(quoted).includes('https://example.com/quote.png'))

clearRecentImages()
const sessionA: any = { platform: 'onebot', guildId: 'g', channelId: 'g', userId: 'u1', messageId: '1' }
const sessionB: any = { platform: 'onebot', guildId: 'g', channelId: 'g', userId: 'u2', messageId: '2' }
rememberImages(sessionA, ['https://example.com/a.png', 'https://example.com/b.png'])
check(
  '最近图片新的在前',
  recentImages(sessionB, 3).map((x) => x.url).join(',') === 'https://example.com/b.png,https://example.com/a.png',
)
rememberImages(sessionB, ['https://example.com/c.png'])
check('跨消息累积', recentImages(sessionB, 3)[0]?.url === 'https://example.com/c.png')
check('同 URL 去重', recentImages(sessionB, 5).filter((x) => x.url === 'https://example.com/a.png').length === 1)

// file 附件（chatluna-storage 转存）也算图片源
const fileAttachment: any = {
  elements: [{ type: 'file', attrs: { src: 'http://127.0.0.1:5140/chatluna-storage/temp/x.jpg' } }],
}
check(
  'file 附件识别为图片',
  collectImageSources(fileAttachment).includes('http://127.0.0.1:5140/chatluna-storage/temp/x.jpg'),
)
check(
  '非图片 file 附件忽略',
  collectImageSources({ elements: [{ type: 'file', attrs: { src: 'https://example.com/a.txt' } }] } as any).length === 0,
)

// 机器人自己发的图不进缓存；用过的图移出缓存
clearRecentImages()
const selfSession: any = { platform: 'onebot', guildId: 'gs', channelId: 'gs', userId: 'bot', selfId: 'bot' }
rememberImages(selfSession, ['https://example.com/self.png'])
check('机器人自己发的图不进缓存', recentImages(selfSession, 3).length === 0)
const userSession: any = { platform: 'onebot', guildId: 'gu', channelId: 'gu', userId: 'u', selfId: 'bot' }
rememberImages(userSession, ['https://example.com/x.png', 'https://example.com/y.png'])
forgetImages(userSession, ['https://example.com/y.png'])
check(
  '用过的图移出缓存',
  recentImages(userSession, 5).map((x) => x.url).join(',') === 'https://example.com/x.png',
)
clearRecentImages()

// ── 全局图片投递链（设计附录 D 第 10 条，评审与描述共用）──
const smallGif = planModelImages(Buffer.alloc(1024), 'image/gif')
check(
  '小 GIF：直传 → 抽帧 → 单图兜底',
  smallGif.map((a) => a.label).join(',') === 'gif-direct,gif-frames,single',
)
const bigGif = planModelImages(Buffer.alloc(DEFAULT_GIF_DIRECT_MAX_BYTES + 1), 'image/gif')
check('大 GIF：跳过直传', bigGif.map((a) => a.label).join(',') === 'gif-frames,single')
const staticPng = planModelImages(Buffer.alloc(100), 'image/png')
check('静态图：单步（≤2MB 原字节）', staticPng.length === 1 && staticPng[0].label === 'single')
const directPayload = await smallGif[0].build()
check('gif-direct 原字节 image/gif + 提示语', directPayload?.images[0]?.mime === 'image/gif' && !!directPayload?.hint)
const framesPayload = await smallGif[1].build()
check('非法 GIF 抽帧返回 null（调用方跳到下一级）', framesPayload === null)

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
