/**
 * 平台包裹同步：直接复用「快递聚合」里已经跑通的抓取实现（同一套 Keychain Cookie）。
 *  - 发现新订单：淘宝走 WebView 读 Ultron 数据；京东/拼多多各自接口
 *  - 后台刷新：只按已存订单号重新拉物流，不发现新单（轻、不弹窗）
 * 结果写进本脚本的 Pickup，source 标成对应平台，刷新时各走各的。
 */
import type { Pkg } from "./model"
import { classify, isHistoricalPkg, shouldDropPkg, stationHaystack, timeOfTrack } from "./model"
import { Notification } from "scripting"
import { hasLogin as taobaoHasLogin, syncAll as taobaoSyncAll, fetchPackage as taobaoFetch, taobaoHumanVerify } from "./net"
import { jdHasLogin, jdSyncAll, jdFetchPackage, jdResetDevice } from "./jd"
import { pddHasLogin, pddSyncAll, pddFetchPackage } from "./pdd"
import { addPickup, arrivalState, getPickups, getSettings, matchStation, updatePickup, type Pickup } from "../store"
import { extractPickupCode } from "./pickupCode"
import { mergeCodes, codeKey } from "./codes"
import { etaInObject, etaInText, etaTimeInText } from "./eta"
import { notifyArrived } from "./reminders"
import { arrivedAtOf } from "./arrive"
import { companyCode, companyName } from "../theme"
import { markPlatform, platformEnabled, type PlatformId } from "../platforms"
import { fcHasLogin, fcPickToBox, fcWaitPick } from "./fengchao"
import { miHasLogin, miFetchList, miFetchDetail, parseMiTraces, type MiExpressItem } from "./mi"
import { fetchMyPackages as cnFetchMyPackages, cainiaoLoginOk, trackMailNo as cnTrackMailNo } from "./cainiao"
import { notify } from "../ui/notify"
import { warningIconData } from "./notifyIcon"

type Source = "taobao" | "jd" | "pdd" | "fengchao" | "mi" | "cainiao"

/** 京东/拼多多靠隐藏 WebView 抓页面；扩展环境没有这个类时直接跳过，不白等超时 */
export function platformCapability(): { taobao: boolean; jd: boolean; pdd: boolean } {
  let wv = false
  try { wv = typeof WebViewController === "function" } catch { wv = false }
  // 淘宝发现订单也靠 WebView（h5 olist）：以前这里写死 true，
  // 在没有 WebView 的扩展进程里会直接抛错，看起来就是“淘宝同步失败”。
  return { taobao: wv, jd: wv, pdd: wv }
}

const delay = (ms: number) => new Promise<void>(resolve => (setTimeout as any)(resolve, ms))

function nowText(): string {
  const d = new Date()
  const p = (n: number) => String(n).padStart(2, "0")
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
}

/** 平台状态 → 本脚本状态：已签收算已取，其它算待取 */
function pickupStatus(p: Pkg): 1 | 2 {
  return p.status === "delivered" ? 2 : 1
}

function sourceName(s: Source): string {
  return s === "taobao" ? "淘宝" : s === "jd" ? "京东" : s === "fengchao" ? "丰巢"
    : s === "mi" ? "小米快递" : s === "cainiao" ? "菜鸟" : "拼多多"
}

/** 已有的同一条记录：先按平台订单号，再按运单号判断，避免重复加
 *  运单号比较前先归一化：各平台回来的大小写/空格/连字符不一样，
 *  严格 === 会让同一个包裹（SF123… vs sf123…）变成两张卡片。 */
function findExisting(list: Pickup[], s: Source, p: Pkg): Pickup | undefined {
  const byOrder = list.find(x => x.orderId && x.orderId === p.orderId)
  if (byOrder) return byOrder
  if (p.mailNo) {
    const k = codeKey(p.mailNo)
    const byMail = list.find(x => x.mailNo && codeKey(x.mailNo) === k)
    if (byMail) return byMail
  }
  return undefined
}

/** 聚合源（丰巢、菜鸟）只补信息不改归属；电商源只在现有归属也是聚合源时才接管。
 *  否则后同步的平台会把 source 抢走：菜鸟一跑，淘宝/京东的单全变成菜鸟，
 *  而菜鸟没有单条刷新能力，「已取件」时的最后拉一次物流就静默不做了。 */
function nextSource(s: Source, current?: string): Source {
  // 菜鸟、小米、丰巢都是「聚合多平台快递」的源，不能抢走电商单的归属
  const agg = (v?: string) => v === "fengchao" || v === "cainiao" || v === "mi"
  if (agg(s)) return (current ?? s) as Source
  if (!current || agg(current)) return s
  return current as Source
}

/** 平台关闭文案 → 卡片上显示的状态字（取件码位置） */
function closedTextOf(text: string): string {
  const t = (text || "").replace(/\s+/g, "")
  if (/丢失|遗失/.test(t)) return "已丢失"
  if (/退货/.test(t)) return "已退货"
  if (/退款/.test(t)) return "已退款"
  if (/取消/.test(t)) return "已取消"
  return "已关闭"
}

