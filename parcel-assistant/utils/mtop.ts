// MTOP H5 网关客户端（淘宝登录态 + md5 签名）
//
// 协议要点（来源：polygongfw/pickup-assistant、mykohuang/kuaidi-skill 的实测实现，
// 并用我们自己的抓包核对过）：
//   网关   https://h5api.m.taobao.com/h5/<api 小写>/<version>/
//   签名   md5("{_m_h5_tk 的 token 段}&{t}&{appKey}&{data}")，appKey 固定 12574478
//   引导   没有 _m_h5_tk 时第一包必然 FAIL_SYS_TOKEN_EMPTY，网关用 Set-Cookie 下发 token
//   过期   网关实际拼写是 TOKEN_EXOIRED（漏了 P），两种都要认
//
// 幂等性：调用失败返回 null，调用方自己决定重试或降级。
import { COOKIE_KEY } from "./model"

const UA = "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1"
export const APP_KEY = "12574478"
const HOST = "https://h5api.m.taobao.com"
const REFERER = "https://h5.m.taobao.com/"
const RETRY_MARKERS = ["TOKEN_EMPTY", "TOKEN_EXPIRED", "TOKEN_EXOIRED", "ILLEGAL_ACCESS", "TRAFFIC_LIMIT"]

const delay = (ms: number) => new Promise<void>(r => (setTimeout as any)(r, ms))
function cap<T>(p: Promise<T>, ms: number, fallback: T): Promise<T> {
  return Promise.race([p, delay(ms).then(() => fallback) as any])
}
function md5(s: string): string {
  const d = Data.fromString(s)
  if (!d) return ""
  try { return Crypto.md5(d).toHexString() } catch { return "" }
}

export type CookieLike = {
  name: string; value: string; domain?: string; path?: string
  isSecure?: boolean; isHTTPOnly?: boolean
}

export function tbCookies(): CookieLike[] {
  try {
    const raw = Keychain.get(COOKIE_KEY)
    if (!raw) return []
    const v = JSON.parse(raw)
    return Array.isArray(v) ? v : []
  } catch { return [] }
}

export function saveTbCookies(list: CookieLike[]) {
  try { Keychain.set(COOKIE_KEY, JSON.stringify(list)) } catch { }
}

export function tbHasLogin(): boolean {
  return tbCookies().length > 0
}

function tokenOf(list: CookieLike[]): string {
  const hit = list.find(k => k.name === "_m_h5_tk" && k.value)
  return hit ? String(hit.value).split("_")[0] : ""
}

/** 网关在 Set-Cookie 里轮换 token，fetch 读不到，就用 WebView 摸一次同步回 cookie 库 */
export async function refreshTbToken(list?: CookieLike[]): Promise<string> {
  const src = list ?? tbCookies()
  if (src.length === 0) return ""
  const c: any = new WebViewController({ preferredContentMode: "mobile" })
  try {
    for (const k of src) {
      try {
        await cap(c.setCookie({
          name: k.name, value: k.value, domain: k.domain, path: k.path ?? "/",
          isSecure: k.isSecure, isHTTPOnly: k.isHTTPOnly,
        }), 1000, undefined)
      } catch { }
    }
    await cap(c.loadURL(REFERER), 15000, undefined)
    await cap(c.waitForLoad(), 10000, undefined)
    await delay(600)
    const fresh: CookieLike[] = await cap(c.getAllCookies(), 5000, [] as any) || []
    const tb = (fresh || []).filter(k => k.name && k.value && /taobao\.com$|tmall\.com$/.test(String(k.domain || "")))
    if (tb.length) saveTbCookies(tb)
    return tokenOf(tb.length ? tb : src)
  } catch { return "" }
  finally { try { c.dispose() } catch { } }
}

async function request(api: string, data: string, version: string): Promise<string> {
  const cookies = tbCookies()
  if (cookies.length === 0) return ""
  const token = tokenOf(cookies)
  const t = Date.now()
  const sign = md5(`${token}&${t}&${APP_KEY}&${data}`)
  const url = `${HOST}/h5/${api.toLowerCase()}/${version}/?jsv=2.7.4&appKey=${APP_KEY}&t=${t}&sign=${sign}` +
    `&api=${encodeURIComponent(api)}&v=${encodeURIComponent(version)}&type=originaljson&dataType=json` +
    `&data=${encodeURIComponent(data)}`
  const header = cookies.map(k => `${k.name}=${k.value}`).join("; ")
  const fx: any = (globalThis as any).fetch
  try {
    const res = await cap(fx(url, {
      headers: { Cookie: header, "User-Agent": UA, Referer: REFERER, Accept: "application/json" },
    }), 20000, undefined as any)
    if (!res) return ""
    return String(await cap(res.text(), 15000, "") || "")
  } catch { return "" }
}

/**
 * 调用一个 MTOP 接口，返回解析后的 JSON（含 ret 数组），失败返回 null。
 * token 失效会自动刷一次再重试。
 */
export async function mtopCall(api: string, data: any, version = "1.0"): Promise<any | null> {
  const body = typeof data === "string" ? data : JSON.stringify(data)
  let txt = await request(api, body, version)

  const needRetry = !txt || RETRY_MARKERS.some(m => txt.toUpperCase().includes(m))
  if (needRetry) {
    const tok = await refreshTbToken()
    if (!tok) return null
    await delay(400)
    txt = await request(api, body, version)
  }
  if (!txt) return null
  try { return JSON.parse(txt) } catch { return null }
}

export function mtopRet(j: any): string {
  return String(j?.ret?.[0] ?? "")
}

export function mtopOk(j: any): boolean {
  return mtopRet(j).startsWith("SUCCESS")
}

/** 网关把业务数据放在 data.data 或 data 里，两种都兜住 */
export function mtopData(j: any): any {
  const d = j?.data
  if (d && typeof d === "object" && d.data !== undefined) return d.data
  return d ?? null
}
