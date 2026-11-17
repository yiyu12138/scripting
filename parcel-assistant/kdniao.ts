/**
 * 快递鸟（kdniao.com）：
 *  1) 用户在官方页面登录/注册后（滑块验证码、短信都由用户自己完成），
 *     用页面里的 accessToken 调 queryApiSecretKey 换取 EBusinessID + AppKey 并存进钥匙串；
 *  2) 用这对凭证走 8001 即时查询拿物流轨迹，支撑「手动查快递」。
 */
const CRED_KEY = "kdniao.credential"     // 与旧「快递聚合」「快递鸟快递跟踪」同 key，可直接复用
const TOKEN_KEY = "kdniao.token"
const USER_KEY = "kdniao.user"
const BIZ_LOGIN_URL = "https://biz.kdniao.com/login"
const API_BASE = "https://coporate.kdniao.com"
const QUERY_URL = "https://api.kdniao.com/Ebusiness/EbusinessOrderHandle.aspx"
const KD100_UA = "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1"

import { Notification } from "scripting"
import { arrivalState, getPickups, getSettings, matchStation, updatePickup } from "./store"
import { markWidgetSynced } from "./widgetData"
import { etaInText } from "./utils/eta"
import { extractPickupCode as pickupCodeOf } from "./utils/pickupCode"
import { mergeCodes, codeKey } from "./utils/codes"
import { detectCompany as cnDetectCompany } from "./utils/cainiao"
import { notifyArrived } from "./utils/reminders"
import { arrivedAtOf } from "./utils/arrive"
import { refreshPlatformParcels } from "./platforms"
import { notify } from "./ui/notify"

declare const fetch: any

export interface KdniaoUser {
  nickName: string
  mobile?: string
  companyName?: string
}

/* ---------------- 凭证 / 登录态 / 资料存取 ---------------- */

export function loadUser(): KdniaoUser | null {
  try {
    const raw = Keychain.get(USER_KEY)
    if (!raw) return null
    const v = JSON.parse(raw)
    if (v && typeof v.nickName === "string") return v
  } catch { }
  return null
}

function saveUser(u: KdniaoUser) { try { Keychain.set(USER_KEY, JSON.stringify(u)) } catch { } }
export function loadToken(): string { try { return Keychain.get(TOKEN_KEY) ?? "" } catch { return "" } }
export function clearToken() { try { Keychain.remove(TOKEN_KEY); Keychain.remove(USER_KEY) } catch { } }

export interface KdniaoCredential {
  eBusinessId: string
  appKey: string
  /** 快递鸟后台的用户ID，通常与 EBusinessID 相同 */
  userId?: string
  savedAt?: number
}

export interface TrackNode { time: string; text: string }

export interface TrackResult {
  shipperCode: string
  company: string
  state: string
  status: "none" | "transit" | "delivered"
  latest: string
  nodes: TrackNode[]
  /** 数据来源，界面会显示，避免两个源的轨迹看起来“不一样” */
  source?: string
  /** 快递鸟未取到取件码时可手填，存在这里同步给包裹 */
  pickupCode?: string
  /** 收货城市 / 完整收货地址（8001 的 Receiver 字段，套餐含地址服务时才有） */
  receiverCity?: string
  receiverAddress?: string
}

/* ---------------- 凭证存取 ---------------- */

export function loadCredential(): KdniaoCredential | null {
  try {
    const raw = Keychain.get(CRED_KEY)
    if (!raw) return null
    const v = JSON.parse(raw)
    if (v && typeof v.eBusinessId === "string" && typeof v.appKey === "string") return v
  } catch { }
  return null
}

export function saveCredential(cred: KdniaoCredential) {
  Keychain.set(CRED_KEY, JSON.stringify({ ...cred, savedAt: Date.now() }))
}

export function clearCredential() {
  try { Keychain.remove(CRED_KEY) } catch { }
}

/* ---------------- 登录页 → 自动取 EBusinessID / AppKey ---------------- */

/**
 * 打开快递鸟官方登录/注册页。滑块验证码与短信验证只能由用户完成，
 * 这里不绕过验证码，只负责：登录状态 → accessToken → 接口换密钥。
 */