/** 把一条平台包裹写进 Pickup（有就更新，没有就新建） */
function upsert(s: Source, p: Pkg): boolean {
  const list = getPickups()
  const exist = findExisting(list, s, p)
  const idx = companyCode(p.company || "")
  const latestText = (p.latest || "").trim()
  // 没有短信了，驿站归属与取件页归属都从物流文案里推
  const rawArrival = arrivalState(latestText)
  const arrival = rawArrival
  // 与取件页分组、卡片显示用同一段文本：驿站名 + 地址 + 收货地址 + 物流文案。
  // 以前这里多拼了商品名、少拼了收货地址，同样的关键词可能入库时匹配不上、显示时又匹配上了。
  const station = matchStation(stationHaystack({
    courierStationName: p.stationName,
    receiverAddress: p.receiverAddress,
    trackLatest: latestText,
  }))
  // 取件码也从物流文案里取（没有短信导入了）；运单号不是取件码，不拿它充数
  // 取件码：官方字段优先；没有就从全部节点文本里关键词抽（只看最新一条容易漏）
  const allText = [latestText, ...((p.tracks ?? []).map(t => t.text))].filter(Boolean).join("\n")
  const officialCode = (p.pickupCode || "").trim()
  const found = officialCode || (allText ? extractPickupCode([{ text: allText }]) : "")
  const codeText = found && codeKey(found) !== codeKey(p.mailNo ?? p.orderId ?? "") ? found : ""
  // 平台文案里带「预计11月13日送达」：原话和解析后的日期都存，
  // 卡片在途状态直接显示「预计 11月13日」。没有任何平台给稳定的结构化到货时间（丰巢没有）。
  const eta = p.eta || etaInText(latestText) || etaInText(allText)
  const etaAt = p.etaAt || etaTimeInText(p.eta || latestText)?.at || etaTimeInText(allText)?.at

  if (exist) {
    // 平台已关闭（退款/退货/取消）：转终态，不再当待取；取件码位置改显状态字
    if (p.status === "cancelled") {
      const closedText = closedTextOf(latestText)
      const closedNodes = p.tracks && p.tracks.length > 0 ? p.tracks.slice(0, 60) : (exist.trackNodes ?? [])
      const closedChanged = exist.closed !== closedText || latestText !== exist.trackLatest
      if (!closedChanged && exist.status === 2) return false
      updatePickup(exist.uuid, {
        status: 2,
        closed: closedText,
        trackLatest: latestText || exist.trackLatest,
        trackNodes: closedNodes,
        trackUpdatedAt: Date.now(),
      })
      return true
    }
    // 平台给了完整节点就直接用（新→旧）；没有才退回「只记最新一条」
    const official = p.tracks && p.tracks.length > 0 ? p.tracks.slice(0, 60) : null
    const nodes = official ? [...official] : (exist.trackNodes ? [...exist.trackNodes] : [])
    const changed = !!latestText && latestText !== exist.trackLatest
    const nodesChanged = !!official && JSON.stringify(official) !== JSON.stringify(exist.trackNodes ?? [])
    // 菜鸟（聚合源）只给「运输中」这种粗状态，也没有节点：
    // 既不插一条假节点污染轨迹，也不盖掉电商平台更详细的文案
    const coarse = s === "cainiao" && arrival === "transit" && !(p.tracks && p.tracks.length > 0)
    if (coarse && !codeText && !station && !p.stationName && !p.pickupCode) return false
    if (changed && !official && !coarse) nodes.unshift({ time: nowText(), text: latestText })

    // 用户已经点过「已取件」：状态归用户，物流只做记录，不再把包裹拉回取件页
    if (exist.pickedByUser) {
      if (!changed && !nodesChanged) return false
      updatePickup(exist.uuid, {
        trackLatest: latestText,
        trackNodes: nodes.slice(0, 60),
        trackUpdatedAt: Date.now(),
      })
      return true
    }

    const patch: Partial<Pickup> = {
      itemTitle: p.itemTitle || exist.itemTitle,
      mailNo: p.mailNo || exist.mailNo,
      trackCompany: p.company || exist.trackCompany,
      companyName: idx || exist.companyName,
      trackLatest: coarse ? exist.trackLatest : (latestText || exist.trackLatest),
      trackNodes: nodes.slice(0, 60),
      trackUpdatedAt: Date.now(),
      // 聚合源只补取件码/柜机信息，不改归属（见 nextSource）
      source: nextSource(s, exist.source),
      orderId: s === "fengchao" ? exist.orderId : (p.orderId || exist.orderId),
      // 已取走就置为已取；到站可取放回待取；"已签收但没码没驿站"也直接算已取（不然会一直挂在待取）。
      // 已经取过的单不能被迟到的「到达」节点拉回待取。
      status: (() => {
        const want: 1 | 2 = arrival === "picked" ? 2
          : arrival === "arrived" ? (p.status === "delivered" && !codeText && !p.stationName && !station ? 2 : 1)
            : (exist.status ?? 1)
        return exist.status === 2 && want === 1 ? 2 : want
      })(),
      pickedByUser: arrival === "picked" ? false : exist.pickedByUser,
      // 平台还在正常跟踪：清掉之前的已退款/已取消标记（退款撤回/换货重发的场合）
      closed: "",
    }
    // 刚变成已取：把平台节点里的取件时间记下来（卡片显示「取件 X月X日」）
    if (patch.status === 2 && exist.status !== 2 && !exist.pickedAt) {
      patch.pickedAt = arrivedAtOf(nodes) ?? Date.now()
    }
    if (eta) patch.eta = eta
    if (etaAt) patch.etaAt = etaAt
    // 已经到站/已取走：预估到达时间过期了，清掉，卡片改显示到站/取件时间
    if (arrival !== "transit") { patch.eta = undefined; patch.etaAt = undefined }
    // 官方字段优先：收货地用物流页 END_TRACE_CODING（收货地址），没有才退回节点城市；
    // 驿站地址另有 stationName，两者不要混。
    if (p.receiverCity) (patch as any).receiverCity = p.receiverCity
    else if (p.city) (patch as any).receiverCity = p.city
    if (p.receiverAddress) (patch as any).receiverAddress = p.receiverAddress
    if (p.receiverName) (patch as any).receiverName = p.receiverName
    if (p.receiverPhone) (patch as any).receiverPhone = p.receiverPhone
    if (p.stationName) {
      patch.courierStationName = p.stationName
      patch.address = p.stationName
    }
    if (station) { patch.courierStationName = station.name; patch.courierStationUuid = station.uuid }
    // 丰巢在柜信息（一键开柜要的柜机/格口/单件）：有就覆盖，取走后由下次同步自然失效
    if (p.fcBox) patch.fcBox = p.fcBox
    if (arrival === "arrived" && !exist.arrivedAt) patch.arrivedAt = arrivedAtOf(nodes) ?? Date.now()
    // 到站就提醒；重复不提醒靠 notifyArrived 自己的已通知表
    if (arrival === "arrived") {
      void notifyArrived({ ...exist, ...patch, courierStationName: station?.name ?? exist.courierStationName ?? "" })
    }
    // 取件码合并：别的平台给的码不丢，两个都留（卡片上一起显示）
    const baseCodes = (exist.codes ?? (exist.code ? [exist.code] : [])).filter(c => {
      const k = codeKey(c)
      return k !== codeKey(exist.mailNo ?? "") && k !== codeKey(exist.orderId ?? "")
    })
    const merged = mergeCodes(baseCodes, codeText)
    const gained = merged.length > (exist.codes?.length ?? (exist.code ? 1 : 0))
    if (gained) {
      patch.codes = merged
      if (!exist.code || codeKey(exist.code) !== codeKey(merged[0])) patch.code = merged[0]
    }
    // 没新文案、也没驿站/码变化就不写，省一次存储；
    // 但收货人信息是新的时也必须写（首次全量后详情页才能显示姓名/地址）
    const recvChanged = (!!((patch as any).receiverName) && (patch as any).receiverName !== exist.receiverName)
      || (!!((patch as any).receiverAddress) && (patch as any).receiverAddress !== exist.receiverAddress)
    if (!changed && !station && !patch.codes && !recvChanged && !p.fcBox) return false
    updatePickup(exist.uuid, patch)
    return true
  }

  // 新单入库规则：
  //   · 有运单号 = 真快递，发货即入库进包裹页跟踪（揽收/在途都算）
  //   · 到站（arrived）才进取件页 + 发到站通知
  //   · 外卖等无运单号订单永远不导入（它们没有快递流程）
  //   · 已签收的历史订单也不导入（没有跟踪价值）
  if (!p.mailNo) return false
  // 退款/取消、以及已签收却没有任何取件线索的历史单，一律不入库
  if (shouldDropPkg(p)) return false
  if (arrival === "picked") return false
  const inPickupPage = arrival === "arrived"
  if (!latestText) return false

  // 官方完整节点优先：只塞最新一条会让详情页“物流轨迹只有一点点”
  const nodeList = p.tracks && p.tracks.length > 0
    ? p.tracks.slice(0, 60)
    : (latestText ? [{ time: nowText(), text: latestText }] : [])
  // 已签收 + 签收/到站时间超过 7 天 → 历史单，有取件码也不导。
  // （驿站代签的单确实会有码，但几个月前就签收的，用户早取走了）
  if (p.status === "delivered") {
    const signedAt = arrivedAtOf(nodeList) ?? p.lastTrackAt ?? 0
    if (signedAt > 0 && Date.now() - signedAt > 7 * 86400_000) return false
  }
  const newStatus: 1 | 2 = p.status === "delivered" && !codeText && !p.stationName && !station ? 2 : 1
  const created = addPickup({    code: codeText,
    codes: codeText ? [codeText] : [],
    companyName: idx || 1,
    address: station?.name ?? p.stationName ?? "",
    phone: "",
    notes: latestText,
    // 在途单也入库（包裹页跟踪），但没到站前不算待取件——
    // 取件页/小组件按 arrivedAt 区分：没到站的不提醒。
    // 已签收但没码没驿站的（真签收）直接算已取，不要挂在待取。
    status: newStatus,
    pickedAt: newStatus === 2 ? (arrivedAtOf(nodeList) ?? Date.now()) : undefined,
    type: "delivery",
    smsContent: "",
    courierStationName: station?.name ?? p.stationName ?? "",
    courierStationUuid: station?.uuid ?? "",
    itemTitle: p.itemTitle || "",
    mailNo: p.mailNo || "",
    trackCompany: p.company || companyName(idx || 1),
    trackLatest: latestText,
    trackNodes: nodeList,
    trackUpdatedAt: Date.now(),
    // 只有真到站的才写 arrivedAt（取件页“已到站 N 小时”与到站提醒的依据）
    arrivedAt: inPickupPage ? (arrivedAtOf(nodeList) ?? Date.now()) : undefined,
    source: s,
    orderId: p.orderId,
    pickupCode: codeText,
    fcBox: p.fcBox,
    eta,
    etaAt,
  } as any)
  // 收货人信息在 addPickup 的 Partial 之外，直接补写一次（新单详情页才显示姓名/地址）
  const recv: any = {}
  if (p.receiverCity || p.city) recv.receiverCity = p.receiverCity || p.city
  if (p.receiverAddress) recv.receiverAddress = p.receiverAddress
  if (p.receiverName) recv.receiverName = p.receiverName
  if (p.receiverPhone) recv.receiverPhone = p.receiverPhone
  if (Object.keys(recv).length) updatePickup(created.uuid, recv)
  // 只有到站才发通知；在途单静默跟踪
  if (inPickupPage) void notifyArrived(created)
  return true
}

