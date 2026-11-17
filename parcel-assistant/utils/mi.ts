/**
 * 小米快递（智能助理「我的快递」聚合）协议移植。
 *
 * 协议来源：Halo0sama/ExpressAssistant（Android，MIT 逆向实现）：
 *  - 请求体先 AES-128-ECB/PKCS5（key "d101b17c77ff93cs"）加密再 Base64 上报；
 *  - URL 带 yellowpage_encparam = AES-ECB-Base64(path)，sign = SHA1(salt+enc+salt2) 大写；
 *  - 响应 JSON 的 data 字段同样是 AES-ECB-Base64，需解密；
 *  - 请求体外层 wrapBody 带 userSignal/environmentSignal/timeSignal（Android 设备字段，iOS 传伪值，未验证服务端是否校验）。
 * 登录：WebView 打开 account.xiaomi.com（sid=assistant）→ 轮询 Cookie 拿
 *  passToken/userId/deviceId（account.xiaomi.com 域）→ 服务端 serviceLogin 换
 *  ssecurity+nonce → clientSign=Base64(SHA1("nonce=..&ssecurity")) → GET location 带
 *  clientSign（禁止重定向）→ Set-Cookie 里的 serviceToken 就是接口凭证。
 */
// Data/Crypto 是全局（scripting dts 没导出，运行时可用；相关记忆 globals-are-not-module-exports）
declare const Data: any
declare const Crypto: any
declare const fetch: any

const HOST = "https://verca.xpa.assistant.miui.com"
const AES_KEY = "d101b17c77ff93cs"
const SIGN_SALT = "77eb2e8a5755abd016c0d69ba74b219c"
const PA_VERSION = 25000031

/* ---------------- 加解密（node:crypto shim，ECB 必须传 0 字节 iv） ---------------- */

const nc: any = (() => { try { return require("node:crypto") } catch { return null } })()

function aesEcbBase64(plain: string): string {
  if (!nc) throw new Error("node:crypto 不可用")
  const key = Buffer.from(AES_KEY, "utf8")
  const c = nc.createCipheriv("aes-128-ecb", key, Buffer.alloc(0))
  c.setAutoPadding(true)
  return Buffer.concat([c.update(plain, "utf8"), c.final()]).toString("base64")
}

function aesEcbDecode(b64: string): string {
  if (!nc) throw new Error("node:crypto 不可用")
  const key = Buffer.from(AES_KEY, "utf8")
  const d = nc.createDecipheriv("aes-128-ecb", key, Buffer.alloc(0))
  d.setAutoPadding(true)
  return Buffer.concat([d.update(Buffer.from(b64, "base64")), d.final()]).toString("utf8")
}

function sha1Hex(text: string): string {
  return Crypto.sha1(Data.fromString(text)).toHexString().toUpperCase()
}

function sha1Base64(text: string): string {
  return Crypto.sha1(Data.fromString(text)).toBase64String()
}

/* ---------------- 登录态存取 ---------------- */

const KEY_TOKEN = "mi.serviceToken"
const KEY_USER = "mi.userInfo" // { cUserId, userId, deviceId, passToken }

export function miHasLogin(): boolean {
  try { return !!Keychain.get(KEY_TOKEN) } catch { return false }
}

export function miReadUser(): { cUserId?: string; userId?: string; deviceId?: string; passToken?: string } {
  try {
    const raw = Keychain.get(KEY_USER)
    return raw ? JSON.parse(raw) : {}
  } catch { return {} }
}

export function miSaveSession(token: string, user: Record<string, string>) {
  Keychain.set(KEY_TOKEN, token)
  Keychain.set(KEY_USER, JSON.stringify(user))
}

export function miClearLogin() {
  try { Keychain.remove(KEY_TOKEN) } catch { }
  try { Keychain.remove(KEY_USER) } catch { }
}

/* ---------------- STS 兑换（passToken → serviceToken） ---------------- */

/** GET 无重定向；返回 { code, setCookie, body } */
async function getNoRedirect(url: string, cookie?: string): Promise<{ code: number; setCookie: string; body: string }> {
  const resp = await fetch(url, {
    method: "GET",
    redirect: "manual",
    headers: {
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
      ...(cookie ? { Cookie: cookie } : {}),
    },
  })
  // Scripting fetch 的 redirect:"manual" 也能拿到 302 响应头（未验证 3xx 时不跟随，用 header 而不是 json()）
  let body = ""
  try { body = await resp.text() } catch { }
  const sc = (resp as any).headers?.get?.("set-cookie") ?? (resp as any).headers?.["set-cookie"] ?? (resp as any).headers?.["Set-Cookie"] ?? ""
  return { code: resp.status, setCookie: String(sc || ""), body }
}

/**
 * 用 WebView 登录后拿到的 passToken 换 assistant 侧 serviceToken。
 * 成功返回 { token, cUserId }，失败抛错（错误信息给用户看）。
 */
