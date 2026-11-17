/**
 * 短信 / 截图文字 → 包裹信息。
 *
 * 纯本地正则，不联网。短信样式千奇百怪，这里不追求"全对"，只保证：
 *   1) 拿不准的宁可不取，也不要把手机号/金额/时间当成单号或取件码；
 *   2) 每条结果都带 hits（从哪句抠出来的），失败时能告诉用户"没认出哪一段"。
 */

export interface ParsedPackage {
  /** 运单号（有就是真快递，能直接建包裹） */
  mailNo?: string
  /** 快递公司名 */
  company?: string
  /** 取件码（驿站 6-5-9955 / 柜机 123456 / 字母码 A1B2） */
  code?: string
  /** 驿站/自提点/柜机名 */
  station?: string
  /** 手机尾号（匹配包裹用） */
  tail?: string
  /** 原始文本 */
  raw: string
  /** 命中的证据，界面/通知里显示，方便判断为什么识别失败 */
  hits: string[]
}

/** 快递公司：先看文案里的名字，没有再看单号前缀 */
const COMPANY_WORDS: [RegExp, string][] = [
  [/顺丰|丰声|SFExpress|SF\s*速运/i, "顺丰速运"],
  [/京东|京尊达/i, "京东物流"],
  [/圆通/i, "圆通快递"],
  [/中通/i, "中通快递"],
  [/韵达/i, "韵达快递"],
  [/申通/i, "申通快递"],
  [/极兔|J&T/i, "极兔速递"],
  [/德邦/i, "德邦快递"],
  [/邮政|EMS|中国邮政/i, "EMS"],
  [/百世|汇通/i, "百世快递"],
  [/天天快递/i, "天天快递"],
  [/宅急送/i, "宅急送"],
  [/丰巢/i, "丰巢"],
  [/菜鸟/i, "菜鸟驿站"],
  [/兔喜/i, "兔喜生活"],
  [/中邮|快宝/i, "中邮快递"],
]

/** 单号：带前缀的优先，纯数字放最后（最容易误伤） */
const PREFIX_MAIL: [RegExp, string][] = [
  [/\b(SF\d{10,16})\b/i, "顺丰速运"],
  [/\b(JDV?[A-Z0-9]{9,16})\b/i, "京东物流"],
  [/\b(YT\d{10,16})\b/i, "圆通快递"],
  [/\b(JT\d{10,16})\b/i, "极兔速递"],
  [/\b(DPK[A-Z0-9]{8,16})\b/i, "德邦快递"],
  [/\b([A-Z]{2}\d{9}[A-Z]{2})\b/, "EMS"],
  [/\b(YD\d{10,16})\b/i, "韵达快递"],
  [/\b(STO\d{10,16})\b/i, "申通快递"],
]

/** 取件码：多种写法，按可靠性排 */
const CODE_PATTERNS: [RegExp, string][] = [
  [/(?:取件码|提货码|取货码|自提码|凭码|取件凭证|领取码)[:：\s]*([0-9A-Za-z][0-9A-Za-z\-]{2,14})(?![0-9A-Za-z])/, "取件码"],
  [/凭[:：\s]*([0-9A-Za-z]+(?:-[0-9A-Za-z]+){1,3})(?=\s*[到至去，,。\s])/, "凭…到"],
  [/([0-9]+-[0-9]+-[0-9]{3,6})(?=\s*[到至去，,。\s]|$)/, "数字-数字-尾号"],
  [/(?:柜|格口|箱)[:：\s]*([0-9]{3,8})(?![0-9])/, "柜格口"],
  [/(?:密码|开柜码)[:：\s]*([0-9]{4,8})(?![0-9])/, "开柜码"],
]

/** 尾号：取件人手机尾号，用来匹配已有包裹 */
const TAIL_PATTERNS: RegExp[] = [
  /尾号\s*([0-9]{4})(?![0-9])/,
  /手机尾号\s*([0-9]{4})(?![0-9])/,
  /\(([0-9]{4})\)\s*(?:的|取件|包裹)/,
  /[（(]([0-9]{4})[)）]/,
]