/** 单个平台的同步结论。授权页、平台详情页、通知都只认这一份，
 *  避免「详情页说同步未完成、授权页说未绑定手机号」这种两套说法。 */
export interface PlatformSyncResult {
  id: string
  name: string
  outcome: "ok" | "failed" | "skipped"
  /** 一句人话；ok 时为空串 */
  message: string
  at: number
}

export interface PlatformSyncReport {
  added: number
  updated: number
  /** 兼容旧调用：拼好的 `${平台名}：${原因}` */
  errors: string[]
  /** 主动跳过的平台（如京东冷却）：不是错误，但要让界面能说清楚为什么没数据 */
  skipped?: string[]
  /** 实际真正跑过的平台：用来区分「跑了但为空」和「压根没跑」 */
  ran?: string[]
  /** 按平台 id 索引的结论（新界面请只用这个） */
  results: Record<string, PlatformSyncResult>
}

/** 点「已取件」时最后拉一次物流：把最终节点存下来，之后这个包裹不再更新。
 *  注意：这里只写轨迹字段，不走 upsert——upsert 会把「到站」文案又触发一次到站通知。
 *  所有有轨迹接口的平台都支持；丰巢只在柜件没有轨迹，跳过。 */
export async function finalRefreshForPickup(uuid: string): Promise<void> {
  try {
    const item = getPickups().find(p => p.uuid === uuid)
    if (!item) return
    const src = item.source
    const rawId = String(item.orderId || "").replace(/^(tb|jd|pdd|cn|fc|mi):/, "")
    let latest = ""
    let tracks: { time: string; text: string }[] | null = null
    let company = ""

    if (src === "taobao" && rawId) {
      const fresh = await taobaoFetch(rawId, item as any)
      if (fresh) { latest = fresh.latest || ""; tracks = fresh.tracks ?? null; company = fresh.company || "" }
    } else if (src === "jd" && rawId) {
      const fresh = await jdFetchPackage({ orderId: rawId, itemTitle: item.itemTitle || "", shopName: item.trackCompany || "", statusHint: item.trackLatest || "" } as any)
      if (fresh) { latest = fresh.latest || ""; tracks = fresh.tracks ?? null; company = fresh.company || "" }
    } else if (src === "pdd" && rawId) {
      const fresh = await pddFetchPackage({ orderSn: rawId, itemTitle: item.itemTitle || "", shopName: "", statusHint: item.trackLatest || "" })
      if (fresh) { latest = fresh.latest || ""; tracks = fresh.tracks ?? null; company = fresh.company || "" }
    } else if (src === "cainiao" && item.mailNo) {
      const r = await cnTrackMailNo(String(item.mailNo))
      if (r) { latest = r.nodes[0]?.text || ""; tracks = r.nodes; company = r.company || "" }
    } else if (src === "mi" && item.mailNo) {
      const phones = miPhones()
      if (phones.length > 0) {
        const root = await miFetchDetail({ mailNo: String(item.mailNo), cpName: item.trackCompany || "" } as any, phones)
        const t = parseMiTraces(root)
        if (t.length > 0) { tracks = t; latest = t[0].text }
      }
    }
    if (!latest && !(tracks && tracks.length > 0)) return

    const patch: Partial<Pickup> = { trackUpdatedAt: Date.now() }
    if (latest) patch.trackLatest = latest
    if (tracks && tracks.length > 0) patch.trackNodes = tracks.slice(0, 60)
    if (company) patch.trackCompany = company
    updatePickup(uuid, patch)
  } catch { }
}

/** 平台显示名：以前这里只写了 taobao/jd/kdniao 三个分支，其余全落到「拼多多」，
 *  结果小米/丰巢/菜鸟失败时会弹出「拼多多同步失败」。必须是完整映射。*/
const PLAT_LABEL: Record<string, string> = {
  taobao: "淘宝", jd: "京东", pdd: "拼多多", cainiao: "菜鸟",
  fengchao: "丰巢", mi: "小米快递", kdniao: "快递鸟",
}

/** 鉴权类失败：这几类才算登录失效，其余一次页面没加载出来不能把授权标成失效 */
const AUTH_RE = /未登录|请先登录|还没授权|登录已失效|登录态.{0,6}过期|登录态无效|重新授权|重新登录|FAIL_SYS_SESSION_EXPIRED|SESSION_EXPIRED|401|403/

/**
 * 平台原始错误 → 一句人话。授权页、平台详情页、系统通知都调这一份，
 * 保证同一个故障在任何地方看到的字都一样（用户反馈过两处文案对不上）。
 */
export function platformErrorText(raw: string): string {
  const t = String(raw ?? "").replace(/\s+/g, " ").trim()
  if (!t) return "同步失败"
  if (/未绑定取件手机号/.test(t)) return "未绑定取件手机号，请先绑定"
  if (/人机验证|滑块|需要手动完成/.test(t)) return "需要人机验证，请手动完成"
  if (/限流|排队|大促|访问频繁/.test(t)) return "访问被限流，稍后自动恢复"
  if (/超时|timeout/i.test(t)) return "网络超时，请稍后重试"
  if (AUTH_RE.test(t)) return "登录已失效，请重新授权"
  // 接口返回码/网关异常原样保留，后台报障时能直接对上
  return t.slice(0, 44)
}

/** 记录一个平台的结论（成功/失败/跳过只有一个入口） */
function setResult(report: PlatformSyncReport, id: string, outcome: PlatformSyncResult["outcome"], message: string): void {
  report.results[id] = { id, name: PLAT_LABEL[id] ?? id, outcome, message, at: Date.now() }
}

