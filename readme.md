# koishi-plugin-chatluna-stickerpro

[![npm](https://img.shields.io/npm/v/koishi-plugin-chatluna-stickerpro?style=flat-square)](https://www.npmjs.com/package/koishi-plugin-chatluna-stickerpro)

为模型提供智能表情包收藏与发送工具：被动收集群里的表情（pHash 去重 + 判官模型评审），
五个模型工具——`sticker_search`（语义/关键词检索）、`sticker_peek`（base64 内联，真的看见图）、
`sticker_send`（NapCat 私聊/群聊以表情包形式发送，失败自动降级图片）、`sticker_save`（主动收藏）、
`sticker_update`（模型自己修正描述/标签/使用时机）。
表情档案刻意保持"简洁"：只记氛围、用途与可见文字，不猜角色身份或作品来源；细节由主模型自己看图确认。
自研内存向量索引，无 WASM 并发问题，不需要 isolate-loader。

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
- GIF ≤5MB 直接交给模型（实测可识别动作）；>5MB 才按帧序等间隔抽 9 帧，概括动作与循环；
- 原图原字节入库，`note` 记录原文件名，`source` 标记为 `manual`；
- 原文件保留在 `temp/` 目录，确认无误后可自行清理。

## 开发

```bash
node scripts/build.cjs   # 产出 lib/（CommonJS + d.ts）
```
