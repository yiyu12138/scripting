// 拼多多快递（mdkd）只读接口：驿站待取件（含取件码）、按运单号查物流。
// 协议按 huverse/SuperXD 的 lib/toolbox/express 独立重写，只用官方 H5 本来的请求形状：
// 不带 anti-content —— 这两个接口官方页面本身也不带（绑定/解绑那类账号变更才要，我们不碰）。
import { getPickups, savePickups } from "../store"
import { codeKey, mergeCodes, normalizePickupCode } from "./codes"
import { pddCookieHeader, pddHasLogin } from "./pdd"
import { pddAntiContent } from "./pddAnti"

declare const fetch: any

const API = "https://api.pinduoduo.com"
const REFERER = "https://m.pinduoduo.net/mdkd/package?pr_page_from=scheme"
// 身份码接口认 referer 里的 tab：不带 &tab=ID_CODE 会被网关当普通页面请求，
// 直接吐回一段 <H5Response> XML（实测 200 但不是 JSON）。出处：SuperXD 的 PddConstants.idCodeReferer
const ID_REFERER = REFERER + "&tab=ID_CODE"
// 数据接口与登录态同一身份（iPhone UA），避免同一 cookie 混用两种设备身份被风控盯上
const UA = "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1"
// 驿站待取件入口：4 = 扫驿站二维码进来（带站点码），8 = 普通入口
const ENTRY_SCAN = 4
const ENTRY_OTHER = 8

// 拼多多风控要本人过一次官方安全验证时冷却：这段时间内不再打接口，避免越撞越严
const VERIFY_COOLDOWN = 10 * 60 * 1000
let verifyUntil = 0

export type PddStationItem = {
  pickCode: string
  shippingName: string
  mailNo: string
  station: string
  address: string
  orderSn: string
  sourceType: string
}

export type PddStationResult = {
  count: number
  stationName: string
  onlyWxScan: boolean
  items: PddStationItem[]
}

export type PddTrackResult = {
  company: string
  mailNo: string
  forecast: string
  // 这件寄到哪个手机号的尾号（物流接口的 package_info 写「尾号5678 的快递」），取不到是空串
  ownerTail: string
  nodes: { time: string; text: string }[]
}

function authHeaders(): Record<string, string> {
  const cookie = pddCookieHeader()
  const token = /(?:^|;\s*)PDDAccessToken=([^;]+)/.exec(cookie)?.[1] ?? ""
  const h: Record<string, string> = {
    "Content-Type": "application/json;charset=UTF-8",
    Referer: REFERER,
    "User-Agent": UA,
    Cookie: cookie,
  }
  if (token) h.AccessToken = token
  return h
}

// 统一判错：没带 error_code 也算成功（物流接口成功时 error_code 就是 null）；
// 40001 = 未登录；54001 = 拼多多要本人过官方安全验证（短时间反复查物流会撞到它）；其余按服务端文案。
function unwrap(j: any): any {
  const raw = j?.error_code
  const code = raw == null ? "" : String(raw)
  if (code === "" || code === "0" || code === "1000000") return j ?? {}
  if (code === "40001") throw new Error("拼多多登录已失效，请重新授权")
  if (code === "54001") {
    verifyUntil = Date.now() + VERIFY_COOLDOWN
    throw new Error("拼多多要求安全验证，请到拼多多 App 里查一次快递后再试")
  }
  const msg = j?.error_msg ?? j?.error_message ?? ""
  throw new Error(msg || `拼多多返回失败（${code}）`)
}