/**
 * 往登录页注入一个悬浮「保存并返回」按钮。
 * 原生 present 不支持自定义导航栏按钮，所以只能写在页面里；
 * 点击时把页面自己的 localStorage 登录态回传给原生，随即收起页面。
 */
const SAVE_BUTTON_JS = `
(function () {
  var mk = function () {
    if (document.getElementById('__kd_save')) return;
    if (!document.body) return;
    var b = document.createElement('div');
    b.id = '__kd_save';
    b.textContent = '保存并返回';
    b.style.cssText = 'position:fixed;right:14px;bottom:calc(env(safe-area-inset-bottom,0px) + 22px);' +
      'z-index:2147483647;padding:12px 22px;border-radius:24px;background:#2D7BFF;color:#fff;' +
      'font:600 16px -apple-system,BlinkMacSystemFont,sans-serif;box-shadow:0 8px 20px rgba(0,0,0,.28);' +
      'user-select:none;-webkit-user-select:none;text-align:center;';
    b.addEventListener('click', function () {
      var raw = '';
      try { raw = localStorage.getItem('app-sso') || ''; } catch (e) { }
      try { window.webkit.messageHandlers.kdSave.postMessage(raw); } catch (e) { }
    }, false);
    document.body.appendChild(b);
  };
  mk();
  setInterval(mk, 1000);
  return 'ok';
})()
`


/** 读 WebView 里的整个 localStorage（键值对） */
export async function readLocalStorage(wv: WebViewController): Promise<Record<string, string>> {
  try {
    const dump = String(await wv.evaluateJavaScript(
      "return (function(){try{var o={};for(var i=0;i<localStorage.length;i++){var k=localStorage.key(i);o[k]=localStorage.getItem(k)}return JSON.stringify(o)}catch(e){return ''}})()"
    ) ?? "")
    if (!dump) return {}
    const obj = JSON.parse(dump)
    return obj && typeof obj === "object" ? obj : {}
  } catch { return {} }
}

/** 去掉可能的 JSON 引号包裹 */
function cleanToken(v: any): string {
  let s = typeof v === "string" ? v.trim() : ""
  if (!s) return ""
  if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) s = s.slice(1, -1)
  return s.trim()
}

/** 从 localStorage 里取访问令牌。
 *  - 手机版 m.kdniao.com：`token`（前端请求头就是 Authorization: localStorage.getItem("token")）
 *  - PC 版 biz.kdniao.com：`app-sso`.state.accessToken
 *  注意 `flushtoken` 是刷新令牌，拿去当访问令牌会回「token已过期或者未登录」 */
export function tokenFromLocalStorage(ls: Record<string, string>): string {
  const direct = cleanToken(ls["token"])
  if (direct && direct.length >= 12) return direct

  const sso = cleanToken(ls["app-sso"])
  if (sso) {
    try {
      const obj = JSON.parse(sso)
      const t = cleanToken(obj?.state?.accessToken ?? obj?.accessToken)
      if (t) return t
    } catch { }
  }

  // 兜底：只认键名里带 token 且不是刷新令牌的项
  for (const k of Object.keys(ls)) {
    if (/flush|refresh/i.test(k)) continue
    if (!/token/i.test(k)) continue
    const t = cleanToken(ls[k])
    if (t.length >= 12) return t
  }
  return ""
}

/** 从登录页的 WebView 里读登录态，换密钥并落盘。 */
export async function credentialFromWebView(wv: WebViewController): Promise<KdniaoCredential> {
  const ls = await readLocalStorage(wv)
  const token = tokenFromLocalStorage(ls)
  if (!token) throw new Error("还没有登录成功，先在页面里完成登录或注册")
  try { Keychain.set(TOKEN_KEY, token) } catch { }
  const cred = await fetchCredentialByToken(token)
  saveCredential(cred)
  try { saveUser(await fetchUserInfo(token)) } catch { }
  return cred
}

