/**
 * 丰巢（fcbox）接入：手机号 + 短信验证码登录，查待取件（含真实取件码、柜机、格口）。
 *
 * 协议来自 leizh25/fengchao 的 backend/app.py（Android App 6.7.0 抓包）：
 *  - 取签发参数 secureCheckMobile → 用 key1..key5 按 keyOrder 拼出 RSA 公钥
 *  - 签名 = "86{手机号}" + md5("86{手机号}11{timestamp}{clientIp}{requestCode}{opCode}")，
 *    再用 RSA PKCS1v15 加密并 base64（我们用纯 BigInt 实现，见 utils/rsa.ts）
 *  - 发码 secureSendCode、登录 secureLoginByPhone，登录响应头 Authorization 就是 token
 *  - 查待取件 queryWaitPick，cabinets[].boxes[].packages[] 里 code 是取件码、expressId 是运单号
 *
 * 自测记录（2026-11-14）：secureCheckMobile 实测可用、公钥拼出来是合法 2048 位 SPKI；
 * RSA 实现在本机用 openssl 生成的密钥对做过加解密往返验证。
 */
import { encryptWithBase64Key } from "./rsa"

declare const fetch: any

const BASE = "https://consumer.fcbox.com"
/** 客户端 opCode，来自丰巢 Android 6.7.0 */
const OP = "30b2718363204beeae98b7d03a75c3a4"

const TOKEN_KEY = "fengchao.token"
const MOBILE_KEY = "fengchao.mobile"
const PENDING_KEY = "fengchao.pending"
const FLAG_KEY = "fengchao.userflag"
const UATH_KEY = "fengchao.userauth"
const IP_KEY = "fengchao.clientip"

export interface FcPick {
  /** 运单号：用它和别的平台包裹融合，避免重复显示 */
  expressId: string
  /** 取件码 */
  code: string
  companyName: string
  /** 柜机编号 */
  cabinetCode: string
  /** 柜机地址 */
  address: string
  /** 格口，如「A-12」 */
  location: string
  /** 投件时间（字符串，服务端格式） */
  sendTm: string
  clientMobile: string
  postId: string
  boxId: string
  /** 开箱要用的一串字段先留着，等验证过再启用 */
  boxGlobalRow: string
  companyLogoUrl: string
  staffMobile: string
  expressType: number
}

function ua(): string {
  // 开柜接口的 UA 里客户端 IP 不是空的，其余请求发空也正常
  return `channel=xiaomi,ip=,os=15,deviceType=2211133C,platform=Android,resolution=1080*2296,versionCode=6007000,versionName=6.7.0,timestamp=${Date.now()}`
}

function uaWithIp(ip: string): string {
  return `channel=xiaomi,ip=${ip},os=15,deviceType=2211133C,platform=Android,resolution=1080*2296,versionCode=6007000,versionName=6.7.0,timestamp=${Date.now()}`
}

function md5Hex(s: string): string {
  const crypto = require("crypto")
  return crypto.createHash("md5").update(s).digest("hex")
}

interface FcResponse {
  status: number
  json: any
  text: string
  header: (name: string) => string
}

async function call(path: string, opts?: { method?: string; auth?: string; body?: any; headers?: Record<string, string> }): Promise<FcResponse> {
  const headers: Record<string, string> = {
    "User-Agent": ua(),
    "FC_USER_FLAG": "",
    "pinpoint-spanid": "1",
    "pinpoint-sampled": "true",
    "pinpoint-pspanid": "-1",
  }
  if (opts?.headers) for (const [k, v] of Object.entries(opts.headers)) if (v) headers[k] = v
  if (opts?.auth) headers.Authorization = opts.auth
  const init: any = { method: opts?.method ?? "GET", headers }
  if (opts?.body !== undefined) {
    headers["Content-Type"] = "application/json;charset=UTF-8"
    init.body = JSON.stringify(opts.body)
  }
  const res = await fetch(BASE + path, init)
  const text = await res.text()
  let json: any = null
  try { json = JSON.parse(text) } catch { }
  const h: any = res.headers
  return {
    status: res.status,
    json,
    text,
    header: (name: string) => {
      try {
        const v = h.get(name)
        if (v) return String(v)
      } catch { }
      try {
        const v = h.get(name.toLowerCase())
        if (v) return String(v)
      } catch { }
      // 有些实现只能遍历
      try {
        let found = ""
        h.forEach?.((val: string, key: string) => {
          if (!found && key.toLowerCase() === name.toLowerCase()) found = String(val)
        })
        return found
      } catch { return "" }
    },
  }
}

