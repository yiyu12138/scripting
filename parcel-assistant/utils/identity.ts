// 菜鸟身份码（实名）—— 用淘宝登录态直连 MTOP H5 网关
//
// 协议来源：polygongfw/pickup-assistant（Kotlin，MIT）+ 我们自己的抓包核对。
//   api   : mtop.cainiao.nbpickup.identitycode.get   ← h5 通道用这个，不带 .cn
//   凭证  : 淘宝 cookie（unb / cookie2 / sgcookie / _m_h5_tk …）就够，不需要菜鸟 App
//
// 实测返回（结构示例，已脱敏）：
//   {certificated:true, fullname:"<姓名>", idCardNumber:"110101********0000",
//    identityCode:"CS00000000000000000A", expireTime:1736, isOfflineCode:true}
//
// 对照：走 cn-acs.m.cainiao.com + 菜鸟网页会话时会 mobileExists=false 且无 fullname；
// 淘宝 cookie 这条路一次补齐姓名与证件，是正解。
import { mtopCall, mtopData, mtopOk, mtopRet, tbHasLogin } from "./mtop"
import { pddHasLogin } from "./pdd"
import { pddIdentityCode } from "./pddExpress"

const API = "mtop.cainiao.nbpickup.identitycode.get"
const CACHE_KEY = "cc.cnIdentity"

export type CnIdentity = {
  code: string
  certificated: boolean
  name?: string
  idCard?: string
  expiresAt: number
}

export { tbHasLogin }

/**
 * 取实名身份码。每次调用服务端都会换一个新码，expireTime 秒后过期。
 * 淘宝未登录或会话失效返回 null。
 */
export async function fetchCnIdentity(): Promise<CnIdentity | null> {
  if (!tbHasLogin()) return null
  const j = await mtopCall(API, { appName: "GUOGUO", verifyVersion: "V2" })
  if (!j || !mtopOk(j)) return null
  const m = mtopData(j)?.model
  if (!m?.identityCode) return null
  const out: CnIdentity = {
    code: String(m.identityCode),
    certificated: String(m.certificated) === "true",
    name: m.fullname ? String(m.fullname) : undefined,
    idCard: m.idCardNumber ? String(m.idCardNumber) : undefined,
    expiresAt: Date.now() + Math.max(60, parseInt(String(m.expireTime || "600"), 10) || 600) * 1000,
  }
  try { Storage.set(CACHE_KEY, JSON.stringify(out)) } catch { }
  return out
}

export function cnIdentityCached(): CnIdentity | null {
  try {
    const raw = Storage.get(CACHE_KEY)
    if (!raw) return null
    const o = JSON.parse(String(raw))
    if (!o?.code) return null
    return o as CnIdentity
  } catch { return null }
}

/** 清掉两个身份码缓存（菜鸟 + 淘宝）：解除授权、清缓存后不能再把别人的姓名/证件号留在本机 */
export function clearIdentityCaches() {
  try { Storage.remove(CACHE_KEY) } catch { }
  try { Storage.remove(TB_CACHE) } catch { }
}

/* ---------------- 淘宝身份码 ---------------- */
// 淘宝 App 里「我的取件 → 身份码」那一页的接口，1.0.426 版本的 main.js 里写的是
// mtop.cainiao.pickup.identity.getIdentityMessage（页面：pages-fast.m.taobao.com/wow/z/uniapp/1011717/
// last-mile-fe/end-collect-platform/identity-code）。与菜鸟的 nbpickup.identitycode.get 是两个接口，
// 返回结构没公开文档，所以按「找形如 CS 开头的一串码」容错解析。
const TB_API = "mtop.cainiao.pickup.identity.getIdentityMessage"
const TB_CACHE = "cc.tbIdentity"

function findIdentityCode(node: any, depth = 0): string {
  if (depth > 6 || node == null) return ""
  if (typeof node === "string") {
    return /^[A-Z]{2}[0-9A-Z]{8,26}$/.test(node) ? node : ""
  }
  if (Array.isArray(node)) {
    for (const v of node) { const hit = findIdentityCode(v, depth + 1); if (hit) return hit }
    return ""
  }
  if (typeof node === "object") {
    // 名字里带 code 的字段优先，命中概率最高
    for (const k of Object.keys(node)) {
      if (/code|identity/i.test(k)) { const hit = findIdentityCode(node[k], depth + 1); if (hit) return hit }
    }
    for (const k of Object.keys(node)) { const hit = findIdentityCode(node[k], depth + 1); if (hit) return hit }
  }
  return ""
}

function findExpireSeconds(node: any, depth = 0): number {
  if (depth > 6 || node == null || typeof node !== "object") return 0
  for (const k of Object.keys(node)) {
    if (/expire/i.test(k) && typeof node[k] === "number" && node[k] > 0) {
      const n = node[k]
      // 有的给秒、有的给毫秒
      return n > 1e6 ? Math.round(n / 1000) : n
    }
  }
  for (const k of Object.keys(node)) { const hit = findExpireSeconds(node[k], depth + 1); if (hit) return hit }
  return 0
}

export async function fetchTbIdentity(): Promise<CnIdentity | null> {
  if (!tbHasLogin()) return null
  const j = await mtopCall(TB_API, {})
  if (!j) throw new Error("淘宝网关无响应")
  if (!mtopOk(j)) throw new Error(`淘宝接口返回 ${mtopRet(j)}`)
  const d = mtopData(j)
  const code = findIdentityCode(d)
  if (!code) throw new Error("淘宝接口没给身份码")
  const out: CnIdentity = {
    code,
    certificated: true,
    expiresAt: Date.now() + Math.max(60, findExpireSeconds(d) || 300) * 1000,
  }
  try { Storage.set(TB_CACHE, JSON.stringify(out)) } catch { }
  return out
}

export function tbIdentityCached(): CnIdentity | null {
  try {
    const raw = Storage.get(TB_CACHE)
    if (!raw) return null
    const o = JSON.parse(String(raw))
    if (!o?.code) return null
    return o as CnIdentity
  } catch { return null }
}
// 拼多多 mdkd 的 generate_identification_code：只给码值、到期时间与打码手机号，不给姓名身份证。
// 协议来自 huverse/SuperXD 的 express_client.generateIdentityCode（同一份官方 H5 请求，不带 anti-content）。
/* ---------------- 拼多多身份码 ---------------- */
const PDD_CACHE = "cc.pddIdentity"

export type PddIdentity = {
  code: string
  expiresAt: number
  mobile?: string
}

export async function fetchPddIdentity(): Promise<PddIdentity | null> {
  if (!pddHasLogin()) return null
  const r = await pddIdentityCode()
  const out: PddIdentity = { code: r.code, expiresAt: r.expiresAt, mobile: r.mobile || undefined }
  try { Storage.set(PDD_CACHE, JSON.stringify(out)) } catch { }
  return out
}

export function pddIdentityCached(): PddIdentity | null {
  try {
    const raw = Storage.get(PDD_CACHE)
    if (!raw) return null
    const o = JSON.parse(String(raw))
    if (!o?.code) return null
    return o as PddIdentity
  } catch { return null }
}