/** 驿站/自提点/柜机名；带权：句式越直白越可信 */
const STATION_PATTERNS: [RegExp, number][] = [
  [/[到至]\s*([^\s，,。；;、]{3,30}?)\s*(?:取|领取|自取)/, 6],
  [/(?:存放至|放至|放置于|已放[到入]|已到达|已送达|已存入)\s*([^\s，,。；;]{2,30})/, 5],
  [/(?:位置|地址|网点)[:：]\s*([^\s，,。；;]{2,40})/, 4],
  [/([\u4e00-\u9fa5A-Za-z0-9]{2,20}(?:驿站|快递柜|自提点|快递超市|便利店|服务站|代收点|兔喜|丰巢))/, 2],
]

/** 句子残片、客服话术、营业说明：它们长得像名词，绝不能当驿站名或地址。
 *  实测踩过：中通短信里的「如遇问题请联系代理点」被当成驿站名，卡片右上角就显示成这一串。 */
const STATION_JUNK = /如遇|请联系|联系|客服|热线|投诉|咨询|致电|电话|短信|退订|回复|截图|截屏|问题|请勿|注意|温馨|谢谢|官方|营业时间|工作时间|全天|自取请|取件请|凭码|凭取件/

/** 这个字符串能不能当驿站名/地址用（导入口、粘贴识别、手工关联都走这一份） */
export function looksLikeStation(s: string): boolean {
  const v = (s ?? "").replace(/\s+/g, " ").trim()
  if (v.length < 2 || v.length > 40) return false
  return !hasStationJunk(v)
}

/** 只判「是不是句子残片/客服话术」，不限长度：清老数据时用（真地址可能很长） */
export function hasStationJunk(s: string): boolean {
  return STATION_JUNK.test(s ?? "")
}

/** 从所有候选里挑最像驿站名的一个（短信里「已到X」「【菜鸟驿站】」会同时出现） */
function bestStation(text: string): string | undefined {
  const cands: { s: string; base: number }[] = []
  for (const [re, base] of STATION_PATTERNS) {
    const g = new RegExp(re.source, "g")
    for (const m of text.matchAll(g)) {
      let s = (m[1] || "").trim().replace(/[，,。；;、]+$/, "")
      // 贪婪匹配会把句首的“您的包裹已到”一起吃进来，切掉它
      const cut = s.replace(/^(?:您的|你的)?(?:包裹|快件|快递|订单)?(?:已经|已)?(?:到达|送到|存放至|放至|放置于|送达|存入|到了|到)\s*/, "")
      if (cut.length >= 3 && cut !== s) s = cut
      // 泛词本身不是驿站名（"已到自提点，提货码 1234"）
      if (/^(驿站|自提点|快递柜|快递超市|便利店|代收点|柜|快递驿站|快递点|服务点)$/.test(s)) continue
      if (s.length >= 3 && s.length <= 30 && looksLikeStation(s)) cands.push({ s, base })
    }
  }
  const score = (s: string, base: number): number => {
    let n = base
    if (/驿站|快递柜|自提点|超市|便利店|服务站|代收点|柜|店|中心/.test(s)) n += 3
    // 把句子当成了名字："您的订单已到自提点""请到驿站取件"
    if (/您的|你的|订单|快件已|包裹已|快递已|已到|已经|请到|请至|可到|尽快/.test(s)) n -= 6
    if (!looksLikeStation(s)) n -= 20
    if (s.length >= 4 && s.length <= 20) n += 1
    return n
  }
  let best: string | undefined
  let bestScore = 0
  for (const c of cands) {
    const sc = score(c.s, c.base)
    if (sc > bestScore || (sc === bestScore && best && sc > 0 && c.s.length > best.length)) {
      bestScore = sc
      best = c.s
    }
  }
  return bestScore > 0 ? best : undefined
}