/** 用 accessToken 换该账号下的 API 密钥（用户ID + API KEY） */
export async function fetchCredentialByToken(token: string): Promise<KdniaoCredential> {
  const res = await fetch(`${API_BASE}/user-api/user/queryApiSecretKey`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json;charset=utf-8",
      Authorization: token,
      Origin: "https://biz.kdniao.com",
      Referer: "https://biz.kdniao.com/",
      "User-Agent": KD100_UA,
    },
    body: JSON.stringify({ pageIndex: 1, pageSize: 10 }),
  })
  const text = await res.text()
  let json: any
  try { json = JSON.parse(text) } catch { throw new Error("快递鸟返回了无法解析的数据") }
  const list: any[] = Array.isArray(json?.data) ? json.data : Array.isArray(json) ? json : []
  const first = list.find((x: any) => x && (x.secretId || x.appKey))
  if (!first) throw new Error(json?.message || "账号下还没有 API 密钥，请到「用户后台 → 快递鸟集成」创建")
  const eBusinessId = String(first.userId ?? first.eBusinessId ?? "")
  const appKey = String(first.secretId ?? first.appKey ?? "")
  if (!eBusinessId || !appKey) throw new Error("没有读到 EBusinessID / AppKey")
  return { eBusinessId, appKey, userId: String(first.userId ?? ""), savedAt: Date.now() }
}

/** 读快递鸟账号资料（昵称/手机号），用于页面同步显示 */
export async function fetchUserInfo(token: string): Promise<KdniaoUser> {
  const res = await fetch(`${API_BASE}/user-api/user/getInfo`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json;charset=utf-8",
      Authorization: token,
      Origin: "https://biz.kdniao.com",
      Referer: "https://biz.kdniao.com/",
      "User-Agent": KD100_UA,
    },
    body: "{}",
  })
  const text = await res.text()
  let json: any
  try { json = JSON.parse(text) } catch { throw new Error("快递鸟返回了无法解析的数据") }
  const u = json?.user ?? json?.data?.user ?? json?.data ?? {}
  const nickName = String(u.nickName ?? u.userName ?? "").trim()
  if (!nickName) throw new Error(json?.message || "没有读到账号资料")
  const out: KdniaoUser = { nickName }
  const mobile = String(u.mobile ?? u.mobilePhone ?? u.phone ?? u.tel ?? "").trim()
  if (mobile) out.mobile = mobile
  if (u.companyName) out.companyName = String(u.companyName)
  return out
}

/** 快递鸟 ShipperCode → 本机公司编号（见 theme.companyName） */
export function companyIndex(shipperCode: string): number {
  switch ((shipperCode || "").toUpperCase()) {
    case "ZTO": return 1
    case "SF": return 2
    case "YTO": return 3
    case "YUNDA": return 4
    case "STO": return 5
    case "JT": return 6
    case "YZPY": case "EMS": return 7
    case "JD": return 8
    case "DBWL": return 9
    case "HTKY": return 12
    case "TTKDEX": return 13
    case "ZJS": return 14
    default: return 0
  }
}

export function statusLabel(s: TrackResult["status"]): string {
  return s === "delivered" ? "已签收" : s === "transit" ? "运输中" : "待揽收"
}

export interface TrackHistoryItem {
  mailNo: string
  phone?: string
  shipperCode?: string
  company?: string
  at: number
}

const HISTORY_KEY = "cc.track.history"

export function loadTrackHistory(): TrackHistoryItem[] {
  const v = Storage.get<TrackHistoryItem[]>(HISTORY_KEY)
  return Array.isArray(v) ? v.filter(x => x && typeof x.mailNo === "string").slice(0, 30) : []
}

export function pushTrackHistory(item: TrackHistoryItem) {
  const list = loadTrackHistory().filter(x => x.mailNo !== item.mailNo)
  list.unshift(item)
  try { Storage.set(HISTORY_KEY, list.slice(0, 30)) } catch { }
}

export function removeTrackHistory(mailNo: string) {
  try { Storage.set(HISTORY_KEY, loadTrackHistory().filter(x => x.mailNo !== mailNo)) } catch { }
}

export function clearTrackHistory() {
  try { Storage.set(HISTORY_KEY, []) } catch { }
}

/** 台账轨迹里出现取件码时提取出来（取件页会用到）；实现见 utils/pickupCode */
export { extractPickupCode } from "./utils/pickupCode"

