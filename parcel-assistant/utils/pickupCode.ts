/**
 * 从物流文案里取取件码。
 *
 * 常见写法（快递鸟/各快递的轨迹里都出现过）：
 *   取件码：8823 / 取件码为 8-4-2019 / 取件码【A-12-345】 / 取件码是 1234
 *   凭取件码 123456 领取 / 凭取件码领取
 *   取货码：1234 / 提货码 / 领件码 / 包裹码 / 拾取码
 *   丰巢：凭取件码 3-1-2043 到丰巢快递柜取件
 *   菜鸟驿站：凭取件码 5-2-3001 至菜鸟驿站（xxxx店）领取
 *
 * 注意：
 *  - 「凭取件码在【XX路2号店】领取」这种没有码，不能把地址里的数字抓走
 *  - 11 位手机号形态的串不当取件码（那是电话）
 *  - 同一段文本命中多个候选时打分：格式特征（3-4段横线/柜机字母段）加分，
 *    纯年份、纯递增流水减分；分数最高的当选。
 */
import { normalizePickupCode } from "./codes"

/** 看起来像手机号的串：11 位、1[3-9] 开头 */
function looksLikeMobile(s: string): boolean {
  return /^1[3-9]\d{9}$/.test(s.replace(/[\s-]/g, ""))
}

/** 从单段文本里取一个取件码（多候选打分择优） */
export function pickupCodeInText(text: string): string {
  const src = String(text || "")
  if (!src) return ""
  // 关键词后面 0-6 个非字母数字字符，再跟候选码。
  // 「提货码」「领件码」「包裹码」「柜机码」是丰巢/驿站文案里的同义词。
  // 关键词：强词（码/号/密码/凭证）直接命中；sloth-express 的分级策略。
  const kws = ["取件码", "取货码", "取件号", "取件密码", "提货码", "取货密码", "取件凭证", "领件码", "包裹码", "柜机码", "取件口令"]
  const candRe = /([0-9A-Za-z][0-9A-Za-z\-]*)/
  type Hit = { raw: string; score: number }
  const hits: Hit[] = []
  for (const kw of kws) {
    let idx = src.indexOf(kw)
    while (idx >= 0) {
      // 窗口要够长：三段式码 8-10 字符 + 前缀符号，太短会把尾段切掉（曾用 8 导致 5-2-3001 → 5-2-300）
      const after = src.slice(idx + kw.length, idx + kw.length + 20)
      // 关键词后必须紧跟（≤6个非字母数字字符内）出现候选码，否则视为「凭取件码…领取」式空话
      const m = /^[^0-9A-Za-z]{0,6}/.exec(after)
      const rest = after.slice(m ? m[0].length : 0)
      const cm = candRe.exec(rest)
      if (cm && cm[1]) {
        const raw = cm[1].replace(/[-\s]+$/, "").trim()
        let ok = true
        let score = 1
        if (raw.length < 3 || raw.length > 20) ok = false
        if (looksLikeMobile(raw)) ok = false
        if (/^(19|20)\d{2}(-\d{1,2})?$/.test(raw)) ok = false
        // sloth-express 的负向排除：验证码/付款码类，以及金额/订单类上下文里的数字
        if (/验证码|校验码|短信验证|语音验证|支付密码|付款码|动态密码/.test(src)) ok = false
        if (ok) {
          // 打分：三段式 5-2-3001 / A-12-345 是驿站柜机最常见形态，强信号
          if (/^\d{1,3}-\d{1,3}-\d{1,4}$/.test(raw)) score += 3
          if (/^[A-Z]{1,3}\d{4,10}$/.test(raw)) score += 2
          if (/^[A-Z]-\d{1,2}-\d{3,4}$/.test(raw)) score += 3
          // 带横线的短码通常比长数字串更像码
          if ((raw.match(/-/g) ?? []).length >= 1 && raw.length <= 12) score += 1
          // 纯 6 位流水弱一档（可能是单号尾段），但仍可能就是码
          if (/^\d{6}$/.test(raw)) score -= 1
          hits.push({ raw, score })
        }
      }
      idx = src.indexOf(kw, idx + kw.length)
    }
  }
  // 旧格式「凭 X 领取」兼容：只在没有任何关键词命中时兜底
  if (hits.length === 0) {
    const m = /凭[^0-9]{0,6}([0-9][0-9-]{3,15})/.exec(src)
    if (m && m[1]) {
      const raw = m[1].replace(/[-\s]+$/, "").trim()
      if (raw.length >= 3 && !looksLikeMobile(raw) && !/^(19|20)\d{2}(-\d{1,2})?$/.test(raw)
        && !/验证码|校验码|短信验证|支付密码|付款码/.test(src)) {
        hits.push({ raw, score: 1 })
      }
    }
  }
  if (hits.length === 0) return ""
  hits.sort((a, b) => b.score - a.score)
  const norm = normalizePickupCode(hits[0].raw)
  return norm || ""
}


/** 从轨迹节点里取（新的优先） */
export function extractPickupCode(nodes: { text: string }[]): string {
  for (let i = nodes.length - 1; i >= 0; i--) {
    const c = pickupCodeInText(nodes[i]?.text ?? "")
    if (c) return c
  }
  return ""
}