async function handleError(id: PlatformId, e: any, report: PlatformSyncReport, allowSystemNotify: boolean, allowToast = true): Promise<void> {
  const raw = String(e?.message ?? e)
  const authLike = AUTH_RE.test(raw)
  const name = PLAT_LABEL[id] ?? "该平台"
  const human = platformErrorText(raw)
  setResult(report, id, "failed", human)
  // 失败原因写进共享日志；并记连续失败计数（同一平台连败 3 次 → 气泡+系统通知）
  let failStreak = 0
  try {
    const f = `${FileManager.appGroupDocumentsDirectory}/cc/syncErr.json`
    const prev = FileManager.existsSync(f) ? JSON.parse(FileManager.readAsStringSync(f) || "{}") : {}
    failStreak = Number(prev?.[id]?.streak ?? 0) + 1
    // msg 存归一后的人话（授权页直接展示），raw 留着排查用
    prev[id] = { at: Date.now(), msg: human, raw: raw.slice(0, 200), streak: failStreak }
    FileManager.writeAsStringSync(f, JSON.stringify(prev))
  } catch { }
  if (authLike) {
    markPlatform(id, false, "登录已失效")
    report.errors.push(`${name}：${human}`)
    if (allowToast) notify(`${name}登录已失效，请重新授权`, "warn")
    if (allowSystemNotify && getSettings().syncFailNotify !== false) {
      try {
        Notification.schedule({
          title: `⚠️ ${name}登录已失效`,
          body: "点按打开包裹助手重新授权，之后会自动继续同步",
          iconImageData: await warningIconData(),
          threadIdentifier: `cc.syncauth:${id}`,
          userInfo: { openAuthorize: id },
        })
      } catch { }
    }
  } else {
    report.errors.push(`${name}：${human}`)
    // 真人机验证/滑块类拦截才发可点通知（点开进个人页去手动过验证）；
    // 限流/排队这类会自己恢复，发通知只会打扰（用户实测弹窗太频繁很烦）
    const verifyLike = /人机验证|滑块|需要手动完成|请重新授权/.test(raw)
    if (verifyLike && allowSystemNotify && getSettings().syncFailNotify !== false) {
      try {
        Notification.schedule({
          title: `⚠️ ${name}需要验证`,
          body: "点按打开包裹助手，滑过验证后自动继续同步",
          iconImageData: await warningIconData(),
          threadIdentifier: `cc.syncverify:${id}`,
          userInfo: { openAuthorize: id },
        })
      } catch { }
    }
    // 配置类错误（没绑手机号这类）不会自己好：用户没去处理就一直“连续失败”，
    // 越弹越重没有意义，只保留行内原因。
    const configLike = /未绑定|请先绑定|还没授权|未授权/.test(raw)
    if (failStreak >= 3 && !configLike) {
      // 连续 3 次失败才升级：气泡 + 系统通知（自动化全量时用户不看 App 也能知道）
      if (allowToast) notify(`${name}同步连续失败 ${failStreak} 次：${human}`, "error")
      if (allowSystemNotify && getSettings().syncFailNotify !== false) {
        try {
          Notification.schedule({
            title: `⚠️ ${name}同步连续失败`,
            body: `已连续 ${failStreak} 次失败，最近一次：${raw.slice(0, 80)}`,
            iconImageData: await warningIconData(),
            threadIdentifier: `cc.syncfail:${id}`,
          })
        } catch { }
      }
    } else if (allowToast) {
      // 每次失败都弹带原因的气泡，不用点进授权页才知道
      notify(`${name}同步失败：${human}`, "warn")
    }
  }
}

/* ---- 京东限流冷却：撞上排队页后逐次拉长冷却，让风控自己解除 ----
 * 固定 30 分钟不够：连续撞十几次说明设备已被盯上，要指数退避（最长 6 小时）。*/
const COOL_FILE = () => `${FileManager.appGroupDocumentsDirectory}/cc/jdCooldown.json`
/** 失败冷却时长跟着设置走（默认 30 分钟） */
function coolMs(): number {
  return Math.max(5, Number(getSettings().failCoolMin) || 30) * 60_000
}

function jdCooling(): boolean {
  try {
    if (!FileManager.existsSync(COOL_FILE())) return false
    const v = JSON.parse(FileManager.readAsStringSync(COOL_FILE()) || "{}")
    return Date.now() < (Number(v.until) || 0)
  } catch { return false }
}

function markJdCooling(): void {
  try {
    const dir = `${FileManager.appGroupDocumentsDirectory}/cc`
    if (!FileManager.existsSync(dir)) FileManager.createDirectorySync(dir, true)
    // 固定 30 分钟（用户要求）：指数退避是按“持续被风控”设计的，
    // 而实测那是空态误判，不该越等越久。
    FileManager.writeAsStringSync(COOL_FILE(), JSON.stringify({ until: Date.now() + coolMs(), at: Date.now() }))
  } catch { }
}

/** 京东真同步成功：冷却计数归零，下次不再被退避挡住 */
function clearJdCooling(): void {
  try { FileManager.writeAsStringSync(COOL_FILE(), "{}") } catch { }
}

/** 读某平台当前连续失败次数（handleError 写进 syncErr.json） */
function failStreak(id: string): number {
  try {
    const f = `${FileManager.appGroupDocumentsDirectory}/cc/syncErr.json`
    if (!FileManager.existsSync(f)) return 0
    const prev = JSON.parse(FileManager.readAsStringSync(f) || "{}")
    return Number(prev?.[id]?.streak) || 0
  } catch { return 0 }
}

/** 平台同步成功：清零连续失败计数 */
function clearFailStreak(id: PlatformId) {
  try {
    const f = `${FileManager.appGroupDocumentsDirectory}/cc/syncErr.json`
    if (!FileManager.existsSync(f)) return
    const prev = JSON.parse(FileManager.readAsStringSync(f) || "{}")
    if (prev?.[id]) { delete prev[id]; FileManager.writeAsStringSync(f, JSON.stringify(prev)) }
  } catch { }
}

/* ---------------- 后台刷新：只刷新已有平台包裹 ---------------- */

/** 给单条刷新加超时：网页卡住时不把整轮同步拖死（组件里 18 秒预算很紧） */
function timeoutWrap<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = (setTimeout as any)(() => reject(new Error(`${what}超时`)), ms)
    p.then(v => { clearTimeout(t); resolve(v) }, e => { clearTimeout(t); reject(e) })
  })
}

