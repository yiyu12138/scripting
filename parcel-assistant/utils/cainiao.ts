// 菜鸟裹裹数据（淘宝登录态直连 MTOP，无需菜鸟 App）
//
// 接口来源：mykohuang/kuaidi-skill + polygongfw/pickup-assistant 的实测实现。
//   · 我的包裹（含取件码）  mtop.cainiao.lpc.packageservice.queryPdsPackageDataList
//   · 包裹计数（登录自检）  mtop.cainiao.lpc.packageservice.user.package.count.query
//   · 免登录查单号轨迹      mtop.cainiao.logisticsdetail.packages.pid.orderCode.mailNo.get
//                          降级 mtop.taobao.logisticsDetailTraceQueryService.queryCpByMailNo
//                              + mtop.taobao.logisticstracedetailservice.queryalltrace
//
// 取件码藏在 packageStation.authCode；值是 NEEDSMS 之类表示"需短信验证才可见"，不是真码。
import { mtopCall, mtopData, mtopOk, mtopRet, tbHasLogin } from "./mtop"
import { getPickups, savePickups } from "../store"
import { codeKey, mergeCodes, normalizePickupCode } from "./codes"
import { etaInObject } from "./eta"

const API_LIST = "mtop.cainiao.lpc.packageservice.queryPdsPackageDataList"
const API_COUNT = "mtop.cainiao.lpc.packageservice.user.package.count.query"
const API_PID = "mtop.cainiao.logisticsdetail.packages.pid.orderCode.mailNo.get"
const API_CP = "mtop.taobao.logisticsDetailTraceQueryService.queryCpByMailNo"
const API_TRACE = "mtop.taobao.logisticstracedetailservice.queryalltrace"

const NEED_DYN = "{'needFindTemporality':true,'needAppointment':true}"
const CODE_PLACEHOLDER = new Set(["needsms", "need_sms", "-1", "0", "", "null", "none"])
const DONE_STATUS = new Set(["SIGN", "CANCEL", "REJECT", "RETURN", "LOST"])

export type CnpPackage = {
  /** 运单号 */
  mailNo: string
  /** 商品/包裹标题 */
  title: string
  /** 快递公司名 */
  company: string
  /** 驿站/快递柜取件码，没有则为空 */
  pickupCode: string
  /** 驿站名 */
  station: string
  /** 是否已到站可领取 */
  atStation: boolean
  /** 已签收/退回等终态 */
  done: boolean
  /** 原始状态串（调试用） */
  status: string
  /** 最近更新时间（毫秒）；接口字段不统一，多试几个候选，取不到就是 undefined */
  updatedAt?: number
  /** 接口里出现的「预计…送达」原话（字段名不固定，只在浅层扫） */
  eta?: string
}

export type TrackNode = { time: string; text: string }
export type TrackResult = { company: string; mailNo: string; nodes: TrackNode[] }

function s(o: any, ...keys: string[]): string {
  if (!o || typeof o !== "object") return ""
  for (const k of keys) {
    const v = o[k]
    if (typeof v === "string" && v.trim()) return v.trim()
  }
  return ""
}

function pickupCodeOf(pkg: any): string {
  const st = pkg?.packageStation || {}
  const feat = pkg?.feature || {}
  let code = s(st, "authCode", "auth_code")
  if (CODE_PLACEHOLDER.has(code.toLowerCase())) {
    const alt = s(st, "showPickupCode", "show_pickup_code", "pickUpCode", "pickupCode")
    code = alt && alt.toLowerCase() !== "true" && alt.toLowerCase() !== "false"
      ? alt
      : s(feat, "stationOrderPickUpCode", "station_order_pick_up_code")
  }
  return CODE_PLACEHOLDER.has(code.toLowerCase()) ? "" : normalizePickupCode(code)
}

function titleOf(pkg: any): string {
  const feat = pkg?.feature || {}
  const items: any[] = Array.isArray(pkg?.packageItem) ? pkg.packageItem : []
  const first = items[0] || {}
  for (const cand of [
    s(feat, "recommendPackageTitle", "recommend_package_title"),
    s(pkg, "userRemark"),
    s(first, "itemTitle", "item_title"),
  ]) {
    if (cand && cand !== "null") return cand
  }
  const tel = s(pkg, "receiverTel", "receiver_tel")
  return tel.length >= 11 ? `手机尾号${tel.slice(7)}的包裹` : "包裹"
}

