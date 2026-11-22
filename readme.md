# koishi-plugin-chatluna-stickerpro

[![npm](https://img.shields.io/npm/v/koishi-plugin-chatluna-stickerpro?style=flat-square)](https://www.npmjs.com/package/koishi-plugin-chatluna-stickerpro)

为模型提供智能表情包收藏与发送工具：被动收集群里的表情（pHash 去重 + 判官模型评审），
五个模型工具——`sticker_search`（多角度检索：描述/标签/时机/备注）、`sticker_peek`（base64 内联，真的看见图）、
`sticker_send`（NapCat 私聊/群聊以表情包形式发送，失败自动降级图片）、`sticker_save`（主动收藏并由模型亲笔建档）、
`sticker_update`（模型自己修正描述/标签/使用时机）。
表情档案刻意保持"简洁"：只记氛围、用途与可见文字，不猜角色身份或作品来源；细节由主模型自己看图确认。
自研内存向量索引，无 WASM 并发问题，不需要 isolate-loader。

## 安装与依赖

- 需要 `koishi-plugin-chatluna`（^1.4.0）与数据库服务，安装后在控制台启用本插件即可；
- 评审与档案生成需要一个支持图片输入的模型（配置「评审与档案 → 判官模型」）；选"无"则不评审、
  达阈值直接入库，检索走关键词；
- 语义检索可选（「语义检索 → 向量模型」），未配置自动降级关键词匹配；
- 表情包形式发送依赖 NapCat/onebot；其他平台自动按普通图片发送。

## 快速上手

1. 在「被动收集 → 收集群列表」填入要监听QQ群号；
2. 在「评审与档案 → 判官模型」选一个多模态模型；
3. 完成。模型自动获得五个工具，无需任何提示词改动。

收集与评审：只统计配置群内群友发的图（含引用消息与表情面板内嵌图）；
近似图按 pHash 汉明合并计数，出现次数达到阈值才提交判官模型评审（便宜地数、贵地判）；
收藏的图按原格式原字节落盘，超限按 LRU 淘汰、过期计数记录自动清理。

## 配置一览

| 分组 | 内容 |
| --- | --- |
| 存储 | 图片库目录、手动导入目录、手动导入 note 模板 |
| 被动收集 | 开关、群列表、计数阈值、pHash 合并半径、记录 TTL、入库 note 模板 |
| 评审与档案 | 评审开关、判官模型、无视觉模型的主动收藏描述兜底（默认关）、可自定义的评审/描述提示词 |
| 表情库 | 收藏上限（LRU 淘汰） |
| 语义检索 | 向量模型、相似度阈值 |
| 发送 | 表情包形式/图片形式、同会话防重复冷却 |
| 看图 | 内联开关、单图上限（超限先压缩再降级文字）、无视觉时自动补写描述 |
| 调试 | 详细日志（完整 prompt、交付链选择等） |

GIF 喂给判官模型时：≤5MB 原样直传（模型原生支持动图），更大或直传失败自动按帧序等间隔抽 9 帧转多图输入；
`sticker_peek` 给主模型的仍是原 GIF。

## 管理命令

均为管理员权限（authority 2），`<ref>` 接受 pHash 前缀。命令名在控制台显示为点号，
聊天窗口里用空格输入：

```text
chatluna stickerpro status                 # 库规模、评审状态分布、索引情况
chatluna stickerpro list [count] [keyword] # 浏览收藏（默认 10 张，可指定数量与关键词；上限 100）
chatluna stickerpro show <ref>             # 把某张表情发到当前会话预览
chatluna stickerpro delete <ref> [-y]      # 删除（档案 + 文件 + 向量）
chatluna stickerpro retry <ref>            # 重新评审 judge_failed 的记录
chatluna stickerpro rebuild-index          # 全量重建语义向量
chatluna stickerpro regen-desc <ref>       # 用当前提示词重新生成某张的档案
chatluna stickerpro import [limit]         # 手动导入（见下）
```

## 发送形式说明

- onebot + `deliveryMode=face`：`image` 段 + `sub_type=1`，QQ 客户端按表情包归类显示（私聊/群聊均可）；
- 非 onebot 平台或发送失败：自动退回普通图片；
- 依赖 NapCat 对 `image.sub_type` 的支持（OneBot 子类型 1 = 表情包）。

## 手动导入

把图片放进导入目录（默认 `data/stickerpro-library/temp/`，可在「存储 → 手动导入目录」修改，
支持相对图片库目录或绝对路径；格式 png/jpg/gif/webp/bmp/avif/heic），执行：

```text
chatluna stickerpro import        # 全部导入
chatluna stickerpro import 10     # 只处理前 10 张（按文件名自然排序）
chatluna stickerpro import -r     # 重新生成已有图片的描述与标签（提示词升级后用）
```

- 导入**不经过评审**，但会调用判官模型（`review.model`）生成 description/tags/usageHint；
- 按 pHash 去重：库里已有的图自动跳过，重复执行安全；`-r` 则更新已有档案不动 note/source；
- note 模板可在「存储 → 手动导入 note 模板」自定义（`{file}` 会替换成文件名，留空则不写 note），可写如'这是主人提前导入的表情包，我可以后续自己再调整它的描述'；
- 聊天窗口只回一条“已成功导入 X 张”（刷新为“已成功更新 X 张”），逐张描述与失败明细在日志里；
- 原图原字节入库，`note` 记录原文件名，`source` 标记为 `manual`；
- 原文件保留在 `temp/` 目录，确认无误后可自行清理。

## 开发

```bash
node scripts/build.cjs    # 产出 lib/（CommonJS + d.ts，含类型检查）
node ../../node_modules/tsx/dist/cli.mjs test/smoke.ts   # 冒烟测试（纯函数 + 文案断言）
```

## 更新日志

### 1.3.0

- **被动收集 note 模板**：新增 `collect.noteTemplate`（默认空=不写 note），支持
  `{guild}`（收集群号）、`{date}`（入库日期）占位符；在统一入库出口 `commitCollected` 应用，
  评审补跑/积压处理的被动收藏同样生效；note 会一并进入语义向量文本（旧条目需
  `rebuild-index` 刷新）。
- **调整部分文档**

### 1.2.0

- **主动收藏亲笔建档**：`sticker_save` 不再让判官代写档案——模型以第一人称直接提交
  `description`（必填）/`tags`/`usageHint`/`note`，`descModel` 记为 `chat:<模型名>`；
  移除「主动收藏是否过评审」配置项；取图候选顺延规则改为"最新优先"。
- **主动收藏描述兜底**：新增 `review.saveDescribeFallback`（默认关）——检测到当前聊天模型
  不支持图片输入时，描述/标签改由判官模型生成（note 仍归模型），`descModel` 记为判官模型。
- **建档防臆测**：工具说明与参数描述提醒模型——除非明确知道图中人物是谁，
  否则不要在描述/标签里写推测的角色名、作品或出处。
- **本地路径取图修复**：Windows 盘符路径（`E:\...`）此前被协议正则误判为 URL scheme，
  `fetchImageBytes` 现在先判盘符再判 scheme，NapCat 给出的本地路径可以正常取图。
- **搜索多角度**：`sticker_search` 新增 `field` 参数（tags/description/usage/note），
  关键词打分改为分字段加权（tag×3、描述×2、时机×2、备注×1）；结果行附带使用时机与备注；
  语义档案文本纳入 note。
- **手动导入 note 模板**：新增 `storage.importNote`（默认 `手动导入：{file}`，`{file}` 替换为
  文件名，留空则不写 note），可在配置里改成任意提示语。

### 1.1.0

- **模型重试修复**：`Judge.start()` / `SemanticIndex.start()` 不再被一次性 `started` 掩码锁死；新增
  `chatluna/model-added` 事件驱动 + 3s×10 兜底，判官/向量模型晚就绪时也能恢复。
- **构建修复**：不再生成 `lib/package.json`，修复其 UTF-8 BOM 导致 ChatLuna `createModel`
  报 “model not found” 的问题；`prepack` 强制打包前构建并清理旧文件。
- **手动导入**：新增 `storage.importDir` 配置（支持相对/绝对路径）与 `--refresh`；
  聊天回执不再显示真实路径，只回“已成功导入/更新 X 张”，逐张明细写日志。
- **命令层级修正**：所有管理命令统一为 `chatluna.stickerpro.*`（聊天输入
  `chatluna stickerpro ...`），不再暴露裸命令；根命令补齐描述，`list` 默认显示 10 张、
  支持 `list <数量> [关键词]`。

### 1.0.0

- 插件首次发布
- 插件灵感来源wj6ej3ck6y3（[chatluna-sticker](https://github.com/wj6ej3ck6y3/koishi-plugin-chatluna-sticker)），参考了部分实现思路并优化了实现方式，非常感谢