/** 刷新单条平台包裹；返回是否真的变了 */
async function refreshOne(item: any): Promise<boolean> {
  const s = item.source as Source
  if (s === "taobao") {
    if (!taobaoHasLogin() || !item.orderId) return false
    const rawId = String(item.orderId).replace(/^tb:/, "")
    const fresh = await timeoutWrap(taobaoFetch(rawId, {
      orderId: rawId,
      source: "taobao",
      itemTitle: item.itemTitle || "",
      shopName: "",
      company: item.trackCompany || "",
      mailNo: item.mailNo || "",
      latest: item.trackLatest || "",
      status: "transit",
      updatedAt: item.trackUpdatedAt || 0,
    }), 30000, "淘宝物流")
    // 库里淘宝单的 orderId 存的是 tb:<id>：这里不补前缀就只能靠运单号命中，
    // 运单号还没出来的单会被当成新记录，每轮刷新都多一张卡。
    return upsert("taobao", { ...fresh, orderId: `tb:${rawId}` })
  }
  if (s === "jd") {
    if (!jdHasLogin() || !item.orderId) return false
    const orderId = String(item.orderId).replace(/^jd:/, "")
    const fresh = await timeoutWrap(jdFetchPackage({
      orderId,
      itemTitle: item.itemTitle || "",
      shopName: "",
      statusHint: item.trackLatest || "",
    } as any), 25000, "京东物流页")
    return upsert("jd", { ...fresh, orderId: `jd:${orderId}` } as Pkg)
  }
  if (s === "cainiao") {
    // 菜鸟有「按运单号查轨迹」的接口，不用重拉整个列表
    if (!item.mailNo) return false
    const r = await timeoutWrap(cnTrackMailNo(String(item.mailNo)), 20000, "菜鸟轨迹")
    if (!r || r.nodes.length === 0) return false
    const latest = r.nodes[0]?.text || ""
    if (!latest) return false
    return upsert("cainiao", {
      orderId: item.orderId ?? `cn:${item.mailNo}`,
      itemTitle: item.itemTitle || "",
      shopName: "",
      company: r.company || item.trackCompany || "",
      mailNo: String(item.mailNo),
      latest,
      status: classify(latest),
      updatedAt: Date.now(),
      tracks: r.nodes.slice(0, 60),
    } as Pkg)
  }
  if (s === "mi") {
    const phones = miPhones()
    if (!item.mailNo || phones.length === 0) return false
    const root = await timeoutWrap(miFetchDetail({
      mailNo: String(item.mailNo),
      cpName: item.trackCompany || "",
      logisticsUpdateTime: item.trackUpdatedAt ? new Date(item.trackUpdatedAt).toISOString() : undefined,
    } as any, phones), 20000, "小米轨迹")
    const tracks = parseMiTraces(root)
    if (tracks.length === 0) return false
    const latest = tracks[0].text
    return upsert("mi", {
      orderId: item.orderId ?? `mi:${item.mailNo}`,
      itemTitle: item.itemTitle || "",
      shopName: "",
      company: item.trackCompany || "",
      mailNo: String(item.mailNo),
      latest,
      status: classify(latest),
      updatedAt: Date.now(),
      tracks,
    } as Pkg)
  }
  if (s === "fengchao") {
    // 丰巢没有単件接口：拉一次在柜列表再按运单号对。取走后就不在列表里，
    // 那就什么都不做（不能当成“已取”，它在柜状态本身不说明已取）
    const list = await timeoutWrap(fcWaitPick(), 20000, "丰巢在柜件")
    const k = codeKey(String(item.mailNo || ""))
    const hit = k ? list.find(x => codeKey(x.expressId || "") === k) : undefined
    if (!hit) return false
    const where = [hit.cabinetCode, hit.location].filter(Boolean).join(" ")
    const latest = [
      `快件已投递到丰巢快递柜${where ? `（${where}）` : ""}`,
      hit.code ? `取件码 ${hit.code}` : "",
      "请及时取件",
    ].filter(Boolean).join("，")
    return upsert("fengchao", {
      orderId: item.orderId ?? `fc:${hit.expressId || hit.postId || hit.code}`,
      itemTitle: item.itemTitle || (hit.companyName ? `${hit.companyName} · 丰巢柜` : "丰巢快递柜"),
      shopName: "",
      company: hit.companyName || item.trackCompany || "",
      mailNo: hit.expressId || item.mailNo,
      latest,
      status: "transit",
      updatedAt: Date.now(),
      stationName: [hit.address, hit.cabinetCode].filter(Boolean).join(" ").trim() || "丰巢智能柜",
      pickupCode: hit.code,
      fcBox: fcPickToBox(hit),
    } as Pkg)
  }
  if (s !== "pdd") return false
  if (!pddHasLogin() || !item.orderId) return false
  const orderSn = String(item.orderId).replace(/^pdd:/, "")
  const fresh = await timeoutWrap(pddFetchPackage({
    orderSn,
    itemTitle: item.itemTitle || "",
    shopName: "",
    statusHint: item.trackLatest || "",
  }), 25000, "拼多多物流页")
  return upsert("pdd", { ...fresh, orderId: `pdd:${orderSn}` } as Pkg)
}

/** 每轮最多开多少个网页单（京东/拼多多每单一个 WebView，并发会被风控） */
const PAGE_REFRESH_MAX = 4
/** 网页单之间的间隔，给风控一点喘息 */
const PAGE_REFRESH_GAP = 900

/** 刷新已有平台包裹（不发新单请求，可在后台/通知里调用） */
export async function refreshPlatformParcels(limit = 20): Promise<number> {
  const cap = platformCapability()
  const all = getPickups().filter(p => {
    // 已取 / 已签收的物流不会再变，不再浪费一轮预算去刷
    if (p.pickedByUser) return false
    if (p.status === 2) return false
    if (p.source === "taobao") return cap.taobao
    if (p.source === "jd") return cap.jd
    if (p.source === "pdd") return cap.pdd
    // 聚合源也能刷：菜鸟按运单号查轨迹、小米查详情、丰巢重拉在柜列表
    if (p.source === "cainiao") return taobaoHasLogin()
    if (p.source === "mi") return miHasLogin()
    if (p.source === "fengchao") return fcHasLogin()
    return false
  })
  if (all.length === 0) return 0

  // 最旧优先：以前按「最近更新」排，结果新包裹反复刷、旧包裹永远轮不到 20 条之外
  const targets = [...all]
    .sort((a, b) => (a.trackUpdatedAt || a.createdAt || 0) - (b.trackUpdatedAt || b.createdAt || 0))
    .slice(0, limit)

  let changed = 0

  // 淘宝是纯 HTTP（快、可并发）；京东/拼多多每单开一个网页，串行 + 限额 + 间隔
  const tbList = targets.filter(t => t.source === "taobao")
  // 菜鸟/小米/丰巢也是接口类，不开网页，但串行跑并留点间隔
  const apiList = targets.filter(t => t.source === "cainiao" || t.source === "mi" || t.source === "fengchao")
  const pageList = targets.filter(t => t.source === "jd" || t.source === "pdd").slice(0, PAGE_REFRESH_MAX)

  const tbResults = await Promise.all(tbList.map(t => refreshOne(t).catch(() => false)))
  for (const ok of tbResults) if (ok) changed++

  for (let i = 0; i < apiList.length; i++) {
    const ok = await refreshOne(apiList[i]).catch(() => false)
    if (ok) changed++
    if (i < apiList.length - 1) await delay(200)
  }

  for (let i = 0; i < pageList.length; i++) {
    const ok = await refreshOne(pageList[i]).catch(() => false)
    if (ok) changed++
    if (i < pageList.length - 1) await delay(PAGE_REFRESH_GAP)
  }

  return changed
}

/* ---------------- 手动/打开 App 时的全量同步：发现新订单 ---------------- */