export async function miMintToken(): Promise<{ token: string; cUserId: string }> {
  const u = miReadUser()
  if (!u.passToken || !u.userId || !u.deviceId) throw new Error("小米登录态不完整（缺 passToken/userId/deviceId），请重新扫码")
  const enc = encodeURIComponent
  const cookie = `userId=${enc(u.userId!)}; passToken=${enc(u.passToken!)}; deviceId=${enc(u.deviceId!)}`
  const loginUrl = "https://account.xiaomi.com/pass/serviceLogin?sid=assistant&_json=true&_appName=com.miui.personalassistant&_locale=zh_CN"
  const loginResp = await fetch(loginUrl, { headers: { Cookie: cookie } })
  const loginText = await loginResp.text()
  const json = loginText.slice(loginText.indexOf("{"))
  const obj = JSON.parse(json)
  if (obj.code !== 0) throw new Error(`小米 serviceLogin 失败：${obj.desc ?? json.slice(0, 80)}`)
  const { ssecurity, nonce, location, cUserId } = obj
  const clientSign = sha1Base64(`nonce=${nonce}&${ssecurity}`)
  const sep = location.includes("?") ? "&" : "?"
  const sts = await getNoRedirect(`${location}${sep}clientSign=${enc(clientSign)}&_userIdNeedEncrypt=true`, cookie)
  const m = sts.setCookie.match(/(?:assistant_)?serviceToken=([^;\s]+)/i)
  if (!m) throw new Error("小米返回空令牌（S=OK 但没有 serviceToken），可能账号风控，请重新扫码登录")
  return { token: m[1], cUserId: String(cUserId ?? u.userId ?? "") }
}

/* ---------------- 接口调用（wrapBody + 加密 + 签名） ---------------- */

const delay = (ms: number) => new Promise<void>(resolve => (setTimeout as any)(resolve, ms))

function wrapBody(plain: string, userId: string): string {
  // iOS 没有 OAID/MIUI 环境：照抄字段名、传伪值/空值，服务端是否校验未验证
  const env: Record<string, any> = {
    terminal: "phone",
    assistantVersion: PA_VERSION,
    launchVersion: 0,
    androidVersion: "14",
    androidSdkVersion: 34,
    miuiType: "stable",
    phoneModel: "2210132C",
    phoneDevice: "sky",
    connectionType: "WIFI",
    miuiVersionName: "V14",
    miuiVersion: "14.0.6",
    osVersionName: "HyperOS 1.0",
    osVersion: "1.0",
    miSettingsVersionName: "",
    miSettingsVersionCode: 0,
    timeZone: "Asia/Shanghai",
    language: "zh",
    country: "CN",
    screen: 1,
    coordinate: "",
    reqId: uuidMi(),
    ip: "",
    cpuArchitecture: "arm64",
    marketVersion: 0,
    os: "",
    clientFlag: 0,
    hwVersion: "",
  }
  const now = new Date()
  return JSON.stringify({
    userSignal: { oaid: "", vaid: "", userId },
    environmentSignal: env,
    timeSignal: {
      clientTs: String(now.getTime()),
      timeZone: "中国标准时间", // Android TimeZone.getDisplayName(false,0) 的 zh-CN 输出
    },
    eventSignal: JSON.parse(plain),
  })
}

function uuidMi(): string {
  return "xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx".replace(/x/g, () => Math.floor(Math.random() * 16).toString(16))
}

async function miPost(path: string, plainBody: string): Promise<any> {
  const token = Keychain.get(KEY_TOKEN)
  if (!token) throw new Error("小米未登录")
  const u = miReadUser()
  const userId = String(u.cUserId || u.userId || "")
  const enc = aesEcbBase64(path)
  const sign = sha1Hex(`yellowpage_encparam${enc}${SIGN_SALT}`)
  const url = `${HOST}${path}?version=${PA_VERSION}&appkey=yellowpage&yellowpage_encparam=${encodeURIComponent(enc)}&sign=${sign}&_encparam=${encodeURIComponent(enc)}`
  const resp = await fetch(url, {
    method: "POST",
    headers: {
      "Cookie": `serviceToken=${token}; cUserId=${userId}`,
      "Content-Type": "application/json",
    },
    body: aesEcbBase64(wrapBody(plainBody, userId)),
  })
  const text = await resp.text()
  if (!resp.ok) throw new Error(`小米接口 HTTP ${resp.status}：${text.slice(0, 120)}`)
  let root: any
  try { root = JSON.parse(text) } catch { throw new Error(`小米接口响应异常：${text.slice(0, 120)}`) }
  // data 字段是加密的 Base64（解不动就原样返回，让上层按错误处理）
  if (root && typeof root.data === "string" && root.data && root.data !== "null") {
    try { root.data = JSON.parse(aesEcbDecode(root.data)) } catch { try { root.data = aesEcbDecode(root.data) } catch { } }
  }
  return root
}

/* ---------------- 业务接口 ---------------- */