// 响应不一定是 JSON：风控页/空响应/老的 <H5Response> XML 包装都让 res.json() 直接抛
// 「JSON Parse error: Unrecognized...」，用户只看到一段英文。这里先读文本再容错解析：
//   1) 正常 JSON
//   2) H5Response 里的 <RESULT>{...}</RESULT> / <DATA> / <data> 包装
//   3) 纯 XML 键值对 <identification_code>xxx</identification_code>
//   4) HTML 里夹着一段 {json}
// 都失败才报错，且把去掉标签后的正文带进文案。
function parseLoose(text: string): any | null {
  const t = String(text ?? "").trim()
  if (!t) return null
  try { return JSON.parse(t) } catch { }
  for (const tag of ["RESULT", "result", "DATA", "data", "DATA_JSON", "body"]) {
    const m = new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`).exec(t)
    if (!m) continue
    try { return JSON.parse(m[1].trim()) } catch { }
  }
  // 纯 XML 键值对：至少要有两个标签才当对象，否则容易误判
  const kv: Record<string, string> = {}
  const re = /<([A-Za-z_][\w.-]*)>([^<]+)<\/\1>/g
  let hit: RegExpExecArray | null
  while ((hit = re.exec(t))) {
    const k = hit[1]
    const v = hit[2].trim().replace(/^<!\[CDATA\[/, "").replace(/\]\]>$/, "")
    if (/^(H5Response|SUCCESS|FAIL|REQUEST_ID|SERVICE_NAME|ERROR_CODE)$/i.test(k)) continue
    kv[k] = v
  }
  if (Object.keys(kv).length >= 2) return { result: kv, ...kv }
  const i = t.indexOf("{"), j = t.lastIndexOf("}")
  if (i >= 0 && j > i) {
    try { return JSON.parse(t.slice(i, j + 1)) } catch { }
  }
  return null
}

async function readJson(res: any): Promise<any> {
  const text = String(await res.text() ?? "")
  const parsed = parseLoose(text)
  if (parsed != null) return parsed
  const plain = text.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim()
  // 登录页 HTML 会喂回来一大堆标签：这种直接按掉登录处理，比报一屏 HTML 有用
  if (/<H5Response/i.test(text) && /(登录|login|扫码|安全验证|verify)/i.test(plain)) {
    throw new Error("拼多多登录已失效，请重新授权")
  }
  throw new Error(`拼多多接口返回异常（${res.status}）：${plain.slice(0, 120) || "空响应"}`)
}

async function post(path: string, body: any, antiContent?: string, referer?: string): Promise<any> {
  const headers = authHeaders()
  if (referer) headers.Referer = referer
  if (antiContent) headers["anti-content"] = antiContent
  const res = await fetch(API + path, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  })
  if (res.status === 401 || res.status === 424) throw new Error("拼多多登录已失效，请重新授权")
  return unwrap(await readJson(res))
}

async function get(path: string, query: Record<string, string>): Promise<any> {
  const qs = Object.entries(query).map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join("&")
  const res = await fetch(`${API}${path}?${qs}`, { method: "GET", headers: authHeaders() })
  if (res.status === 401 || res.status === 424) throw new Error("拼多多登录已失效，请重新授权")
  return unwrap(await readJson(res))
}

function str(v: any): string {
  return v == null ? "" : String(v)
}

// jump_url 里带 order_sn / source_type / entry_source，驿站里的件查物流要用它
function queryOf(url: string): Record<string, string> {
  const q = /\?([^#]+)/.exec(url)?.[1] ?? ""
  const out: Record<string, string> = {}
  for (const kv of q.split("&")) {
    const i = kv.indexOf("=")
    if (i > 0) out[decodeURIComponent(kv.slice(0, i))] = decodeURIComponent(kv.slice(i + 1))
  }
  return out
}

/** 驿站待取件（含取件码）。传站点码就是扫驿站二维码进来的那一路，不传是普通查询。 */
export async function pddStationPackages(stationCode = ""): Promise<PddStationResult> {
  if (!pddHasLogin()) throw new Error("还没授权拼多多")
  if (Date.now() < verifyUntil) throw new Error("拼多多要求安全验证，请到拼多多 App 里查一次快递后再试")
  const data = await post("/api/express_trackbox/station/package", {
    entry_source: String(stationCode ? ENTRY_SCAN : ENTRY_OTHER),
    dynamic_qrcode: false,
    install_token: "",
    dp_source: "",
    redirect_app: false,
    ...(stationCode ? { station_code: stationCode } : {}),
  })
  const r = data?.result ?? {}
  const groups: any[] = Array.isArray(r?.combine_list) ? r.combine_list : []
  const items: PddStationItem[] = []
  for (const g of groups) {
    const station = str(g?.company_name)
    const address = str(g?.address)
    // 官方 H5 的包裹在 combine_track_list，App 版口径是 list，两边都读
    const list: any[] = Array.isArray(g?.combine_track_list) && g.combine_track_list.length > 0
      ? g.combine_track_list
      : (Array.isArray(g?.list) ? g.list : [])
    for (const p of list) {
      const jump = queryOf(str(p?.jump_url))
      items.push({
        // 取件码有的带「取件码」前缀、有的直接给占位词，统一清洗
        pickCode: normalizePickupCode(p?.pick_code),
        shippingName: str(p?.shipping_name),
        mailNo: str(p?.tracking_number),
        station,
        address,
        orderSn: str(jump.order_sn),
        sourceType: str(jump.source_type ?? p?.source_type),
      })
    }
  }
  const count = typeof r?.count === "number" ? r.count : items.length
  return {
    count,
    stationName: str(r?.station_name),
    onlyWxScan: r?.only_wx_scan === true || r?.only_wx_scan === 1,
    items,
  }
}

/** 按运单号查物流。驿站里的件传 orderSn/sourceType 走驿站物流接口，其余走通用物流接口。 */
export async function pddTrack(mailNo: string, extra?: { orderSn?: string; sourceType?: string }): Promise<PddTrackResult> {
  if (!pddHasLogin()) throw new Error("还没授权拼多多")
  if (Date.now() < verifyUntil) throw new Error("拼多多要求安全验证，请到拼多多 App 里查一次快递后再试")
  const orderSn = (extra?.orderSn ?? "").trim()
  let data: any
  if (orderSn) {
    data = await post("/api/express/dsd/trackbox/shipping/track", {
      order_sn: orderSn,
      source_type: extra?.sourceType ? Number(extra.sourceType) || null : null,
      entry_source: null,
      query_type: 1,
    })
  } else {
    data = await get("/api/express/shipping/track", {
      tracking_number: mailNo,
      entry_source: "9",
    })
  }
  const s = data?.shipping ?? {}
  const traces: any[] = Array.isArray(s?.traces) ? s.traces : []
  const fc = s?.time_forecast
  return {
    company: str(s?.shipping_name),
    mailNo: str(s?.tracking_number) || mailNo,
    forecast: fc && typeof fc === "object" ? str(fc.time_forecast_desc) : "",
    ownerTail: /尾号\s*(\d{3,4})/.exec(str(s?.package_info))?.[1] ?? "",
    nodes: traces.map(t => ({ time: str(t?.time), text: str(t?.info ?? t?.desc) })).filter(n => n.text),
  }
}

/** 已绑定的取件手机号（只读）。驿站靠这个号码找件，绑定/解绑本身在官方页面做。 */export type PddBoundMobile = { mobileId: string; masked: string; alias: string; commonlyUsed: boolean; scene?: number }

export async function pddBoundMobiles(): Promise<PddBoundMobile[]> {
  if (!pddHasLogin()) throw new Error("还没授权拼多多")
  const data = await post("/api/apoc/express/detail", { entry_source: 17 })
  const list: any[] = Array.isArray(data?.new_binding_list) ? data.new_binding_list : []
  return list.map((it: any) => ({
    mobileId: str(it?.mobile_id),
    masked: str(it?.mock_mobile ?? it?.mobile_des),
    alias: str(it?.alias),
    commonlyUsed: it?.commonly_used === true,
    scene: typeof it?.mobile_id_scene === "number" ? it.mobile_id_scene : undefined,
  })).filter(m => m.masked || m.mobileId)
}

/** 取拼多多取件身份码（驿站扫的就是它）。带站点码时同官方一起带上。 */
export async function pddIdentityCode(stationCode = ""): Promise<{ code: string; expiresAt: number; mobile: string }> {
  if (!pddHasLogin()) throw new Error("还没授权拼多多")
  if (Date.now() < verifyUntil) throw new Error("拼多多要求安全验证，请到拼多多 App 里查一次快递后再试")
  const data = await post("/api/express_trackbox/generate_identification_code", {
    entry_source: "APP",
    ...(stationCode ? { station_code: stationCode } : {}),
  }, undefined, ID_REFERER)
  const r = data?.result
  if (!r || typeof r !== "object") throw new Error("拼多多没返回身份码")
  const code = str(r.identification_code)
  if (!code) throw new Error("拼多多没返回身份码")
  const mills = typeof r.expire_mills === "number" ? r.expire_mills : Number(r.expire_mills) || 0
  const mi = r.mobile_info
  // 实测（2026-11-15）：字段在顶层 
  // result = { identification_code, expire_mills, mobile_info_desc:"已绑定常用手机号：138****0000", link_text, link_url }
  // 旧代码只读 r.mobile_info.mobile_desc，所以手机号一直是空的。
  return {
    code,
    // 到期按服务端给的剩余时间算，缺省按 5 分钟
    expiresAt: Date.now() + (mills > 0 ? mills : 5 * 60 * 1000),
    mobile: str(mi?.mobile_desc ?? mi?.mobile ?? mi?.mobile_info_desc ?? r.mobile_info_desc),
  }
}

/** 把驿站待取件的取件码合并进本地包裹：只按单号匹配、只追加，不覆盖已有码。返回改动条数。 */
export async function applyPddPickupCodes(): Promise<number> {
  if (!pddHasLogin()) return 0
  const r = await pddStationPackages().catch(() => null)
  if (!r || r.items.length === 0) return 0
  const map: Record<string, string[]> = {}
  for (const it of r.items) {
    const no = codeKey(it.mailNo)
    if (!no || !it.pickCode) continue
    map[no] = [...(map[no] ?? []), it.pickCode]
  }
  if (Object.keys(map).length === 0) return 0
  const list = getPickups()
  let changed = 0
  const next = list.map(p => {
    const no = codeKey(p.mailNo || "")
    const incoming = no ? map[no] : undefined
    if (!incoming) return p
    const merged = mergeCodes(p.codes ?? (p.code ? [p.code] : []), ...incoming)
    if (merged.length === (p.codes?.length ?? (p.code ? 1 : 0))) return p
    changed++
    return { ...p, code: merged[0] ?? p.code, codes: merged.length > 1 ? merged : undefined }
  })
  if (changed > 0) savePickups(next)
  return changed
}

/* ---------------- 取件手机号绑定（本人实时操作） ---------------- */
// 协议同样来自 huverse/SuperXD 的 express_client.dart。这几个接口都经过风控：
// anti-content 由 pddAntiContent() 让官方页面现算一个（见 utils/pddAnti.ts），我们不参与生成。
const BIND_PROTOCOL = "QJXXJSFWTK1_1"
const BIND_SMS_SCENE = "1000123"
const BIND_BOX_SERVICE = "express_assistant"
const MOBILE_TYPE_MOBILE = 1

// 服务端把 mobile_id / session_id 放在不同层级，递归找一个就行
export function pickField(node: any, key: string, depth = 0): string {
  if (depth > 5 || node == null) return ""
  if (typeof node !== "object") return ""
  const v = node[key]
  if (typeof v === "string" && v) return v
  if (typeof v === "number") return String(v)
  for (const k of Object.keys(node)) {
    const hit = pickField(node[k], key, depth + 1)
    if (hit) return hit
  }
  return ""
}

export type PddBindPreCheck = { hasBound: boolean; mobileId: string; mobileIdScene?: number; mobileDesc: string }

/** 绑定预检查（只读，不需要 anti-content） */
export async function pddBindPreCheck(): Promise<PddBindPreCheck> {
  if (!pddHasLogin()) throw new Error("还没授权拼多多")
  const data = await post("/api/apoc/binding/mobile/dsd/fast/bind/c/mobile/pre/check", {})
  const scene = data?.mobile_id_scene
  return {
    hasBound: data?.has_binding_express_mobile === true,
    mobileId: str(data?.mobile_id),
    mobileIdScene: typeof scene === "number" ? scene : undefined,
    mobileDesc: str(data?.mobile_des),
  }
}

/** 快速绑定本账号已有的手机号（不用短信） */
export async function pddFastBindMobile(mobileId: string, mobileIdScene?: number): Promise<void> {
  if (!pddHasLogin()) throw new Error("还没授权拼多多")
  const ac = await pddAntiContent()
  await post("/api/apoc/binding/mobile/dsd/fast/bind/c/mobile", {
    mobile_id: mobileId,
    ...(mobileIdScene != null ? { mobile_id_scene: mobileIdScene } : {}),
    protocol_code: BIND_PROTOCOL,
    entry_source: "4",
  }, ac)
  await linkStationPackages().catch(() => { })
}

/** 给新手机号发绑定验证码，返回下一步要用的 mobile_id */
export async function pddSendBindSms(mobile: string): Promise<string> {
  if (!pddHasLogin()) throw new Error("还没授权拼多多")
  const ac = await pddAntiContent()
  const data = await post("/api/francis/mobile/code/auth/query", {
    mobile_type: MOBILE_TYPE_MOBILE,
    mobile,
    digits: 6,
    scene: BIND_SMS_SCENE,
  }, ac)
  return pickField(data, "mobile_id")
}

/** 校验绑定验证码，返回完成绑定要用的 session_id */
export async function pddVerifyBindSms(mobileId: string, code: string): Promise<string> {
  if (!pddHasLogin()) throw new Error("还没授权拼多多")
  const ac = await pddAntiContent()
  const data = await post("/api/francis/mobile/code/auth/verify", {
    mobile_id: mobileId,
    code,
    scene: BIND_SMS_SCENE,
  }, ac)
  return pickField(data, "session_id")
}

/** 用 session_id 完成绑定新手机号 */
export async function pddNewBindMobile(sessionId: string, alias = ""): Promise<void> {
  if (!pddHasLogin()) throw new Error("还没授权拼多多")
  const ac = await pddAntiContent()
  await post("/api/apoc/binding/mobile/dsd/new/express/mobile", {
    session_id: sessionId,
    alias,
    verify_scene: BIND_SMS_SCENE,
    protocol_code: BIND_PROTOCOL,
    entry_source: "APP",
  }, ac)
  await linkStationPackages().catch(() => { })
}

/** 解绑取件手机号（body 字段名是 mobile，值传 mobileId） */
export async function pddUnbindMobile(mobileId: string, mobileIdScene?: number): Promise<void> {
  if (!pddHasLogin()) throw new Error("还没授权拼多多")
  const ac = await pddAntiContent()
  await post("/api/lobit/express/mobile/unbind", {
    mobile: mobileId,
    box_popup_service: BIND_BOX_SERVICE,
    anti_content: ac,
    ...(mobileIdScene != null ? { mobile_id_scene: mobileIdScene } : {}),
  }, ac)
}

/** 改备注（官方最多 5 个字，空串即清掉） */
export async function pddUpdateMobileAlias(mobileId: string, alias: string, mobileIdScene?: number): Promise<void> {
  if (!pddHasLogin()) throw new Error("还没授权拼多多")
  const ac = await pddAntiContent()
  await post("/api/apoc/express/mobile/alias", {
    mobile_id: mobileId,
    alias,
    anti_content: ac,
    ...(mobileIdScene != null ? { mobile_id_scene: mobileIdScene } : {}),
  }, ac)
}

/** 把绑定前就已到驿站的包裹关联进本账号：官方在绑定成功后紧接着调，不调那些件永远查不到 */
async function linkStationPackages(): Promise<void> {
  const ac = await pddAntiContent()
  await post("/api/express_trackbox/bind/mobile/station/package", {}, ac)
}