function ok(json: any): boolean {
  if (!json) return false
  // 丰巢成功码：0 或 150100000（"操作成功"）
  return json.code === 0 || json.code === 150100000 || json.success === true
}

/** 第一步：取签发参数并发送短信验证码 */
export async function fcSendCode(mobile: string): Promise<void> {
  const m = mobile.replace(/\D/g, "")
  if (!/^1\d{10}$/.test(m)) throw new Error("手机号格式不对")

  const chk = await call(`/v1/account/secureCheckMobile?mobile=${m}&type=11&opCode=${OP}&nationCode=86`)
  const d = chk.json?.data
  if (!d) throw new Error(`丰巢接口无响应（${chk.status}）${(chk.json?.msg ?? "").slice(0, 20)}`)
  if (d.needSliderCode === true || d.needSliderCode === "true") {
    throw new Error("丰巢要求滑块验证，请在丰巢 App 内登录一次后重试")
  }

  const order = String(d.keyOrder || "").split(",")
  let pubKey = ""
  for (let i = 1; i <= 5; i++) pubKey += String(d[`key${order[i - 1]}`] ?? "")
  if (pubKey.length < 100) throw new Error("取签名公钥失败")

  const ts = String(d.timestamp ?? "")
  const ip = String(d.clientIp ?? "")
  const rc = String(d.requestCode ?? "")
  // 开柜的 UA 也要带客户端 IP，取签发参数时顺手记下来
  if (ip) { try { Keychain.set(IP_KEY, ip) } catch { } }
  const md5text = `86${m}11${ts}${ip}${rc}${OP}`
  const sign = `86${m}${md5Hex(md5text)}`
  const enc = encodeURIComponent(encryptWithBase64Key(sign, pubKey))

  const res = await call(
    `/v1/account/secureSendCode?mobile=${m}&type=11&opCode=${OP}&nationCode=86&sliderTicket=&sliderRandstr=&sign=${enc}`,
    { method: "POST" },
  )
  if (!ok(res.json)) throw new Error(`发码失败：${(res.json?.msg ?? res.status).toString().slice(0, 24)}`)

  Keychain.set(PENDING_KEY, JSON.stringify({ pubKey, ts, ip, rc }))
  Keychain.set(MOBILE_KEY, m)
}

/** 第二步：用验证码登录，token 存 Keychain */
export async function fcLogin(mobile: string, code: string): Promise<void> {
  const m = mobile.replace(/\D/g, "")
  const c = code.replace(/\D/g, "")
  if (c.length < 4) throw new Error("验证码不对")
  const rawPending = Keychain.get(PENDING_KEY)
  if (!rawPending) throw new Error("请先获取验证码")
  let p: any = null
  try { p = JSON.parse(String(rawPending)) } catch { }
  if (!p?.pubKey) throw new Error("请先获取验证码")

  const md5text = `86${m}${c}01${p.ts}${p.ip}${p.rc}${OP}`
  const sign = `86${m}${md5Hex(md5text)}`
  const enc = encodeURIComponent(encryptWithBase64Key(sign, p.pubKey))

  const res = await call(
    `/v1/account/secureLoginByPhone?mobile=${m}&verifyCode=${c}&channel=0&type=1&weiXinUser=&nationCode=86&opCode=${OP}&sign=${enc}`,
    { method: "POST" },
  )
  const auth = res.header("Authorization")
  if (!auth) throw new Error(`登录失败：${(res.json?.msg ?? res.status).toString().slice(0, 24)}`)
  Keychain.set(TOKEN_KEY, auth)
  Keychain.set(MOBILE_KEY, m)
  // 开柜接口要的辅助头，登录时顺手存下（有些版本不返回，那就留空）
  const flag = res.header("FC_USER_FLAG")
  const uauth = res.header("FC_USER_AUTH")
  if (flag) Keychain.set(FLAG_KEY, flag); else try { Keychain.remove(FLAG_KEY) } catch { }
  if (uauth) Keychain.set(UATH_KEY, uauth); else try { Keychain.remove(UATH_KEY) } catch { }
  Keychain.remove(PENDING_KEY)
}

