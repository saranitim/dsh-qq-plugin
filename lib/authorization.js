/** QQ OpenIDs are opaque, case-sensitive identifiers. Never enroll from an inbound message. */
export function validOwner(value) {
  return typeof value === 'string' && value.length > 0 && !/[\s:]/u.test(value)
}

export function validateCredentials({ appId, appSecret, userOpenid }) {
  if (typeof appId !== 'string' || !/^\d+$/.test(appId)) throw new Error('appId 必须是 QQ 机器人的数字 AppID')
  if (typeof appSecret !== 'string' || appSecret.trim() === '') throw new Error('appSecret 不能为空')
  if (!validOwner(userOpenid)) {
    throw new Error('必须提供此机器人绑定用户的完整 userOpenid（不是 QQ 号）；请重新扫码绑定或补齐手动凭据')
  }
}
