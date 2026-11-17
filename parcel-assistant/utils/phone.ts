/**
 * 从物流文案里找可拨电话。
 *
 * 物流短信里的号码常被换行/空格断开（"18\n925319893"、"1314404584\n1"），
 * 所以每一位之间允许夹一个空白或横线；显示时再去掉空白。
 *
 * 不认「号段说明」：像「95161和18521号段」里的 18521 不是完整号码，
 * 点亮了也打不出去，所以手机号必须凑满 11 位。
 */
export interface PhoneSpan {
  /** 在原文中的起始下标 */
  start: number
  /** 在原文中的结束下标（不含） */
  end: number
  /** 去掉空白后的可拨号码 */
  phone: string
}

const PHONE_RE = new RegExp(
  [
    // 手机：1 + 3-9 + 9 位（共 11 位），每位前可带一个空白/横线
    "1[3-9](?:[-\\s]?\\d){9}",
    // 400 / 800 企业号：3 + 7 位
    "(?:400|800)(?:[-\\s]?\\d){7}",
    // 区号座机：0xx(x) + 7-8 位
    "0\\d{2,3}(?:[-\\s]?\\d){7,8}",
    // 95 / 96 客服短号
    "9[5-6]\\d{3,5}(?=\\D|$)",
  ].join("|"),
  "g",
)

export function phoneSpans(text: string, limit = 3): PhoneSpan[] {
  const src = text || ""
  const out: PhoneSpan[] = []
  const seen = new Set<string>()
  PHONE_RE.lastIndex = 0
  let m: RegExpExecArray | null
  while ((m = PHONE_RE.exec(src)) != null) {
    if (out.length >= limit) break
    const phone = m[0].replace(/[\s-]+/g, "")
    // 「95161和18521号段」这类短数字是号段说明，不是可拨号码（只对短号做判断，11 位手机不受影响）
    if (phone.length <= 6 && src.slice(m.index, m.index + m[0].length + 14).includes("号段")) continue
    // 手机/座机 ≥10 位，95/96 客服短号只有 5-6 位，所以下限取 5
    if (phone.length < 5 || seen.has(phone)) continue
    seen.add(phone)
    out.push({ start: m.index, end: m.index + m[0].length, phone })
  }
  return out
}
