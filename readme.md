# koishi-plugin-chatluna-stickerpro

[![npm](https://img.shields.io/npm/v/koishi-plugin-chatluna-stickerpro?style=flat-square)](https://www.npmjs.com/package/koishi-plugin-chatluna-stickerpro)

为模型提供智能表情包收藏与发送工具：被动收集群里的表情（pHash 去重 + 判官模型评审），
五个模型工具——`sticker_search`（语义/关键词检索）、`sticker_peek`（base64 内联，真的看见图）、
`sticker_send`（NapCat 私聊/群聊以表情包形式发送，失败自动降级图片）、`sticker_save`（主动收藏）、
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
| 存储 | 图片库目录、手动导入目录 |
| 被动收集 | 开关、群列表、计数阈值、pHash 合并半径、记录 TTL |
| 评审与档案 | 评审开关、判官模型、可自定义的评审/描述提示词、主动收藏是否把关 |
| 表情库 | 收藏上限（LRU 淘汰） |
| 语义检索 | 向量模型、相似度阈值 |
| 发送 | 表情包形式/图片形式、同会话防重复冷却 |
| 看图 | 内联开关、单图上限（超限先压缩再降级文字）、无视觉时自动补写描述 |
| 调试 | 详细日志（完整 prompt、交付链选择等） |

GIF 喂给判官模型时：≤5MB 原样直传（模型原生支持动图），更大或直传失败自动按帧序等间隔抽 9 帧转多图输入；
`sticker_peek` 给主模型的仍是原 GIF。

## 管理命令

均为管理员权限（authority 2），`<ref>` 接受 pHash 前缀：

```text
chatluna.stickerpro/status                 # 库规模、评审状态分布、索引情况
chatluna.stickerpro/list [keyword]         # 浏览收藏（关键词过滤，最近 20 张）
chatluna.stickerpro/show <ref>             # 把某张表情发到当前会话预览
chatluna.stickerpro/delete <ref> [-y]      # 删除（档案 + 文件 + 向量）
chatluna.stickerpro/retry <ref>            # 重新评审 judge_failed 的记录
chatluna.stickerpro/rebuild-index          # 全量重建语义向量
chatluna.stickerpro/regen-desc <ref>       # 用当前提示词重新生成某张的档案
chatluna.stickerpro/import [limit]         # 手动导入（见下）
```

## 发送形式说明

- onebot + `deliveryMode=face`：`image` 段 + `sub_type=1`，QQ 客户端按表情包归类显示（私聊/群聊均可）；
- 非 onebot 平台或发送失败：自动退回普通图片；
- 依赖 NapCat 对 `image.sub_type` 的支持（OneBot 子类型 1 = 表情包）。

## 手动导入

把图片放进导入目录（默认 `data/stickerpro-library/temp/`，可在「存储 → 手动导入目录」修改，
支持相对图片库目录或绝对路径；格式 png/jpg/gif/webp/bmp/avif/heic），执行：

```text
chatluna.stickerpro.import        # 全部导入
chatluna.stickerpro.import 10     # 只处理前 10 张（按文件名自然排序）
chatluna.stickerpro.import -r     # 重新生成已有图片的描述与标签（提示词升级后用）
```

- 导入**不经过评审**，但会调用判官模型（`review.model`）生成 description/tags/usageHint；
- 按 pHash 去重：库里已有的图自动跳过，重复执行安全；`-r` 则更新已有档案不动 note/source；
- 原图原字节入库，`note` 记录原文件名，`source` 标记为 `manual`；
- 原文件保留在 `temp/` 目录，确认无误后可自行清理。

## 开发

```bash
node scripts/build.cjs    # 产出 lib/（CommonJS + d.ts，含类型检查）
node ../../node_modules/tsx/dist/cli.mjs test/smoke.ts   # 冒烟测试（纯函数 + 文案断言）
```