export function fcToken(): string {
  return String(Keychain.get(TOKEN_KEY) ?? "")
}

export function fcMobile(): string {
  return String(Keychain.get(MOBILE_KEY) ?? "")
}

export function fcHasLogin(): boolean {
  return !!fcToken()
}

export function fcClearLogin() {
  try { Keychain.remove(TOKEN_KEY) } catch { }
  try { Keychain.remove(PENDING_KEY) } catch { }
  try { Keychain.remove(MOBILE_KEY) } catch { }
}

/** 查在柜待取件（真实取件码） */
export async function fcWaitPick(): Promise<FcPick[]> {
  const token = fcToken()
  if (!token) throw new Error("丰巢未授权")
  const res = await call(`/post/mobilePick/queryWaitPick?channelCode=ANDROID_FC_APP`, { auth: token })
  if (!ok(res.json)) {
    if (res.status === 401 || res.json?.code === 401) {
      fcClearLogin()
      throw new Error("丰巢登录已失效，请重新授权")
    }
    throw new Error(`丰巢查件失败：${(res.json?.msg ?? res.status).toString().slice(0, 24)}`)
  }
  const out: FcPick[] = []
  const cabinets = res.json?.data?.cabinets ?? []
  for (const cab of cabinets) {
    for (const box of cab?.boxes ?? []) {
      for (const pkg of box?.packages ?? []) {
        out.push({
          expressId: String(pkg?.expressId ?? "").trim(),
          code: String(pkg?.code ?? "").trim(),
          companyName: String(pkg?.companyName ?? "").trim(),
          cabinetCode: String(cab?.cabinetCode ?? "").trim(),
          address: String(cab?.address ?? "").trim(),
          location: String(box?.location ?? "").trim(),
          sendTm: String(pkg?.sendTm ?? ""),
          clientMobile: String(pkg?.clientMobile ?? ""),
          postId: String(pkg?.postId ?? ""),
          boxId: String(box?.boxId ?? ""),
          boxGlobalRow: String(pkg?.boxGlobalRow ?? ""),
          companyLogoUrl: String(pkg?.companyLogoUrl ?? ""),
          staffMobile: String(pkg?.staffMobile ?? ""),
          expressType: Number(pkg?.expressType ?? 1) || 1,
        })
      }
    }
  }
  return out
}

/** 开柜所需的柜机/格口/单件信息，直接存在包裹上，详情页不必再查一次 */
export interface FcBoxMeta {
  cabinetCode: string
  boxId: string
  boxGlobalRow: string
  code: string
  expressId: string
  postId: string
  address: string
  /** 格口，如「A-12」；只用于确认弹窗展示，接口不靠它开柜 */
  location: string
  clientMobile: string
  companyName: string
  companyLogoUrl: string
  staffMobile: string
  expressType: number
}

export function fcPickToBox(p: FcPick): FcBoxMeta {
  return {
    cabinetCode: p.cabinetCode, boxId: p.boxId, boxGlobalRow: p.boxGlobalRow,
    code: p.code, expressId: p.expressId, postId: p.postId, address: p.address,
    location: p.location,
    clientMobile: p.clientMobile || fcMobile(), companyName: p.companyName,
    companyLogoUrl: p.companyLogoUrl, staffMobile: p.staffMobile, expressType: p.expressType,
  }
}

