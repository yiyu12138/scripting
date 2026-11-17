/**
 * 同一个包裹可能被多个平台同时同步到（淘宝/京东/拼多多绑同一个手机号），
 * 有的平台给取件码、有的不给，甚至给的不一样。
 * 这里负责把「已知的码」和「新识别到的码」合并成一条，不丢信息。
 */

/** 比较用：忽略空格/连字符，全角转半角，"6-3-0921" === "630921" === "６-３-０９２１" */
export function codeKey(s: string): string {
  return (s ?? "")
    .replace(/[\uFF01-\uFF5E]/g, ch => String.fromCharCode(ch.charCodeAt(0) - 0xFEE0))
    .replace(/[\s\-－—_]/g, "")
    .toUpperCase()
}

/**
 * 各平台给的原始值里常带「取件码」前缀与占位词（NEEDSMS、待出码、暂无…），
 * 有时还整句中文。统一在这里洗干净：洗不出来就返回空串，别把垃圾当码存进包裹。
 */
const PLACEHOLDER = /^(needsms|need\s*sms|none|null|undefined|待出码|待生成|暂无|无|--|—|\/|0)$/i

export function normalizePickupCode(raw: any): string {
  let v = String(raw ?? "").trim()
  if (!v) return ""
  // 正面去前缀（可能带冒号/空格），反复去一次就够
  v = v.replace(/^(取件码|提货码|取货码|自提码|凭码)[:：\s]*/g, "").trim()
  if (PLACEHOLDER.test(v)) return ""
  // 码只会是字母数字（可带连字符/下划线）：驿站常见 “6-2-1234”“3-4-5678”，快递柜常见纯数字
  if (!/^[A-Za-z0-9][A-Za-z0-9\-_]{1,19}$/.test(v)) return ""
  return v
}

/**
 * 合并取件码：保留顺序，去重，最多 3 个。
 * 第一个永远是卡片主码（新出现的码如果主码还没有就补成主码）。
 */
export function mergeCodes(existing: (string | undefined)[] | undefined, ...adds: (string | undefined)[]): string[] {
  const out: string[] = []
  for (const raw of [...(existing ?? []), ...adds]) {
    const v = normalizePickupCode(raw)
    if (!v) continue
    const k = codeKey(v)
    if (!k) continue
    if (out.some(x => codeKey(x) === k)) continue
    out.push(v)
  }
  return out.slice(0, 3)
}

/** 卡片上除了主码之外还要展示的码 */
export function extraCodes(codes: string[] | undefined, main: string): string[] {
  if (!codes || codes.length < 2) return []
  const k = codeKey(main)
  return codes.filter(c => codeKey(c) !== k).slice(0, 2)
}
