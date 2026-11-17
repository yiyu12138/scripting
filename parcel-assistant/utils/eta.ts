/**
 * 从物流/平台文案里抽「预计送达」。
 * 各家说法不一样，这里只做展示用的一句话，不做日期计算：
 *   预计11月9日发货，11月11日送达
 *   预计 11-13 送达
 *   预计明天送达
 * 返回 undefined 表示这条没有预计信息（快递鸟 8001 等接口本来就不给）。
 */
export interface EtaInfo {
  /** 原话，如「预计11月13日送达」 */
  text: string
  /** 解析出的到达日期（毫秒）；只要「发货」日期或已过期的文案返回 undefined */
  at?: number
}

/**
 * 把预估文案解成具体日期，供卡片显示「预计 11月13日」。
 * 规则：
 *  - 只认带「送达/到达/派送」的那句；只有「预计X日发货」不算到货时间
 *  - 支持 11月13日 / 11-13 / 今天 / 明天 / 后天
 *  - 跨年：解析出的时间比现在早 10 天以上就当明年（12 月的「预计1月2日送达」）
 *  - 过期超过 2 天或超过 60 天的不返回：旧文案不能当成新的预计
 */
export function etaTimeInText(text: string, now = Date.now()): EtaInfo | undefined {
  const t = (text || "").replace(/\s+/g, " ").trim()
  if (!t || !t.includes("预计")) return undefined
  // 只取含「预计」且带到达词的片段
  const seg = (() => {
    const m = t.match(/预计[^。；\n]{0,30}?(?:送达|到达|派送)[^。；\n]{0,12}/)
    if (m) return m[0]
    const s = t.match(/预计[^。；\n]{0,30}/)
    return s ? s[0] : ""
  })()
  if (!seg) return undefined
  if (!/送达|到达|派送/.test(seg)) return undefined

  let at = 0
  const today = new Date(now)
  const base = new Date(today.getFullYear(), today.getMonth(), today.getDate()).getTime()
  if (/今天|今日/.test(seg)) at = base
  else if (/明天/.test(seg)) at = base + 86_400_000
  else if (/后天/.test(seg)) at = base + 2 * 86_400_000
  else {
    // 「预计11月9日发货，11月11日送达」：取最后一个日期（送达日），不是发货日
    const all = [...seg.matchAll(/(\d{1,2})\s*[月\-\/]\s*(\d{1,2})/g)]
    if (all.length === 0) return undefined
    const md = all[all.length - 1]
    const mon = Number(md[1]) - 1
    const day = Number(md[2])
    if (mon < 0 || mon > 11 || day < 1 || day > 31) return undefined
    at = new Date(today.getFullYear(), mon, day).getTime()
    if (at < now - 10 * 86_400_000) at = new Date(today.getFullYear() + 1, mon, day).getTime()
  }
  if (!at) return undefined
  if (at < now - 2 * 86_400_000 || at > now + 60 * 86_400_000) return { text: seg }
  return { text: seg, at }
}

/**
 * 从平台原始数据里扫「预计…送达」。
 * 各家字段名不一致（timeForecast / predictTime / desc…），
 * 所以不猜字段名，只在浅层值里找带「预计 + 到达词」的字符串。
 */
export function etaInObject(obj: any, depth = 2): string | undefined {
  const seen = new Set<any>()
  const walk = (v: any, d: number): string | undefined => {
    if (v == null || d < 0) return undefined
    if (typeof v === "string") return etaInText(v)
    if (typeof v !== "object") return undefined
    if (seen.has(v)) return undefined
    seen.add(v)
    const vals: any[] = Array.isArray(v) ? v.slice(0, 20) : Object.values(v).slice(0, 30)
    for (const x of vals) {
      const hit = walk(x, d - 1)
      if (hit) return hit
    }
    return undefined
  }
  return walk(obj, depth)
}

export function etaInText(text: string): string | undefined {
  const t = (text || "").replace(/\s+/g, " ").trim()
  if (!t || !t.includes("预计")) return undefined

  const clip = (s: string) => {
    const v = s.replace(/\s*[，,、]\s*$/, "").trim()
    return v.length > 30 ? v.slice(0, 30) : v
  }

  // 「预计X日发货，Y日送达」——整段最有用，先抓这个
  const shipAndArrive = t.match(/预计[^。；\n]{0,18}?发货[^。；\n]{0,18}?(?:送达|到达|派送)/)
  if (shipAndArrive) return clip(shipAndArrive[0])

  const m = t.match(/预计[^。；\n]{0,26}?(?:送达|到达|派送|发货)/)
  if (!m) return undefined
  // 「预计送达时间：…」是标题，不是内容
  if (/^预计(?:送达|到达|派送)/.test(m[0])) return undefined
  return clip(m[0])
}