/** 用当前 token 领一次免费试用套餐；token 过期会先尝试从登录页刷新 */
export async function claimTrialPackage(): Promise<boolean> {
  const call = async (t: string) => {
    const r = await fetch(`${API_BASE}/champion-api/user/guide/receiveTrial`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json;charset=utf-8",
        Authorization: t, Origin: "https://biz.kdniao.com", Referer: "https://biz.kdniao.com/", "User-Agent": KD100_UA,
      },
      body: "{}",
    })
    return { status: r.status, text: await r.text() }
  }
  let t = loadToken()
  if (!t) t = await refreshTokenFromWebView()
  if (!t) return false
  let res = await call(t)
  if (res.status === 401) {
    const t2 = await refreshTokenFromWebView()
    if (!t2) return false
    res = await call(t2)
  }
  return res.status === 200 && res.text.includes("\"code\":200")
}

/** 静默打开登录页刷新 accessToken（不弹界面） */
export async function refreshTokenFromWebView(): Promise<string> {
  const wv = new WebViewController()
  try {
    await wv.loadURL(BIZ_LOGIN_URL)
    await new Promise<void>(r => setTimeout(() => r(), 3000))
    const raw = String(await wv.evaluateJavaScript("return localStorage.getItem('app-sso') || ''") ?? "")
    let token = ""
    try { token = JSON.parse(raw || "{}")?.state?.accessToken || "" } catch { }
    if (token) { try { Keychain.set(TOKEN_KEY, token) } catch { } }
    return token
  } catch { return "" } finally { try { wv.dispose() } catch { } }
}

/** 刷新所有物流包裹。返回更新的条数。
 *  - `platforms: false` 时跳过淘宝/京东/拼多多的抓取（小组件扩展里跑 WebView 不可靠）
 *  - `minGapMs` 控制限频，由调用方决定（App 前台/小组件/手动） */
export async function refreshTrackedPackages(opts?: {
  platforms?: boolean
  minGapMs?: number
  /** 跳过全局限频：刚导入/刚从没轨迹的包裹要马上查，不能等 20 分钟 */
  force?: boolean
  /** 只刷这几个运单号（导入后的定向补全） */
  only?: string[]
  /** 本次最多查几条 */
  max?: number
}): Promise<number> {
  const LAST = "cc.track.lastRefresh"
  const minGap = opts?.minGapMs ?? 20 * 60 * 1000
  const last = Number(Storage.get<number>(LAST) ?? 0)
  if (!opts?.force && Date.now() - last < minGap) return 0
  try { Storage.set(LAST, Date.now()) } catch { }

  // 平台授权的包裹也一起刷：各平台走自己的接口，不经过快递鸟
  // 京东/拼多多要 WebView，只有前台能跑；小组件扩展无 WebView，所以不调
  let platformChanged = 0
  if (opts?.platforms !== false) {
    try {
      platformChanged = await refreshPlatformParcels(20)
    } catch { }
  }

  let list = getPickups().filter(p => !!p.mailNo && (p.source ?? "kdniao") === "kdniao")
  if (opts?.only?.length) {
    const want = new Set(opts.only.map(x => String(x).replace(/[\s-]/g, "").toLowerCase()))
    list = list.filter(p => want.has(String(p.mailNo).replace(/[\s-]/g, "").toLowerCase()))
  }
  let changed = 0
  for (const p of list.slice(0, opts?.max ?? 20)) {
    // 用户已点过取件：不再管它的物流，也不改状态
    if (p.pickedByUser) continue
    const no = p.mailNo as string
    try {
      const r = await queryTracking(no, { shipperCode: p.shipperCode })
      if (r.nodes.length === 0) continue
      // 文案没变且已经是待取：不用重复处理（否则每 20 分钟写一次库）
      // 但状态还不是待取时要继续跑，否则「已到站」永远不会补发通知
      if (r.latest === p.trackLatest && p.status === 1) continue
      // 驿站归属从最新轨迹里推（没有短信导入，只靠物流文案）
      const station = matchStation([r.latest, p.itemTitle ?? ""].filter(Boolean).join("\n"))
      const arrival = arrivalState(r.latest)
      // 进入「待取」就发一条到站提醒（同包裹只提醒一次）
      if (arrival === "arrived") {
        await notifyArrived({
          ...p,
          trackLatest: r.latest,
          courierStationName: station?.name ?? p.courierStationName ?? "",
        })
      }
      const eta = etaInText(r.latest)
      // 这次物流里新出现的取件码也并进去（同一包裹可能先在某个平台看到码）
      const newCode = pickupCodeOf(r.nodes) || pickupCodeOf([{ text: r.latest }])
      const merged = mergeCodes(p.codes ?? (p.code ? [p.code] : []), newCode)
      const gained = merged.length > (p.codes?.length ?? (p.code ? 1 : 0))
      updatePickup(p.uuid, {
        trackLatest: r.latest,
        trackNodes: r.nodes,
        trackUpdatedAt: Date.now(),
        trackCompany: r.company || p.trackCompany,
        notes: r.latest,
        ...(eta ? { eta } : {}),
        ...(gained ? { codes: merged, code: codeKey(p.code) === codeKey(merged[0]) ? p.code : merged[0] } : {}),
        // 到站可取 → 待取；已取走 → 已取；在路上保留原状态
        status: arrival === "picked" ? 2 : arrival === "arrived" ? 1 : p.status,
        // 自动识别签收也保留真实签收时间，供“本月取件”统计；已有手动取件时间时不覆盖。
        ...(arrival === "picked" ? { pickedAt: p.pickedAt ?? arrivedAtOf(r.nodes) ?? Date.now() } : {}),
        // 到站时间取轨迹里的节点时间；已有就不覆盖（避免每次刷新都往后跳）
        ...(arrival === "arrived" ? { arrivedAt: p.arrivedAt ?? arrivedAtOf(r.nodes) ?? Date.now() } : {}),
        ...(station ? { courierStationName: station.name, courierStationUuid: station.uuid } : {}),
      })
      changed++
    } catch (e: any) {
      // 凭证/接口异常在界面上弹一下，否则后台刷新失败用户完全不知情
      const t = String(e?.message ?? e)
      if (/密钥|无效|未授权|EBusinessID|AppKey|额度|余额/.test(t)) notify("快递鸟凭证异常，请重新登录", "warn")
    }
  }
  // 记录本次同步时间，小组件底部会显示「xx:xx 同步」
  markWidgetSynced()
  return changed + platformChanged
}