/** 刚开过的柜口：同一件 20 秒内再点直接当成功，避免重复开柜 */
let openedKey = ""
let openedAt = 0

/** 一键开柜：POST /post/clientGet/openBox，字段来自 leizh25/fengchao 的 app.py */
export async function fcOpenBox(input: FcBoxMeta): Promise<void> {
  let meta = input
  const token = fcToken()
  if (!token) throw new Error("丰巢未授权")
  if (!meta.cabinetCode || !(meta.boxId || meta.code)) throw new Error("缺少柜机信息，请先刷新丰巢")

  // 只对传进来的这一件生效：柜机号 + 格口 id + 取件码 + 运单号全部带上，
  // 丰巢按单件开箱，不会连带其它格口。
  // 早先存的记录可能没有 boxId（接口字段后来才补全），开柜前拉一次最新待取件选对那一件补全。
  if (!meta.boxId || !meta.postId) {
    try {
      const list = await fcWaitPick()
      const hit = list.find(x => (meta.expressId && x.expressId === meta.expressId) || (meta.code && x.code === meta.code))
      if (hit) meta = fcPickToBox(hit)
    } catch { }
  }
  if (!meta.boxId) throw new Error("这件已不在丰巢待取列表里，请刷新后再试")
  const key = [meta.cabinetCode, meta.boxId, meta.code, meta.expressId].join("|")
  if (key === openedKey && Date.now() - openedAt < 20000) return

  const body = {
    cabinetCode: meta.cabinetCode,
    channel: "APP-ANDRIOD",
    clientMobile: meta.clientMobile || fcMobile(),
    cmdkType: "1",
    expressId: meta.expressId,
    localActivityId: "",
    localAddress: meta.address,
    localAllBoxIdList: meta.boxId,
    localBoxGlobalRow: meta.boxGlobalRow,
    localCode: meta.code,
    localCurrBoxId: meta.boxId,
    localDigitizationStatus: 0,
    localFromSource: "2",
    localOneClickOpenCabinetValidTime: "",
    localOrderId: "",
    localPopupTimeout: 120,
    localRefusePackages: [{
      companyLogoUrl: meta.companyLogoUrl,
      companyName: meta.companyName,
      expressId: meta.expressId,
      expressType: meta.expressType,
      localSelected: true,
      postId: meta.postId,
      staffMobile: meta.staffMobile,
    }],
    localRefuseSessionTokenTime: 120,
    localScanFirst: true,
    localScanTotal: 0,
    localSource: "0",
    localSupportVisual: false,
    mobilePickType: "APP-ANDRIOD",
    pickType: "ANDROID_PICK_MOBILE_APP",
    postId: meta.postId,
  }

  const headers: Record<string, string> = {
    "User-Agent": uaWithIp(String(Keychain.get(IP_KEY) ?? "")),
    "pinpoint-traceid": `ConsumerA0fc2d4fc6bfea8b^${Date.now()}^993`,
  }
  const flag = String(Keychain.get(FLAG_KEY) ?? "")
  const uauth = String(Keychain.get(UATH_KEY) ?? "")
  if (flag) headers.FLAG = flag
  if (flag) headers.FC_USER_FLAG = flag
  if (uauth) headers.FC_USER_AUTH = uauth

  const res = await call("/post/clientGet/openBox", { method: "POST", auth: token, body, headers })
  if (res.status === 401 || res.json?.code === 401) {
    fcClearLogin()
    throw new Error("丰巢登录已失效，请重新授权")
  }
  const j = res.json
  if (!j) throw new Error(`丰巢开柜失败（${res.status}）`)
  if (j.success === false || (j.code != null && !ok(j))) {
    throw new Error(String(j.message ?? j.msg ?? "丰巢开柜失败").slice(0, 40))
  }
  openedKey = key
  openedAt = Date.now()
}
