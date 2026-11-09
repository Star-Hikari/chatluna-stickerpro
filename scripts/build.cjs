// 构建 lib：TypeScript 编译（只出 d.ts）+ 逐文件 transpile（CJS JS）。
// 全部在进程内完成，不依赖 esbuild 子进程（Windows 沙箱/CI 上更稳，也不会和 HMR 抢文件锁）。
//
// 用法：
//   node scripts/build.cjs
//   yarn workspace koishi-plugin-chatluna-stickerpro build
//
// 说明：dev 模式下 Koishi 通过 tsconfig paths 直接跑 src/，本脚本产出的 lib/ 供发布与 `yarn start` 使用。

const path = require('node:path')
const fs = require('node:fs')
const ts = require('typescript')

const root = path.resolve(__dirname, '..')
const srcDir = path.join(root, 'src')
const outDir = path.join(root, 'lib')

function fail(message) {
  console.error(message)
  process.exit(1)
}

if (!fs.existsSync(srcDir)) fail(`src not found: ${srcDir}`)
fs.mkdirSync(outDir, { recursive: true })

// ── 1. 类型声明（tsconfig 解析规则保持不变，保证与 IDE 一致）──
const configPath = path.join(root, 'tsconfig.json')
const read = ts.readConfigFile(configPath, ts.sys.readFile)
if (read.error) fail(ts.flattenDiagnosticMessageText(read.error.messageText, '\n'))

const parsed = ts.parseJsonConfigFileContent(read.config, ts.sys, root, { emitDeclarationOnly: true }, configPath)
if (parsed.errors.length) {
  for (const d of parsed.errors) console.error(ts.flattenDiagnosticMessageText(d.messageText, '\n'))
  process.exit(1)
}

const program = ts.createProgram({ rootNames: parsed.fileNames, options: parsed.options })
const emitResult = program.emit(undefined, undefined, undefined, true)
const diagnostics = ts.getPreEmitDiagnostics(program).concat(emitResult.diagnostics)
if (diagnostics.length) {
  for (const d of diagnostics) console.error(ts.flattenDiagnosticMessageText(d.messageText, '\n'))
  process.exit(1)
}

// ── 2. JS（CommonJS，与 package.json main/typings 对应）──
let count = 0
for (const file of fs.readdirSync(srcDir)) {
  if (!file.endsWith('.ts')) continue
  const source = fs.readFileSync(path.join(srcDir, file), 'utf8')
  const result = ts.transpileModule(source, {
    fileName: file,
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
      esModuleInterop: true,
      importHelpers: false,
    },
    reportDiagnostics: true,
  })
  const errors = (result.diagnostics || []).filter((d) => d.category === ts.DiagnosticCategory.Error)
  if (errors.length) {
    for (const d of errors) console.error(`${file}: ${ts.flattenDiagnosticMessageText(d.messageText, '\n')}`)
    process.exit(1)
  }
  fs.writeFileSync(path.join(outDir, file.replace(/\.ts$/, '.js')), result.outputText)
  count++
}

// ── 3. 清理 lib/package.json ──
// 根 package.json 没有 "type" 字段，Node 默认按 CommonJS 处理，不需要 lib 下再放一份标记。
// 历史遗留的 lib/package.json 曾带 UTF-8 BOM（{"type":"commonjs"}），ChatLuna 的
// usage_source 会 JSON.parse 最近的 package.json，遇到 BOM 直接抛 SyntaxError，
// 导致 createModel 报 "model not found"；这里每次构建都删掉，避免再次被打包。
const staleLibPkg = path.join(outDir, 'package.json')
if (fs.existsSync(staleLibPkg)) fs.rmSync(staleLibPkg, { force: true })

console.log(`built ${count} modules → lib/ (CommonJS + d.ts)`)