/** 手机号中间四位打码 */export function maskPhone(p?: string): string {
  const s = (p ?? "").replace(/\s+/g, "")
  if (s.length < 7) return s
  return s.slice(0, 3) + "****" + s.slice(-4)
}

/** 用已保存的登录态刷新账号资料；失败返回 null，不抛错 */
export async function refreshUser(): Promise<KdniaoUser | null> {
  const t = loadToken()
  if (!t) return null
  try {
    const u = await fetchUserInfo(t)
    saveUser(u)
    return u
  } catch { return null }
}

/* ---------------- 快递公司识别（菜鸟优先，快递100 兜底） ---------------- */

const COM2SHIPPER: Record<string, string> = {
  zhongtong: "ZTO", zto: "ZTO",
  yunda: "YUNDA",
  yto: "YTO", yuantong: "YTO",
  sto: "STO", shentong: "STO",
  shunfeng: "SF", sf: "SF",
  jd: "JD",
  jtexpress: "JT", jt: "JT",
  youzhengguonei: "YZPY",
  ems: "EMS",
  youshu: "YS",
  debang: "DBWL",
  bestex: "HTKY", bestexpress: "HTKY",
  zhaijisong: "ZJS",
  tiantian: "TTKDEX",
  guotong: "GTO",
}

export async function detectShipper(mailNo: string): Promise<{ shipperCode: string; company: string; type: string }> {
  // 1) 有淘宝登录态就先问菜鸟：免 key，也不把单号发给第三方
  const cn = await cnDetectCompany(mailNo).catch(() => null)
  if (cn) {
    const key = cn.cpCode.toLowerCase()
    return { shipperCode: COM2SHIPPER[key] || cn.cpCode.toUpperCase(), company: cn.cpName, type: cn.cpCode }
  }

  // 2) 没有淘宝登录态（或菜鸟没认出）才用快递100 的公开识别
  const res = await fetch(`https://www.kuaidi100.com/autonumber/autoComNum?resultv2=1&text=${encodeURIComponent(mailNo)}`, {
    headers: { "User-Agent": KD100_UA, Referer: "https://www.kuaidi100.com/", Accept: "application/json, text/plain, */*" },
  })
  if (!res.ok) throw new Error(`快递公司识别失败（HTTP ${res.status}）`)
  const body = await res.text()
  let json: any
  try { json = JSON.parse(body) } catch { throw new Error("快递公司识别失败：返回无法解析") }
  const first = json && Array.isArray(json.auto) ? json.auto[0] : null
  const comCode = first && first.comCode ? String(first.comCode) : ""
  if (!comCode) throw new Error("无法自动识别快递公司，请手动填写快递公司代码")
  return { shipperCode: COM2SHIPPER[comCode] || comCode.toUpperCase(), company: first.name || "", type: comCode }
}

