// 发送通道（设计 §7；2026-10-31 初版，2026-11-06 按实测修订）
//
// NapCat 的接口清单里没有 send_group_face / send_private_face，本地图要以"表情包"呈现，
// 只能发 image 消息段 + sub_type=1（OneBot 子类型 1=表情包；私聊/群聊都生效，数字/字符串均可）。
//
// 关键坑（2026-11-06 定位）：不能走 session.send(element)。
// Satori 的 h.normalize 会把元素序列化成 `<img ... sub-type="1"/>`，adapter-onebot 再原样
// 塞进消息段时字段名变成 sub-type，NapCat 只认蛇形 sub_type，于是静默退化成普通图片。
// 因此 onebot 的表情包发送直接调用 bot.internal 的 sendPrivateMsg / sendGroupMsg，
// 传纯 OneBot 段（base64:// + sub_type），绕开元素序列化。
//
// 失败/非 onebot 平台仍退回普通图片、再退回文件，确保"至少把图发出去"。

import type { Logger, Session } from 'koishi'
import { h } from 'koishi'
import type { Config } from './config'
import type { DeliveryChannel } from './types'

export interface DeliverResult {
  ok: boolean
  channel: DeliveryChannel
  /** 失败时给模型/日志的原因（第一人称文案） */
  reason?: string
}

export function imageDataUrl(bytes: Buffer, mime: string): string {
  return `data:${mime};base64,${bytes.toString('base64')}`
}

/**
 * 直接走 OneBot 原始接口发表情包段。
 * 返回 false 表示当前 adapter 没有可用的 internal 接口，由调用方降级。
 */
async function sendStickerSegment(session: Session, bytes: Buffer): Promise<boolean> {
  const internal: any = (session.bot as any)?.internal
  if (!internal) return false

  const segment = [
    {
      type: 'image',
      data: {
        file: `base64://${bytes.toString('base64')}`,
        sub_type: 1,
      },
    },
  ]

  if (session.isDirect) {
    const userId = String(session.channelId ?? '').replace(/^private:/, '')
    if (!userId || typeof internal.sendPrivateMsg !== 'function') return false
    await internal.sendPrivateMsg(userId, segment)
    return true
  }

  const groupId = String(session.guildId ?? '')
  if (!groupId || typeof internal.sendGroupMsg !== 'function') return false
  await internal.sendGroupMsg(groupId, segment)
  return true
}

export async function deliverSticker(
  config: Config,
  session: Session,
  bytes: Buffer,
  mime: string,
  logger: Logger,
): Promise<DeliverResult> {
  const wantSticker = config.sending.mode === 'face'
  // NapCat 私聊/群聊都认 image.sub_type=1；其它 onebot 实现不支持时最多显示成普通图片。
  const canSticker = session.platform === 'onebot'

  if (wantSticker && canSticker) {
    try {
      if (!(await sendStickerSegment(session, bytes))) {
        throw new Error('当前 OneBot 适配器没有 internal 发送接口')
      }
      logger.debug('[delivery] 表情包形式发送成功（OneBot image + sub_type=1）')
      return { ok: true, channel: 'sticker' }
    } catch (e) {
      logger.debug(`[delivery] 表情包形式失败（${e instanceof Error ? e.message : String(e)}），降级普通图片`)
    }
  } else if (wantSticker) {
    logger.debug('[delivery] 非 onebot 平台不支持表情包子类型，直接普通图片')
  }

  // 图片通道：真实 mime 的 dataURI（修复旧版硬编码 png）
  const dataUri = imageDataUrl(bytes, mime)
  try {
    await session.send(h.image(dataUri))
    return { ok: true, channel: 'image' }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    logger.debug(`[delivery] 图片通道失败（${msg}），尝试 file 元素兜底`)
  }

  try {
    await session.send(h.file(dataUri, { name: `sticker.${mime.split('/')[1] ?? 'png'}` }))
    return { ok: true, channel: 'file' }
  } catch (e) {
    return { ok: false, channel: 'image', reason: e instanceof Error ? e.message : String(e) }
  }
}