/** 全量同步三个平台（只跑已授权的），把结果并进包裹列表 */
export async function syncPlatformParcels(onProgress?: (text: string) => void, opts?: { silent?: boolean; deadline?: number; force?: boolean; only?: string[]; quietIssues?: boolean }): Promise<PlatformSyncReport> {
  const report: PlatformSyncReport = { added: 0, updated: 0, errors: [], skipped: [], ran: [], results: {} }
  const deadline = opts?.deadline ?? Number.POSITIVE_INFINITY
  const timeUp = () => Date.now() > deadline
  const before = getPickups().length

  // 平台顺序每轮轮换 + 每个平台自己记「上次成功时间」。
  // 组件里预算只有 18 秒，固定顺序会让排在最后那个永远吃不到预算 —— 用户指出的这个是真 bug。
  // only：刚授权完某个平台时只同步它，不要把其它平台也重拉一遍
  const only = opts?.only?.length ? new Set(opts.only) : null
  const ids: string[] = []
  // 未授权不是错误：界面已经有「未授权」状态，再往 errors 里塞一条会让用户以为同步失败
  if (taobaoHasLogin() && platformCapability().taobao && platformEnabled("taobao") && (!only || only.has("taobao"))) ids.push("taobao")
  if (jdHasLogin() && platformCapability().jd && (!only || only.has("jd"))) ids.push("jd")
  if (pddHasLogin() && platformCapability().pdd && (!only || only.has("pdd"))) ids.push("pdd")
  if (fcHasLogin() && (!only || only.has("fengchao"))) ids.push("fengchao")
  if (miHasLogin() && (!only || only.has("mi"))) ids.push("mi")
  // 菜鸟共用淘宝登录态（mtop 直连，不开网页）；没开菜鸟开关就不跑
  if (taobaoHasLogin() && platformEnabled("cainiao") && (!only || only.has("cainiao"))) ids.push("cainiao")

  const succeededAt = readPlatformLast()
  for (const id of rotateOrder(ids)) {
    // 3 小时内成功过就不重拉：App 和组件共用一个时间戳，谁跑过另一边就跳过
    // force=true（用户点「立即同步」）时无视闸门，否则手动同步会被刚跑过的组件卡住。
    if (!opts?.force && Date.now() - (Number(succeededAt[id]) || 0) < fullGapMs()) continue
    if (timeUp()) {
      const msg = "时间不够，已跳过"
      report.errors.push(`${PLAT_LABEL[id] ?? id}：${msg}`)
      report.skipped!.push(msg)
      setResult(report, id, "skipped", msg)
      continue
    }
    // 京东排队页是设备级风控：反复开页会不断刷新冷却计时。撞上后 30 分钟内直接跳过，不再开 WebView
    if (id === "jd" && jdCooling()) {
      // 冷却中是我们主动避开风控，不是故障 —— 不写 errors，但要让界面说清楚
      onProgress?.("京东冷却中，稍后自动恢复…")
      report.skipped!.push("京东冷却中，稍后自动恢复")
      setResult(report, id, "skipped", "冷却中，稍后自动恢复")
      continue
    }
    try {
      report.ran!.push(id)
      if (id === "taobao") {
        onProgress?.("正在读取淘宝订单…")
        // 增量：已签收/已取件、且近 3 天更新过的单不再重拉物流（状态不会变了）
        const skipTb = new Set(
          getPickups()
            .filter(p => p.source === "taobao"
              && (p.status === 2 || p.pickedByUser)
              && Date.now() - (p.trackUpdatedAt ?? p.createdAt) < 3 * 86400_000)
            .map(p => String(p.orderId || "").replace(/^tb:/, ""))
            .filter(Boolean)
        )
        const snap = await (async () => {
          try {
            return await taobaoSyncAll((done: number, total: number) => onProgress?.(`淘宝物流 ${done}/${total}…`), deadline, skipTb)
          } catch (first: any) {
            // 只有真滑块/安全验证才弹页给人；其他错误不打扰
            const needHuman = /人机验证/.test(String(first?.message ?? first))
            if (!needHuman || opts?.silent) throw first
            onProgress?.("淘宝需要验证…")
            const ok2 = await taobaoHumanVerify()
            if (!ok2) throw first
            return await taobaoSyncAll((done: number, total: number) => onProgress?.(`淘宝物流 ${done}/${total}…`), deadline, skipTb)
          }
        })()
        for (const p of snap.packages) {
          const item = { ...p, source: "taobao" as const, orderId: `tb:${p.orderId}` }
          if (upsert("taobao", item)) report.updated++
        }
        markPlatform("taobao", true)
      } else if (id === "jd") {
        onProgress?.("正在读取京东订单…")
        // 不再用「一个京东包裹都没有就拉历史」和 7 天窗口这类猜测：
        // 京东页面自己会报待收货计数，jdSyncAll 拿到 0 就直接判空态成功，一次列表页都不开。
        const list = await jdSyncAll((done: number, total: number) => onProgress?.(`京东物流 ${done}/${total}…`), { wantHistory: false, deadline })
        for (const p of list) {
          const pid = p.orderId.startsWith("jd:") ? p.orderId : `jd:${p.orderId}`
          if (upsert("jd", { ...p, orderId: pid })) report.updated++
        }
        markPlatform("jd", true)
        clearJdCooling()
      } else if (id === "fengchao") {
        onProgress?.("正在读取丰巢快递柜…")
        const list = await fcWaitPick()
        for (const p of list) {
          // 文案要能被 arrivalState 判为「到站可取」（含「已投递」「快递柜」），
          // 同时把取件码写进文案，界面不依赖字段也能看到
          const where = [p.cabinetCode, p.location].filter(Boolean).join(" ")
          const latest = [
            `快件已投递到丰巢快递柜${where ? `（${where}）` : ""}`,
            p.code ? `取件码 ${p.code}` : "",
            "请及时取件",
          ].filter(Boolean).join("，")
          const pkg: Pkg = {
            orderId: `fc:${p.expressId || p.postId || p.code}`,
            itemTitle: p.companyName ? `${p.companyName} · 丰巢柜` : "丰巢快递柜",
            shopName: "",
            company: p.companyName,
            mailNo: p.expressId,
            latest,
            status: "transit",
            updatedAt: Date.now(),
            stationName: [p.address, p.cabinetCode].filter(Boolean).join(" ").trim() || "丰巢智能柜",
            pickupCode: p.code,
            fcBox: fcPickToBox(p),
          }
          // expressId 就是运单号：京东/淘宝/拼多多已有这单时，upsert 会按 mailNo 命中，
          // 只把取件码与柜机信息合进去，不新增卡片
          if (upsert("fengchao", pkg)) report.updated++
        }
        markPlatform("fengchao", true)
      } else if (id === "cainiao") {
        onProgress?.("正在读取菜鸟包裹…")
        // 菜鸟走 mtop 接口（不是网页），复用淘宝登录态；列表按时间倒序，只取近 20 天
        const cnList = await cnFetchMyPackages({ recentDays: 20, maxPages: 4 })
        if (cnList == null) throw new Error("菜鸟需要淘宝登录态，请重新授权")
        for (const c of cnList) {
          if (!c.mailNo) continue
          // 菜鸟返回的是英文状态码（SIGN/CANCEL/TRANSPORT…），不能直接星到卡片上
          const st = String(c.status || "").toUpperCase()
          const latest = /SIGN/.test(st) ? "已签收"
            : /CANCEL|REJECT/.test(st) ? "已取消"
              : /RETURN/.test(st) ? "已退货"
                : /LOST/.test(st) ? "快递丢失"
                  : c.pickupCode ? "快件已到站，可取件"
                    : "运输中"
          const pkg: Pkg = {
            orderId: `cn:${c.mailNo}`,
            itemTitle: c.title,
            shopName: "",
            company: c.company,
            mailNo: c.mailNo,
            latest,
            // CANCEL/REJECT/RETURN/LOST 是终态：要走 cancelled，卡片才会显示「已退款/已退货」
            status: /CANCEL|REJECT|RETURN|LOST/.test(st) ? "cancelled" : c.done ? "delivered" : "transit",
            updatedAt: c.updatedAt ?? Date.now(),
            stationName: c.station || undefined,
            pickupCode: c.pickupCode || undefined,
            eta: c.eta || undefined,
          }
          if (upsert("cainiao", pkg)) report.updated++
        }
        markPlatform("cainiao", true)
      } else if (id === "mi") {
        onProgress?.("正在读取小米快递…")
        // 手机号存共享目录：登录页写、同步读；没有绑定号就没法查列表
        const phones = miPhones()
        if (phones.length === 0) throw new Error("未绑定取件手机号，在平台详情页里绑定")
        const list = await miFetchList(phones)
        // 只做近 20 天的单（列表里带 logisticsUpdateTime，没有时间的保留，不能误杀新单）
        const miCutoff = Date.now() - 20 * 86_400_000
        const miRecent = list.filter((it) => {
          const raw = String(it.logisticsUpdateTime ?? "").trim()
          if (!raw) return true
          const m = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})/.exec(raw)
          if (!m) return true
          const t = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5])).getTime()
          return t >= miCutoff
        })
        // 列表接口不带轨迹：给未签收的单补详情。不按条数限额（那样会“先到先得”，
        // 新单可能一条都没轮到），改按时间维度：只给 3 天内物流有更新的单补，
        // 老单状态不会再变，不花请求。另外留一个 30 条的硬上限防极端情况拖死同步。
        const miDetailFresh = 3 * 86_400_000
        let detailBudget = 30
        for (const it of miRecent) {
          let tracks: { time: string; text: string }[] = []
          const pending = !/已签收|已取|已妥投|已退回/.test(String(it.stateDesc ?? ""))
          const raw2 = String(it.logisticsUpdateTime ?? "").trim()
          const mm = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})/.exec(raw2)
          const updAt = mm
            ? new Date(Number(mm[1]), Number(mm[2]) - 1, Number(mm[3]), Number(mm[4]), Number(mm[5])).getTime()
            : Date.now()
          const fresh = !raw2 || Date.now() - updAt <= miDetailFresh
          if (pending && fresh && detailBudget > 0 && it.mailNo) {
            detailBudget--
            try { tracks = parseMiTraces(await miFetchDetail(it, phones)) } catch { }
            if (detailBudget > 0) await delay(200)
          }
          const pkg = miItemToPkg(it, tracks)
          if (!pkg) continue
          // mailNo 命中已有平台单时只合并取件码/驿站，不新增卡片
          if (upsert("mi", pkg)) report.updated++
        }
        markPlatform("mi", true)
      } else {
        onProgress?.("正在读取拼多多订单…")
        let list: Pkg[] = []
        try {
          list = await pddSyncAll((done: number, total: number) => onProgress?.(`拼多多物流 ${done}/${total}…`), { deadline })
        } catch (first: any) {
          // 只有真的人机验证页才弹窗给用户；限流/排队类等一下自己就过，弹窗反而打断用户
          const needHuman = /人机验证|需要手动完成/.test(String(first?.message ?? first))
          if (needHuman && !opts?.silent) {
            const { pddHumanVerify } = await import("./pdd")
            onProgress?.("拼多多需要验证…")
            if (await pddHumanVerify()) {
              list = await pddSyncAll((done: number, total: number) => onProgress?.(`拼多多物流 ${done}/${total}…`), { deadline })
            } else throw first
          } else throw first
        }
        for (const p of list) {
          const pid = p.orderId.startsWith("pdd:") ? p.orderId : `pdd:${p.orderId}`
          if (upsert("pdd", { ...p, orderId: pid })) report.updated++
        }
        markPlatform("pdd", true)
      }
      markPlatformLast(id)
      clearFailStreak(id as PlatformId)
      setResult(report, id, "ok", "")
    } catch (e) {
      // 京东排队/限流：标记 30 分钟冷却，后续同步（含组件后台）不再撞墙
      if (id === "jd" && /限流|排队|大促/.test(String((e as any)?.message ?? e))) {
        markJdCooling()
        // 连续 3 次自动重置设备已停用（用户要求）：实测所谓“限流”是空态误判，
        // 重置身份只会让用户白重新登录一次。真需要时再打开。
        // const streak = failStreak("jd") + 1
        // if (streak >= 3) { jdResetDevice(); clearFailStreak("jd"); clearJdCooling() ... }
      }
      // 单平台失败不中断后面的平台：继续同步下一个（用户实测京东失败后拼多多没跑）
      // force=用户在前台手动点「立即同步」：只弹气泡，不再发系统通知（前台不需要通知打扰）
      await handleError(id as PlatformId, e, report, !opts?.force, !opts?.quietIssues)
    }
  }

  report.added = Math.max(0, getPickups().length - before)
  report.updated = Math.max(0, report.updated - report.added)
  // 手动同步：只有真的有平台成功才推进「上次同步」时间。
  // 否则全部失败也会把时间往前挪，用户看到「刚同步过」但数据没动。
  if (opts?.force) {
    const now = readPlatformLast()
    const anyOk = ids.some(x => (Number(now[x]) || 0) > (Number(succeededAt[x]) || 0))
    if (anyOk) markFullSyncAt()
  }
  onProgress?.("")
  // 结论文案只认 results：以前用「errors 为空 = 已是最新」，
  // 结果京东冷却跳过也被说成「已是最新」（它是没跑，不是没变化）。
  const values = Object.values(report.results)
  const failed = values.filter(r => r.outcome === "failed")
  const skipped = values.filter(r => r.outcome === "skipped")
  const okCount = values.filter(r => r.outcome === "ok").length
  if (!opts?.silent && !opts?.quietIssues && values.length > 0) {
    if (report.added + report.updated > 0) notify(`同步完成：新增 ${report.added}，更新 ${report.updated}`, "info")
    else if (failed.length === 0 && skipped.length === 0) notify("已是最新", "info")
    // 单个失败已经由 handleError 弹过带原因的气泡，这里只补多平台汇总
    else if (failed.length > 1) notify(`${failed.map(f => f.name).join("、")}同步失败`, "warn")
    else if (okCount === 0) notify(`${skipped[0].name}：${skipped[0].message}`, "info")
  } else if (!opts?.quietIssues && report.added + report.updated > 0) {
    // 后台静默同步：只有真变化才提醒（quietIssues 交给调用方自己出文案）
    notify(`已更新 ${report.added + report.updated} 个包裹`, "info")
  }
  await delay(0)
  return report
}