/* ---------------- 8001 即时查询 ---------------- */

function sign(requestData: string, appKey: string): string {
  const raw = Data.fromRawString(requestData + appKey)
  if (!raw) throw new Error("签名失败")
  // 实测必须是小写十六进制：大写会返回「非法参数」，小写才能过签名校验
  const md5hex = Crypto.md5(raw).toHexString().toLowerCase()
  const hexData = Data.fromRawString(md5hex)
  if (!hexData) throw new Error("签名失败")
  return encodeURIComponent(hexData.toBase64String())
}

function statusOf(state: any, latest: string): "none" | "transit" | "delivered" {
  if (!latest) return "none"
  if (String(state) === "3" || /签收|已签收|已送达|已取件|已领取|已投递/.test(latest)) return "delivered"
  return "transit"
}

/** 手机尾号按运单号记住，下次查同一单自动带上 */
const PHONE_KEY = "cc.track.phone"

function phoneMap(): Record<string, string> {
  const v = Storage.get<Record<string, string>>(PHONE_KEY)
  return v && typeof v === "object" ? v : {}
}

export function getPhoneFor(mailNo: string): string {
  return phoneMap()[mailNo.replace(/\s+/g, "")] ?? ""
}

export function savePhoneFor(mailNo: string, phone: string) {
  const m = phoneMap()
  m[mailNo.replace(/\s+/g, "")] = phone.trim()
  try { Storage.set(PHONE_KEY, m) } catch { }
}

const CODE_KEY = "cc.track.code"

function codeMap(): Record<string, string> {
  try { const v = Storage.get(CODE_KEY); return v && typeof v === "object" ? (v as Record<string, string>) : {} } catch { return {} }
}

/** 用户手填的取件码（和运单号绑定，再次查询自动带出） */
export function getCodeFor(mailNo: string): string {
  return codeMap()[mailNo.replace(/\s+/g, "")] ?? ""
}

export function saveCodeFor(mailNo: string, code: string) {
  const m = codeMap()
  m[mailNo.replace(/\s+/g, "")] = code.trim()
  try { Storage.set(CODE_KEY, m) } catch { }
}

function needPhoneError(msg: string) {
  const e: any = new Error(msg)
  e.needPhone = true
  e.wrongPhone = msg.includes("不正确")
  return e
}