/** 时间统一成毫秒：接口里可能是秒/毫秒时间戳，也可能是 "2026-11-14 10:22:33" */
function toMs(v: any): number | undefined {
  if (v == null) return undefined
  if (typeof v === "number") return v > 1e12 ? v : v > 1e9 ? v * 1000 : undefined
  const s = String(v).trim()
  if (!s) return undefined
  if (/^\d{13}$/.test(s)) return Number(s)
  if (/^\d{10}$/.test(s)) return Number(s) * 1000
  const m = s.match(/(\d{4})[-/](\d{1,2})[-/](\d{1,2})(?:[ T](\d{1,2}):(\d{1,2}))?/)
  if (!m) return undefined
  return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4] ?? 0), Number(m[5] ?? 0)).getTime()
}

/** 包裹最近更新时间：菜鸟几个接口字段名不一样，按重要性依次试 */
function timeOf(p: any): number | undefined {
  for (const k of [
    "statusUpdateTime", "status_update_time", "gmtModified", "gmt_modified",
    "lastUpdateTime", "last_update_time", "arriveTime", "arrive_time",
    "sendTime", "send_time", "orderCreateTime", "order_create_time",
    "createTime", "create_time", "gmtCreate", "gmt_create",
  ]) {
    const t = toMs(p?.[k])
    if (t) return t
  }
  return undefined
}

/** 我的包裹（含待取件的取件码）。需要淘宝登录态。
 *  opts.recentDays > 0 时只取近 N 天：列表按时间倒序，整页都是旧的就停了，不再翻后面的历史页。 */
export async function fetchMyPackages(opts?: { recentDays?: number; maxPages?: number }): Promise<CnpPackage[] | null> {
  if (!tbHasLogin()) return null
  const recentDays = opts?.recentDays ?? 0
  const maxPages = opts?.maxPages ?? 20
  const cutoff = recentDays > 0 ? Date.now() - recentDays * 86_400_000 : 0
  const out: CnpPackage[] = []
  for (let page = 1; page <= maxPages; page++) {
    const j = await mtopCall(API_LIST, {
      pageSize: 50, currentPage: page,
      needTemporality: false, needDynInfo: NEED_DYN,
    })
    if (!j || !mtopOk(j)) {
      // 已经拿到的部分照用；一页都没拿到就报具体原因，
      // 不要一律报「需要淘宝登录态」——网关超时/风控也会走到这里
      if (out.length) return out
      const ret = mtopRet(j)
      throw new Error(ret ? `菜鸟接口返回 ${ret}` : "菜鸟接口无响应")
    }
    const d = mtopData(j) || {}
    const list: any[] = Array.isArray(d.packages) ? d.packages : []
    let keptOnPage = 0
    for (const p of list) {
      if (!p || typeof p !== "object") continue
      const st = p.packageStation || {}
      const status = s(p, "status", "statusDesc", "packageStatus")
      const updatedAt = timeOf(p)
      // 近 N 天窗口：过期的整条跳过（没时间字段的保留，不能因为接口没给时间就丢当天新单）
      if (cutoff && updatedAt && updatedAt < cutoff) continue
      keptOnPage++
      out.push({
        mailNo: s(p, "mailNo", "mail_no"),
        title: titleOf(p),
        company: s(p, "cpName", "cp_name", "companyName") || s(p, "cpCode", "cp_code"),
        pickupCode: pickupCodeOf(p),
        station: s(st, "pointName", "point_name", "stationName", "name"),
        atStation: !!pickupCodeOf(p) || !DONE_STATUS.has(status.toUpperCase()),
        done: DONE_STATUS.has(status.toUpperCase()),
        status,
        updatedAt,
        eta: etaInObject(p),
      })
    }
    // 列表按时间倒序：这一页没一条落在窗口内，后面的只会更旧，不用再翻
    if (cutoff && out.length > 0 && keptOnPage === 0) break
    const total = parseInt(String(d.totalPage ?? "1"), 10) || 1
    if (page >= total || list.length === 0) break
  }
  return out
}

/** 用取件码索引：运单号 → 取件码（给包裹列表补码用） */
export async function pickupCodeMap(): Promise<Record<string, string> | null> {
  const list = await fetchMyPackages()
  if (!list) return null
  const map: Record<string, string> = {}
  for (const p of list) if (p.mailNo && p.pickupCode) map[p.mailNo.toUpperCase()] = p.pickupCode
  return map
}