/* ---------------- 定时全量：App 与小组件共用 ---------------- */

const FULL_KEY = "cc.platform.lastFullSync"
/** 全量发现新订单的间隔（小时），跟设置走（默认 3 小时） */
function fullGapMs(): number {
  return Math.max(1, Number(getSettings().fullSyncHours) || 3) * 3_600_000
}

/* ---------------- 小米快递辅助 ---------------- */

const MI_PHONES_KEY = "cc.mi.phones"

export function miPhones(): string[] {
  const parse = (raw: any): string[] => {
    try {
      const v = raw ? JSON.parse(String(raw)) : []
      return Array.isArray(v) ? v.map(String).filter(x => /^1\d{10}$/.test(x)) : []
    } catch { return [] }
  }
  // 共享域优先：App 里绑的号，小组件进程也要能读到（否则组件同步会误报「未绑定手机号」）
  try {
    const shared = parse(Storage.get<string>(MI_PHONES_KEY, { shared: true }))
    if (shared.length > 0) return shared
  } catch { }
  try { return parse(Storage.get<string>(MI_PHONES_KEY)) } catch { return [] }
}

export function miSetPhones(phones: string[]) {
  const raw = JSON.stringify(phones)
  // 两个域都写：App 自己读私有域，小组件/后台读共享域
  try { Storage.set(MI_PHONES_KEY, raw, { shared: true }) } catch { }
  try { Storage.set(MI_PHONES_KEY, raw) } catch { }
}