export interface MiExpressItem {
  mailNo?: string        // 运单号
  cpCode?: string        // 快递公司编码
  cpName?: string        // 快递公司名
  state?: number         // 状态码
  stateDesc?: string     // 状态文案
  stationName?: string   // 驿站/柜名
  address?: string
  pickupCode?: string    // 取件码
  productName?: string   // 物品名
  provider?: string
  logisticsUpdateTime?: string
  detailPath?: string    // 详情接口路径
  stateNum?: number
  [k: string]: any
}

/** 列表：POST /cpa/express/v2/getList */
export async function miFetchList(phones: string[]): Promise<MiExpressItem[]> {
  const body = JSON.stringify({ info: { limit: 29, phones, deletedMailNos: [], modifiedMailNos: [] } })
  const root = await miPost("/cpa/express/v2/getList", body)
  if (root?.code !== 0 && root?.status?.code !== 0) {
    throw new Error(`小米列表失败：${JSON.stringify(root).slice(0, 120)}`)
  }
  const data = root.data ?? root
  // 列表结构（ExpressAssistant 里按 data.expressList 或 data.info.list 解析，两层都兜）
  const list = data?.expressList ?? data?.info?.list ?? data?.list ?? []
  return Array.isArray(list) ? list : []
}

/** 详情：列表项里带 detailPath 时可查完整轨迹。
 *  请求体字段与 Halo0sama/ExpressAssistant 的 XiaomiApi.getDetailBody 对齐：
 *  name 是快递公司名（不是商品名）、channel 固定 "1"、logisticsUpdateTime 要 epoch 毫秒。 */
export async function miFetchDetail(item: MiExpressItem, phones: string[]): Promise<any> {
  const path = item.detailPath || "/cpa/express/v2/query"
  const toEpoch = (s?: string): string | null => {
    const raw = String(s ?? "").trim()
    const m = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?/.exec(raw)
    if (!m) return raw || null
    const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5]), Number(m[6] ?? 0))
    return String(d.getTime())
  }
  const body = JSON.stringify({
    info: {
      phones,
      cpCode: item.cpCode ?? null,
      mailNo: item.mailNo ?? "",
      name: item.cpName ?? null,
      provider: item.provider ?? null,
      stateNum: item.stateNum ?? 0,
      logisticsUpdateTime: toEpoch(item.logisticsUpdateTime),
      phone: null,
      queryChannel: null,
      channel: "1",
    },
  })
  return miPost(path, body)
}

/**
 * 详情响应 → 轨迹数组（新→旧）。
 * 实测结构（ExpressAssistant 的 XiaomiDetail.kt）：`{ code:0, data:{ details:[{ desc, time }], stateNum, state } }`，
 * 其余候选字段只作兜底，取不到就返回空数组，不影响包裹本身的导入。
 */
export function parseMiTraces(root: any): { time: string; text: string }[] {
  const out: { time: string; text: string }[] = []
  const take = (arr: any[]): boolean => {
    let got = false
    for (const it of arr) {
      if (!it || typeof it !== "object") continue
      const text = String(it.desc ?? it.info ?? it.context ?? it.statusDesc ?? it.text ?? it.title ?? "").trim()
      const time = String(it.time ?? it.date ?? it.updateTime ?? it.traceTime ?? it.displayTime ?? "").trim()
      if (text) { out.push({ time, text }); got = true }
    }
    return got
  }
  const cands: any[] = [
    root?.data?.details,
    root?.data?.traceList, root?.data?.traces, root?.data?.list,
    root?.data?.info?.traceList, root?.data?.info?.list,
    root?.details, root?.traceList, root?.traces, root?.list,
  ]
  for (const c of cands) {
    if (Array.isArray(c) && c.length > 0 && take(c)) break
  }
  return out
}

/** 手机号绑定：发验证码 → 校验 → bind */
export async function miSendCode(phone: string): Promise<void> {
  const u = miReadUser()
  const root = await miPost("/cpa/express/phone/sendVerificationCode", JSON.stringify({ info: { phone } }))
  void u
  if (root?.code !== 0 && root?.status?.code !== 0) throw new Error(`发送验证码失败：${JSON.stringify(root).slice(0, 100)}`)
}

export async function miCheckCode(phone: string, code: string): Promise<void> {
  const root = await miPost("/cpa/express/phone/checkVerificationCode", JSON.stringify({ info: { phone, verificationCode: code } }))
  if (root?.code !== 0 && root?.status?.code !== 0) throw new Error(`验证码校验失败：${JSON.stringify(root).slice(0, 100)}`)
}

export async function miBindPhone(phone: string, phones: string[], bind: boolean): Promise<void> {
  const type = bind ? 1 : 2
  const body = JSON.stringify({ cardId: 3, serviceKey: "express", info: { type, phone, phoneList: phones } })
  const root = await miPost("/cpa/express/phone/bind", body)
  if (root?.code !== 0 && root?.status?.code !== 0) throw new Error(`绑定失败：${JSON.stringify(root).slice(0, 100)}`)
}



export { delay as miDelay }