/** 登录态自检 */
export async function cainiaoLoginOk(): Promise<boolean> {
  if (!tbHasLogin()) return false
  const j = await mtopCall(API_COUNT, { appName: "GUOGUO" })
  return !!j && mtopOk(j)
}

/**
 * 按运单号识别快递公司（queryCpByMailNo），复用淘宝登录态，不额外要凭证。
 * 未登录或识别不出时返回 null，由调用方决定下一步。
 */
export async function detectCompany(mailNo: string): Promise<{ cpCode: string; cpName: string } | null> {
  const no = (mailNo || "").trim()
  if (!no) return null
  const cj = await mtopCall(API_CP, { mailNo: no })
  if (!cj || !mtopOk(cj)) return null
  const res = mtopData(cj)?.result ?? []
  const first = Array.isArray(res) && res[0] ? res[0] : null
  if (!first) return null
  const cpCode = s(first, "tpCode", "cpCode")
  if (!cpCode) return null
  return { cpCode, cpName: s(first, "tpName", "cpName", "name") }
}

/**
 * 免登录查单号轨迹。不需要登录，只要一个能取到网关 token 的会话。
 * 无物流信息通常是还没揽收扫描，不代表单号错。
 */
export async function trackMailNo(mailNo: string): Promise<TrackResult | null> {
  const no = (mailNo || "").trim()
  if (!no) return null

  let j = await mtopCall(API_PID, { mailNo: no })
  if (!j || !mtopOk(j)) {
    // 降级：先识别快递公司，再走 traceservice
    let cp = ""
    const cj = await mtopCall(API_CP, { mailNo: no })
    const res = cj ? (mtopData(cj)?.result ?? []) : []
    if (Array.isArray(res) && res[0]) cp = s(res[0], "tpCode", "cpCode")
    j = await mtopCall(API_TRACE, {
      mailNo: no, cpCode: cp, actor: "RECEIVER",
      isShowAllDetail: true, isShowExceptionDetail: true, isShowExpressMan: true,
      isShowConsignDetail: true, isShowDeliveryProgress: true, isShowStationProxyOrder: true,
      isShowServiceProvider: true, isStandard: true, isUnique: true, ignoreInvalidNode: true,
    })
    if (!j || !mtopOk(j)) return null
  }

  const d = mtopData(j) || {}
  const arr = d.result
  const pkg = Array.isArray(arr) && arr[0] && typeof arr[0] === "object" ? arr[0] : d
  const company = s(pkg, "cpName", "cp_name", "companyName", "logisticsCompanyName")
    || s(pkg, "cpCode", "cp_code") || "快递"

  const nodes: TrackNode[] = []
  for (const key of ["detailList", "traceList", "transitList"]) {
    const lst = pkg?.[key]
    if (Array.isArray(lst)) {
      for (const nd of lst) {
        if (!nd || typeof nd !== "object") continue
        const time = s(nd, "time", "ocurrTimeStr", "occurTimeStr", "gmtCreate", "statusTime")
        const text = s(nd, "standerdDesc", "statusDesc", "desc", "content", "action")
          || s(nd, "status", "statusCode")
        nodes.push({ time, text })
      }
      break
    }
  }
  return { company, mailNo: no, nodes }
}

/**
 * 把菜鸟返回的取件码合并进本地包裹（按运单号匹配）。
 *
 * 设计说明（跨平台同单号）：
 *  · 去重已经按运单号并过一条（utils/dedupe.ts），码是“多值合并”的（codes[]，第一条展示）。
 *  · 所以这里只负责把菜鸟这一份追加进去：已经有的码不会被覆盖，新码排在后面；
 *    只有本地完全没码时，新码才会变成展示用的 code。
 *  · 结果是“哪个平台有码都能取到”，驿站/快递柜临柜前才刷新也不会漏。
 */
export async function applyPickupCodes(): Promise<number> {
  if (!tbHasLogin()) return 0
  const map = await pickupCodeMap()
  if (!map) return 0
  const list = getPickups()
  let changed = 0
  const next = list.map(p => {
    const no = codeKey(p.mailNo || "")
    if (!no) return p
    const incoming = map[no]
    if (!incoming) return p
    const merged = mergeCodes(p.codes ?? (p.code ? [p.code] : []), incoming)
    const same = merged.length === (p.codes?.length ?? (p.code ? 1 : 0))
    if (same) return p
    changed++
    return { ...p, code: merged[0] ?? p.code, codes: merged.length > 1 ? merged : undefined }
  })
  if (changed > 0) savePickups(next)
  return changed
}