/** 小米列表项 → Pkg（字段名以 ExpressAssistant 解析为准，服务端字段名未验证） */
function miItemToPkg(it: MiExpressItem, tracks: { time: string; text: string }[] = []): Pkg | null {
  const mailNo = String(it.mailNo || "").trim()
  if (!mailNo) return null
  const latest = String(it.stateDesc || it.latest || "").trim()
  if (!latest) return null
  // 小米给的是纯物流文案，状态统一走 classify（含已退款/退单）；
  // stateNum 107 = 已签收（对照 ExpressAssistant 的 XiaomiDetail 映射），其余按文案分类
  const stateNum = Number(it.stateNum ?? 0)
  const cls = classify(latest)
  // 退款/取消优先于签收码：107 只说明“已签收”，不能盖掉“退款成功”这类终态
  const status: Pkg["status"] = cls === "cancelled" ? "cancelled" : stateNum === 107 ? "delivered" : cls
  return {
    orderId: `mi:${mailNo}`,
    itemTitle: String(it.productName || it.name || it.cpName || "小米快递"),
    shopName: "",
    company: String(it.cpName || it.provider || ""),
    mailNo,
    latest,
    status,
    tracks: tracks.length > 0 ? tracks : undefined,
    lastTrackAt: timeOfTrack(tracks[0]?.time || "") || undefined,
    updatedAt: Date.now(),
    stationName: String(it.stationName || it.address || "").trim() || undefined,
    // 城市：从地址里抠（地图要“当前位置→收货地”），抠不到就不填
    city: (() => {
      const m = /([\u4e00-\u9fa5]{2,8}(?:市|自治州|地区))/.exec(String(it.address ?? ""))
      return m ? m[1] : undefined
    })(),
    pickupCode: String(it.pickupCode || "").trim() || undefined,
    // 小米列表项可能带「预计…送达」（字段名各版本不一致，浅层扫）
    eta: etaInObject(it) || undefined,
  } as any
}

/* ---- 每平台「上次成功」与轮换指针，都放共享目录，跨进程一致 ---- */
const PLAT_LAST_FILE = () => `${FileManager.appGroupDocumentsDirectory}/cc/platformLast.json`
const ROT_FILE = () => `${FileManager.appGroupDocumentsDirectory}/cc/syncRot.json`

function readJsonFile(path: string): any {
  try {
    if (!FileManager.existsSync(path)) return {}
    return JSON.parse(FileManager.readAsStringSync(path) || "{}") ?? {}
  } catch { return {} }
}

function writeJsonFile(path: string, value: any): void {
  try {
    const dir = `${FileManager.appGroupDocumentsDirectory}/cc`
    if (!FileManager.existsSync(dir)) FileManager.createDirectorySync(dir, true)
    FileManager.writeAsStringSync(path, JSON.stringify(value))
  } catch { }
}

function readPlatformLast(): Record<string, number> {
  const v = readJsonFile(PLAT_LAST_FILE())
  const out: Record<string, number> = {}
  // 以前这里只白名单了 taobao/jd/pdd，导致丰巢/菜鸟/小米的时间
  // 永远读成 0 —— 平台详情页一直显示「从未同步」，点同步也会被判成“没变”。
  for (const k of Object.keys(v || {})) out[k] = Number((v as any)[k]) || 0
  return out
}

function markPlatformLast(id: string): void {
  const v = readJsonFile(PLAT_LAST_FILE())
  v[id] = Date.now()
  writeJsonFile(PLAT_LAST_FILE(), v)
}

/** 每平台上次成功同步的时间（授权页展示用，失败的平台不会有新时间） */
export function platformLastSyncedAt(id: string): number {
  return readPlatformLast()[id] ?? 0
}

/** 每平台最近一次失败（授权页、平台详情页共用同一份文案） */
export function platformLastError(id: string): { at: number; msg: string } | null {
  const v = readJsonFile(`${FileManager.appGroupDocumentsDirectory}/cc/syncErr.json`)
  const e = v?.[id]
  if (!e) return null
  // 旧数据里 msg 存的是原始报错，读的时候也过一遍归一（对已归一的文案是幂等的）
  return { at: Number(e.at) || 0, msg: platformErrorText(String(e.msg ?? e.raw ?? "")) }
}

/** 轮换：每轮把指针往后挪一格，预算总是不够时也不会把同一平台饿死 */
function rotateOrder(ids: string[]): string[] {
  if (ids.length <= 1) return ids
  const v = readJsonFile(ROT_FILE())
  const n = (Number(v?.n ?? 0) || 0) % ids.length
  writeJsonFile(ROT_FILE(), { n: (n + 1) % ids.length })
  return ids.map((_, i) => ids[(i + n) % ids.length])
}

/** 全量同步时间戳放共享目录：App 和小组件是两个进程，各存一份 Storage 就做不到“谁跑过另一边跳过” */
const FULL_FILE = () => `${FileManager.appGroupDocumentsDirectory}/cc/fullSync.json`

export function readFullSyncAt(): number {
  let best = 0
  try {
    const f = FULL_FILE()
    if (FileManager.existsSync(f)) {
      const v = JSON.parse(FileManager.readAsStringSync(f) || "{}")
      best = Number(v?.at ?? 0) || 0
    }
  } catch { }
  try { best = Math.max(best, Number(Storage.get<number>(FULL_KEY) ?? 0) || 0) } catch { }
  return best
}

export function markFullSyncAt(at = Date.now()): void {
  try { Storage.set(FULL_KEY, at) } catch { }
  try {
    const dir = `${FileManager.appGroupDocumentsDirectory}/cc`
    if (!FileManager.existsSync(dir)) FileManager.createDirectorySync(dir, true)
    FileManager.writeAsStringSync(FULL_FILE(), JSON.stringify({ at }))
  } catch { }
}

/** 每 3 小时跑一次全量（发现新订单）。App 与小组件共用一个时间戳，谁先跑过另一边就跳过。
 * budgetMs：到点就停，剩下的下次再补（小组件渲染有硬超时）。
 */
export async function maybeFullSync(budgetMs = 60_000): Promise<number> {
  const cap = platformCapability()
  // 只授权了丰巢/小米的用户以前永远进不来（只判断了淘宝/京东/拼多多），
  // 结果“每 3 小时自动同步”对他们完全失效。
  const anyLogin = taobaoHasLogin() || (cap.jd && jdHasLogin()) || (cap.pdd && pddHasLogin())
    || fcHasLogin() || miHasLogin()
  if (!anyLogin) return 0

  const last = readFullSyncAt()
  if (Date.now() - last < fullGapMs()) return 0
  // 先占位，避免两个进程同时拉同一批
  markFullSyncAt()

  const before = getPickups().length
  let report: PlatformSyncReport | null = null
  try {
    report = await syncPlatformParcels(undefined, { silent: true, deadline: Date.now() + budgetMs })
  } catch { }
  // 本轮平台一个也没成功：把“刚同步过”的时间戳退回去，冷却后就能重试，
  // 否则会白等一个 fullSyncHours 周期（P2-6）。
  try {
    const ran = report?.ran?.length ?? 0
    const okAny = Object.values(report?.results ?? {}).some((r: any) => r?.outcome === "ok")
    if (ran > 0 && !okAny) {
      const cool = Math.max(5, Number(getSettings().failCoolMin) || 30) * 60_000
      markFullSyncAt(Date.now() - fullGapMs() + cool)
    }
  } catch { }
  return Math.max(0, getPickups().length - before)
}