/** 快递鸟 8001 即时查询（主通道） */
async function queryKdniao8001(
  no: string, shipperCode: string, company: string, phone: string,
): Promise<TrackResult> {
  const cred = loadCredential()
  if (!cred) throw new Error("还没有连接快递鸟账号")

  const rd: any = { LogisticCode: no, ShipperCode: shipperCode }
  // 中通/顺丰/京东的即时查询要收件人手机号后四位（字段名 CustomerName）
  if (phone) rd.CustomerName = phone
  const requestData = JSON.stringify(rd)
  const body =
    `RequestData=${encodeURIComponent(requestData)}` +
    `&EBusinessID=${encodeURIComponent(cred.eBusinessId)}` +
    `&RequestType=8001` +
    `&DataSign=${sign(requestData, cred.appKey)}` +
    `&DataType=2`

  const post = async (): Promise<any> => {
    const res = await fetch(QUERY_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        "User-Agent": KD100_UA,
        Referer: QUERY_URL,
        Accept: "application/json, text/plain, */*",
      },
      body,
    })
    if (!res.ok) throw new Error(`快递鸟 HTTP ${res.status}`)
    const text = await res.text()
    try { return JSON.parse(text) } catch { throw new Error("快递鸟返回了无法解析的数据") }
  }

  let json = await post()
  // 新账号没有可用套餐：自动领一次免费试用再重试
  if (!json.Success && String(json.Reason ?? "").includes("套餐")) {
    if (await claimTrialPackage()) json = await post()
  }
  if (!json.Success) {
    const reason = String(json.Reason ?? "")
    if (reason.includes("手机尾号不能为空")) throw needPhoneError("这个单号需要收件人手机号后四位")
    if (reason.includes("手机尾号不正确")) throw needPhoneError("手机号后四位不正确")
    if (reason.includes("套餐")) throw new Error("快递鸟账号没有可用套餐，自动领取失败")
    if (reason.includes("非法参数")) throw new Error("快递鸟拒绝了请求，请重新登录账号刷新密钥")
    throw new Error("快递鸟：" + (reason || "查询失败"))
  }

  const traces: any[] = (json.Traces || []).filter((t: any) => t && t.AcceptStation)
  traces.sort((a, b) => String(a.AcceptTime || "").localeCompare(String(b.AcceptTime || "")))
  // AcceptStation 可能是字符串，也可能嵌套对象（新版接口/地址服务开启时），统一拍平成文本
  const flatten = (v: any, depth = 0): string => {
    if (v == null || depth > 4) return ""
    if (typeof v === "string") return v
    if (typeof v === "number") return String(v)
    if (Array.isArray(v)) return v.map(x => flatten(x, depth + 1)).filter(Boolean).join(" ")
    if (typeof v === "object") {
      // 常见嵌套：{Station:{...},Desc:"..."} 或 {AcceptStation:"...",Remark:"..."}
      const keys = ["Desc", "AcceptStation", "Station", "Content", "Text", "Description", "Remark"]
      const parts: string[] = []
      for (const k of keys) { const s = flatten(v[k], depth + 1); if (s) parts.push(s) }
      if (parts.length > 0) return parts.join(" ")
      // 兑底：拍平所有字符串字段
      for (const k of Object.keys(v)) { const s = flatten(v[k], depth + 1); if (s) parts.push(s) }
      if (parts.length > 0) return parts.join(" ")
      // 还是什么都没有：把原始 JSON 显示出来，至少能看出数据形态，方便排查
      try { const s = JSON.stringify(v); return s && s !== "{}" ? s : "" } catch { return "" }
    }
    return ""
  }
  const nodes: TrackNode[] = traces.map(t => ({
    time: String(t.AcceptTime || ""),
    text: flatten(t.AcceptStation).replace(/\s+/g, " ").trim(),
  })).filter(n => n.text)
  const latest = nodes.length > 0 ? nodes[nodes.length - 1].text : ""
  // 8001 在套餐包含地址服务时会返回 Receiver；没有就是 undefined，不要编
  const rc = json.Receiver ?? null
  const receiverCity = rc ? String(rc.CityName ?? "").trim() : ""
  const receiverAddress = rc
    ? [rc.ProvinceName, rc.CityName, rc.ExpAreaName, rc.Address].map((v: any) => String(v ?? "").trim()).filter(Boolean).join("")
    : ""
  return {
    shipperCode,
    company: company || shipperCode,
    state: String(json.State ?? ""),
    status: statusOf(json.State, latest),
    latest,
    nodes,
    source: "快递鸟",
    receiverCity: receiverCity || undefined,
    receiverAddress: receiverAddress || undefined,
  }
}

export async function queryTracking(
  mailNo: string,
  opts?: { shipperCode?: string; phone?: string },
): Promise<TrackResult> {
  const no = mailNo.replace(/\s+/g, "")
  if (!no) throw new Error("请输入运单号")
  // 未授权时明确提示，不要再往下走让它报成「没识别快递公司」之类的误导信息
  if (!loadCredential()) throw new Error("快递鸟未授权，请到 设置 → 账户 登录授权后再查")

  let shipperCode = (opts?.shipperCode || "").trim().toUpperCase()
  let company = ""
  if (!shipperCode) {
    const det = await detectShipper(no)
    shipperCode = det.shipperCode
    company = det.company
  }

  // 手机尾号：调用方传入 > 该单号记住的
  const phone = (opts?.phone || getPhoneFor(no) || "").trim()

  // 只用快递鸟：查不到就直接把错误给界面，不做网页兜底
  return { ...(await queryKdniao8001(no, shipperCode, company, phone)), pickupCode: getCodeFor(no) }
}
