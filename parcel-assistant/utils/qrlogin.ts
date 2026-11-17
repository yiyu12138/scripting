// 淘宝扫码登录（纯原生，不依赖 WebView / 不需要输入密码）
//
// 协议来源：polygongfw/pickup-assistant、mykohuang/kuaidi-skill 的实测实现，本轮已逐条复核：
//   GET  login.taobao.com/havanaone/loginLegacy/qrCode/generate.do?bizEntrance=taobao_h5&bizName=taobao
//        → content.data.{t, ck, codeContent}，并下发 cookie2 / XSRF-TOKEN
//   POST login.taobao.com/havanaone/loginLegacy/qrCode/query.do?bizEntrance=taobao_h5&bizName=taobao
//        form: t & ck & ua & navlanguage & navUserAgent & navPlatform    ← 只认 POST，GET 直接 EXPIRED
//        → qrCodeStatus: NEW | SCANED | CONFIRMED | EXPIRED | CANCELED
//   CONFIRMED 后要把 asyncUrls / redirectUrl 等收尾 URL 都走一遍，
//   剩下的登录 cookie（unb / _nk_ / sgcookie / lgc …）在那些响应里。
//
// 实测（2026-11-14）：用 fetch 请求这两个接口，Set-Cookie 可以直接从响应头读出来，
// 所以整条链路不需要 WebView，也就不受“登录页里 JS 注入失效”的影响。
import { COOKIE_KEY } from "./model"

const UA = "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1"
const GEN = "https://login.taobao.com/havanaone/loginLegacy/qrCode/generate.do?bizEntrance=taobao_h5&bizName=taobao"
const QRY = "https://login.taobao.com/havanaone/loginLegacy/qrCode/query.do?bizEntrance=taobao_h5&bizName=taobao"
const REFERER = "https://login.taobao.com/member/login.jhtml"

const delay = (ms: number) => new Promise<void>(r => (setTimeout as any)(r, ms))
function cap<T>(p: Promise<T>, ms: number, fallback: T): Promise<T> {
  return Promise.race([p, delay(ms).then(() => fallback) as any])
}

export type QrCookie = { name: string; value: string; domain: string; path: string }
export type QrStatus = "NEW" | "SCANED" | "CONFIRMED" | "EXPIRED" | "CANCELED" | "ERROR"
export type QrTicket = { t: number; ck: string; content: string }

/** 会话 cookie 罐：把每个响应的 Set-Cookie 收进来，后续请求带上 */
export class Jar {
  private list: QrCookie[] = []

  header(host: string): string {
    return this.list
      .filter(c => host.endsWith(c.domain.replace(/^\./, "")) || c.domain === "")
      .map(c => `${c.name}=${c.value}`)
      .join("; ")
  }

  absorb(raw: string | null) {
    if (!raw) return
    // 一个响应可能有多条 Set-Cookie，用逗号分隔但 Expires 里也有逗号，按 ", xxx=" 切
    const parts = raw.split(/,(?=\s*[A-Za-z0-9_\-]+=)/)
    for (const part of parts) {
      const seg = part.trim()
      if (!seg) continue
      const kv = seg.split(";")[0]
      const eq = kv.indexOf("=")
      if (eq <= 0) continue
      const name = kv.slice(0, eq).trim()
      const value = kv.slice(eq + 1).trim()
      if (!name) continue
      const dom = /domain=([^;]+)/i.exec(seg)?.[1]?.trim() || ".taobao.com"
      const path = /path=([^;]+)/i.exec(seg)?.[1]?.trim() || "/"
      const i = this.list.findIndex(c => c.name === name && c.domain === dom)
      const item = { name, value, domain: dom, path }
      if (i >= 0) this.list[i] = item
      else this.list.push(item)
    }
  }

  all(): QrCookie[] { return this.list.slice() }
  get isEmpty() { return this.list.length === 0 }

  /** 把罐里的 cookie 合并进淘宝登录态（同名同域覆盖） */
  saveToKeychain() {
    let existing: any[] = []
    try {
      const raw = Keychain.get(COOKIE_KEY)
      const v = raw ? JSON.parse(raw) : []
      existing = Array.isArray(v) ? v : []
    } catch { }
    const merged = existing.slice()
    for (const c of this.list) {
      if (!/taobao\.com$|tmall\.com$|alibaba\.com$/i.test(c.domain.replace(/^\./, ""))) continue
      const i = merged.findIndex((k: any) => k?.name === c.name && String(k?.domain || "") === c.domain)
      const item = { name: c.name, value: c.value, domain: c.domain, path: c.path, isSecure: true }
      if (i >= 0) merged[i] = { ...merged[i], ...item }
      else merged.push(item)
    }
    try { Keychain.set(COOKIE_KEY, JSON.stringify(merged)) } catch { }
  }
}

function hostOf(url: string): string {
  try { return new URL(url).hostname } catch { return "" }
}

async function get(jar: Jar, url: string, init?: any): Promise<{ status: number; text: string; location: string }> {
  const fx: any = (globalThis as any).fetch
  const host = hostOf(url)
  const h: Record<string, string> = {
    "User-Agent": UA, Referer: REFERER, Accept: "application/json, text/plain, */*",
  }
  const ck = jar.header(host)
  if (ck) h.Cookie = ck
  const res = await cap(fx(url, { ...(init || {}), headers: { ...h, ...(init?.headers || {}) } }), 20000, undefined as any)
  if (!res) return { status: 0, text: "", location: "" }
  try { jar.absorb(String(res.headers.get("set-cookie") || "")) } catch { }
  let text = ""
  try { text = String(await cap(res.text(), 15000, "") || "") } catch { }
  let location = ""
  try { location = String(res.headers.get("location") || "") } catch { }
  return { status: res.status, text, location }
}