/** 明显的噪声：手机号、金额、日期、订单号（平台单号不是运单号） */
function isNoise(v: string): boolean {
  const s = (v || "").trim()
  if (!s) return true
  if (/^1[3-9]\d{9}$/.test(s)) return true            // 手机号
  if (/^\d{1,2}:\d{2}$/.test(s)) return true          // 时间
  if (/^\d{4}[-/年]\d{1,2}[-/月]\d{1,2}日?$/.test(s)) return true  // 日期
  if (/^\d+(\.\d+)?$/.test(s) && s.length <= 3) return true        // 金额/数量
  if (/^\d{4}-\d{4}-\d{4}-\d{4}$/.test(s)) return true            // 卡号形态
  return false
}

/** 纯数字长串可能是运单号（12-20 位），也可能是取件码/手机号，靠长度与上下文区分 */
function looksLikeMailNo(v: string): boolean {
  const s = (v || "").trim()
  if (!/^\d{12,20}$/.test(s)) return false
  if (/^1[3-9]\d{9}$/.test(s)) return false
  return true
}

function normalizeCode(v: string): string {
  return (v || "").trim().replace(/^[：:\s]+/, "").replace(/[。，,；;]+$/, "")
}

export function parseDeliveryText(input: string): ParsedPackage {
  const raw = String(input ?? "").replace(/\r/g, "")
  // 全角数字/横杠统一，短信里经常混着全角
  const text = raw
    .replace(/[\uFF01-\uFF5E]/g, ch => String.fromCharCode(ch.charCodeAt(0) - 0xFEE0))
    .replace(/[－—–]/g, "-")
  const hits: string[] = []
  const out: ParsedPackage = { raw, hits }

  // 1) 运单号：带前缀的先认，认到了顺带确定公司
  for (const [re, company] of PREFIX_MAIL) {
    const m = text.match(re)
    if (m && m[1] && !isNoise(m[1])) {
      out.mailNo = m[1].toUpperCase()
      out.company = company
      hits.push(`单号 ${m[1]}（${company}）`)
      break
    }
  }

  // 2) 公司名：文案里写的比单号前缀更可信（文案会直接说"圆通快递"）
  for (const [re, name] of COMPANY_WORDS) {
    if (re.test(text)) {
      out.company = out.company || name
      hits.push(`公司 ${name}`)
      break
    }
  }

  // 3) 取件码
  for (const [re, label] of CODE_PATTERNS) {
    const m = text.match(re)
    if (!m || !m[1]) continue
    const code = normalizeCode(m[1])
    if (!code || isNoise(code)) continue
    // 取件码不会等于运单号
    if (out.mailNo && code.toUpperCase() === out.mailNo.toUpperCase()) continue
    out.code = code
    hits.push(`取件码 ${code}（${label}）`)
    break
  }

  // 4) 没有前缀单号时，再从长数字里找运单号（不能是刚认出的取件码）
  if (!out.mailNo) {
    const cands = [...text.matchAll(/\b(\d{12,20})\b/g)].map(m => m[1])
    for (const c of cands) {
      if (!looksLikeMailNo(c)) continue
      if (out.code && c === out.code.replace(/-/g, "")) continue
      out.mailNo = c
      hits.push(`单号 ${c}`)
      break
    }
  }

  // 5) 尾号
  for (const re of TAIL_PATTERNS) {
    const m = text.match(re)
    if (m && m[1]) {
      out.tail = m[1]
      hits.push(`尾号 ${m[1]}`)
      break
    }
  }

  // 6) 驿站/自提点
  const st = bestStation(text)
  if (st && !(out.code && st.includes(out.code))) {
    out.station = st
    hits.push(`驿站 ${st}`)
  }

  return out
}

/** 给界面/通知用的一句话结论 */
export function summarizeParsed(p: ParsedPackage): string {
  const bits: string[] = []
  if (p.code) bits.push(`取件码 ${p.code}`)
  if (p.mailNo) bits.push(`单号 ${p.mailNo}`)
  if (p.station) bits.push(p.station)
  if (p.company) bits.push(p.company)
  if (bits.length === 0) return "未识别到包裹信息"
  return bits.join(" · ")
}