/** 申请二维码 */
export async function qrGenerate(jar: Jar): Promise<QrTicket | null> {
  const r = await get(jar, GEN)
  if (!r.text) return null
  try {
    const j = JSON.parse(r.text)
    const d = j?.content?.data
    if (!d?.ck || !d?.codeContent) return null
    return { t: Number(d.t), ck: String(d.ck), content: String(d.codeContent) }
  } catch {
    // 少数情况下返回 XML 包装，用正则兜底
    const ck = /<ck>([^<]+)<\/ck>/.exec(r.text)?.[1]
    const content = /<codeContent>(?:<!\[CDATA\[)?([^<\]]+)/.exec(r.text)?.[1]
    const t = /<t>(\d+)<\/t>/.exec(r.text)?.[1]
    if (!ck || !content) return null
    return { t: Number(t || Date.now()), ck, content }
  }
}

function field(text: string, key: string): string {
  const re = new RegExp(`<${key}>(?:<!\\[CDATA\\[)?([^<\\]]+)`)
  return re.exec(text)?.[1]?.trim() || ""
}

function statusOf(text: string): QrStatus {
  let raw = ""
  try {
    const j = JSON.parse(text)
    raw = String(j?.content?.data?.qrCodeStatus || "")
  } catch {
    raw = field(text, "qrCodeStatus")
  }
  const s = raw.toUpperCase()
  if (s === "NEW" || s === "SCANED" || s === "CONFIRMED" || s === "EXPIRED" || s === "CANCELED") return s
  return "ERROR"
}

/** 查一次状态 */
export async function qrQuery(jar: Jar, ticket: QrTicket): Promise<{ status: QrStatus; text: string }> {
  const form = `t=${encodeURIComponent(String(ticket.t))}&ck=${encodeURIComponent(ticket.ck)}&ua=` +
    `&navlanguage=${encodeURIComponent("zh-CN")}&navUserAgent=${encodeURIComponent(UA)}` +
    `&navPlatform=${encodeURIComponent("Linux armv8l")}`
  const r = await get(jar, QRY, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8" },
    body: form,
  })
  return { status: statusOf(r.text), text: r.text }
}

/** 从 CONFIRMED 的响应里挑出收尾 URL，逐个访问把 cookie 收齐 */
function completionUrls(text: string): string[] {
  const out: string[] = []
  const push = (u: string) => {
    const s = (u || "").trim()
    if (s.startsWith("http://") || s.startsWith("https://")) if (!out.includes(s)) out.push(s)
  }
  for (const key of ["asyncUrls", "miniLogouts", "miniVsts", "redirectUrl", "replaceUrl", "parentRedirectUrl", "iframeRedirectUrl"]) {
    const re = new RegExp(`<${key}>([\\s\\S]*?)</${key}>`)
    const block = re.exec(text)?.[1] || ""
    const urls = block.match(/https?:\/\/[^\s<>"']+/g)
    if (urls) urls.forEach(push)
  }
  // JSON 形态
  try {
    const j = JSON.parse(text)
    const d = j?.content?.data || {}
    for (const key of ["asyncUrls", "miniLogouts", "miniVsts"]) {
      const v = d[key]
      if (Array.isArray(v)) v.forEach((u: any) => typeof u === "string" && push(u))
      else if (v && typeof v === "object") Object.keys(v).forEach(k => typeof v[k] === "string" && push(v[k]))
      else if (typeof v === "string") push(v)
    }
    for (const key of ["redirectUrl", "replaceUrl", "parentRedirectUrl", "iframeRedirectUrl"]) {
      if (typeof d[key] === "string") push(d[key])
    }
  } catch { }
  if (out.length === 0) push(REFERER)
  return out
}

/** 跟进收尾 URL（手动跟跳转，每一跳的 Set-Cookie 都收） */
export async function qrComplete(jar: Jar, responseText: string): Promise<void> {
  for (const u of completionUrls(responseText)) {
    let cur = u
    for (let hop = 0; hop < 6; hop++) {
      const r = await get(jar, cur)
      if (r.status >= 300 && r.status < 400 && r.location) {
        try { cur = new URL(r.location, cur).toString() } catch { break }
        continue
      }
      break
    }
  }
}

/**
 * 完整扫码登录流程：返回二维码内容，轮询到 CONFIRMED 后收尾并落盘。
 * @param onStatus 状态变化（界面显示用）
 */
export async function qrLoginFlow(
  onQr: (content: string) => void,
  onStatus: (s: QrStatus) => void,
  isAlive: () => boolean = () => true,
): Promise<boolean> {
  const jar = new Jar()
  const ticket = await qrGenerate(jar)
  if (!ticket) { onStatus("ERROR"); return false }
  onQr(ticket.content)
  onStatus("NEW")

  for (let i = 0; i < 160 && isAlive(); i++) {
    await delay(1600)
    if (!isAlive()) break
    const { status, text } = await qrQuery(jar, ticket)
    onStatus(status)
    if (status === "CONFIRMED") {
      await qrComplete(jar, text)
      await delay(600)
      jar.saveToKeychain()
      return true
    }
    if (status === "EXPIRED" || status === "CANCELED" || status === "ERROR") return false
  }
  return false
}
