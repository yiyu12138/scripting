import { parseTrackTime } from "./arrive"

/** 一条包裹记录（对应一笔订单的物流） */
export interface Pkg {
  /** 平台内订单号；拼多多带 pdd: 前缀，京东带 jd: 前缀 */
  orderId: string
  /** 来源平台；manual 表示手动搜索添加的运单号 */
  source?: "taobao" | "pdd" | "jd" | "manual" | "fengchao" | "mi"
  /** 商品标题 */
  itemTitle: string
  /** 店铺名 */
  shopName: string
  /** 快递公司，如「中通快递」 */
  company: string
  /** 运单号，部分代收点件可能为空 */
  mailNo: string
  /** 最新物流文案（原始，来自官方物流页） */
  latest: string
  /** 归类状态；cancelled = 退款/退货/交易关闭，终态不再跟踪 */
  status: "transit" | "delivered" | "none" | "unshipped" | "cancelled"
  /** 本条记录刷新时间 */
  updatedAt: number
  /** 平台官方给的完整节点（新→旧），有就用它覆盖本地拼接的 trackNodes */
  tracks?: { time: string; text: string }[]
  /** 最新一条节点的真实时间（毫秒）；用来判「历史订单」要不要导 */
  lastTrackAt?: number
  /** 官方给的城市 / 驿站名（物流页 cityName、代收点 address） */
  city?: string
  stationName?: string
  /** 平台已明确终态（已完成/已关闭且拿不到轨迹），新建时不要导入 */
  stale?: boolean
  /** 官方给的取件码（有就优先用，没有走关键词识别） */
  pickupCode?: string
  /** 平台文案里的「预计送达」原话 / 解析出的到达日期
   *  （各平台都只有文案级，没有稳定的结构化字段；丰巢没有） */
  eta?: string
  etaAt?: number
  /** 丰巢在柜信息：详情页一键开柜要用 */
  fcBox?: import("./fengchao").FcBoxMeta
  /** 收货地址/收货城市（淘宝物流页 END_TRACE_CODING 给的是收货地，不是驿站） */
  receiverCity?: string
  receiverAddress?: string
  /** 收货人姓名 + 掩码手机号 */
  receiverName?: string
  receiverPhone?: string
}

export interface Snapshot {
  packages: Pkg[]
  /** 上次整体同步（含新订单发现）时间 */
  syncedAt: number
  /** 上次「完整的」全平台同步时间，小组件用它判断要不要每 6 小时全量同步 */
  fullSyncAt?: number
}

export const COOKIE_KEY = "taobao.tracking.cookies"

const DELIVERED = /已签收|已送达|已取出|已领取|已投递|已代收|签收|已妥收|已取件/
const UNSHIPPED = /待发货|未发货|等待发货|等待商家发货|商家备货|备货中|待成团|拼单中|已下单|待出库|正在出库|准备出库|仓库处理中|拣货/
const TRANSIT = /运输中|派送|派件|已发出|已揽收|揽收|中转|发往|到达|待取件|投递中|运输|已发货/

/** 待取（真的能去取了）：有到站时间，或有取件码（码≠运单号）。
 *  配送中/运输中不算——人还在路上取不了；这类只留在「包裹」页看。 */
export function isAwaitingPickup(p: any): boolean {
  if ((p?.status ?? 1) >= 2 || p?.pickedByUser) return false
  // 平台已退款/退货/取消：终态，不能再算待取
  if (p?.closed) return false
  if (p?.arrivedAt) return true
  const norm = (v: any) => String(v ?? "").replace(/[\s-]/g, "").toLowerCase()
  const c = String(p?.code ?? "").trim()
  if (c && norm(c) !== norm(p?.mailNo)) return true
  if (Array.isArray(p?.codes) && p.codes.length > 0) return true
  return false
}

/** 在途：未取、未到站——只该出现在包裹页的「在途」与小组件在途区，
 *  不进取件页、不进灵动岛、不排超时提醒。
 *  以前各处各写一套（有的按 status、有的按商品文案正则），同一个包裹在不同页面归属不同。*/
export function isTransitPkg(p: any): boolean {
  if ((p?.status ?? 1) >= 2 || p?.pickedByUser || p?.closed) return false
  if ((p?.type ?? "delivery") !== "delivery") return false
  return !isAwaitingPickup(p)
}

/** 驿站匹配用的一段文：入库、取件页分组、卡片显示都用这一份。
 *  以前入库看「物流文案 + 商品名」、取件页看「驿站名 + 地址 + 短信」，
 *  同一张卡片可能入库时算没匹配、分组时又匹配上了。 */
export function stationHaystack(p: any): string {
  return [p?.courierStationName, p?.address, p?.receiverAddress, p?.trackLatest, p?.smsContent]
    .map((x: any) => String(x ?? "").trim())
    .filter(Boolean)
    .join(" ")
}

/** 卡片右侧那一行时间的语义：在途=更新、待取=到站、已取=取件、已关闭=关闭。
 *  不再统一显示 codeTime（那是入库时间，同一批同步的全是同一天）。 */
export function pickupTimeOf(p: any): { label: string; at: number } {
  const nodeAt = parseTrackTime(p?.trackNodes?.[0]?.time) || Number(p?.lastTrackAt) || 0
  const fallback = Number(p?.trackUpdatedAt) || Number(p?.createdAt) || 0
  if (p?.closed) return { label: "关闭", at: nodeAt || fallback }
  if ((p?.status ?? 1) >= 2 || p?.pickedByUser) {
    return { label: "取件", at: Number(p?.pickedAt) || nodeAt || fallback }
  }
  if (isAwaitingPickup(p)) return { label: "到站", at: Number(p?.arrivedAt) || nodeAt || fallback }
  return { label: "更新", at: nodeAt || fallback }
}

/** 毫秒 → 「11月13日」 */
export function dateText(ts: number): string {
  if (!ts || !isFinite(ts)) return ""
  const d = new Date(ts)
  return `${d.getMonth() + 1}月${d.getDate()}日`
}

/** 卡片第二行该写什么：商品名 > 来源平台名 > 快递公司名。
 *  快捷指令导入的包裹没有商品名，itemTitle 存的就是平台名（转转/抖音…）。
 *  老数据把「中通快递 包裹」当商品名存过，那不是名字，得回落成快递公司名。
 *  三处卡片（主列表/驿站网格/全部列表）共用这一份，否则会出现同一包裹两种叫法。 */
export function cardTitleOf(p: any, label: string): string {
  const raw = `${p?.userTitle || p?.itemTitle || ""}`.trim()
  if (!raw) return label
  if (!p?.srcApp && /^.{2,8}\s*包裹$/.test(raw)) return label
  return raw
}

/** 来源平台：老数据没存 source，就按 orderId 前缀（tb:/jd:/pdd:）推；都没有就不归类（不乱猜） */
export function sourceOf(p: any): "taobao" | "jd" | "pdd" | undefined {
  const s = p?.source
  if (s === "taobao" || s === "jd" || s === "pdd") return s
  const id = String(p?.orderId ?? "")
  if (id.startsWith("jd:")) return "jd"
  if (id.startsWith("pdd:")) return "pdd"
  if (id.startsWith("tb:")) return "taobao"
  return undefined
}

/** 订单已关闭：退款 / 退货 / 取消 / 交易关闭。
 *  只能拿订单状态或最新节点判，不能拿整页正文（页面上永远有「申请退款」按钮）。 */
export function closedOrderStatus(text: string): Pkg["status"] | undefined {
  const value = (text || "").replace(/\s+/g, "")
  // 否定词优先：「退款失败」「退款已撤销」不代表这单废了
  if (/部分退款|退款失败|退款关闭|退款申请关闭|取消退款|撤销退款|退款已撤销|取消退货|撤销退货/.test(value)) return undefined
  if (/退款成功|退款完成|已退款|全额退款|交易关闭|交易已关闭|订单关闭|订单已关闭|订单取消|订单已取消|已取消订单|退货退款中|退货退款成功|退货中|退货完成|退货成功|退单成功/.test(value)) return "cancelled"
  if (/^(已取消|已退货|退款中|退款处理中|等待退款|退款申请中|售后退款中)$/.test(value)) return "cancelled"
  return undefined
}

/** 把官方物流文案归类成四种状态：已签收 / 未发货 / 在途 / 无物流 */
export function classify(latest: string): Pkg["status"] {
  const text = (latest || "").trim()
  if (!text) return "none"
  // 订单关闭优先于发货/签收节点：退款成功的单不该继续显示在途
  if (closedOrderStatus(text)) return "cancelled"
  if (DELIVERED.test(text)) return "delivered"
  if (UNSHIPPED.test(text)) return "unshipped"
  if (TRANSIT.test(text)) return "transit"
  return "transit"
}

/* ---------------- 官方状态 / 时间 ---------------- */

/** 官方物流状态码 → 内部状态。只认有把握的，其余返回 null 走关键词兜底 */
export function statusFromCode(code: string): Pkg["status"] | null {
  const c = (code || "").trim().toUpperCase()
  if (!c) return null
  if (/^(SIGN|SIGNED|DELIVERED|RECEIVED|PICKED|TAKED)$/.test(c)) return "delivered"
  if (/^(TRANSIT|TRANSPORT|DELIVERING|DISPATCH|ACCEPT|GOT|SEND|ARRIVE|ONSALE)/.test(c)) return "transit"
  if (/^(UNSEND|WAIT_SEND|NOSEND|PENDING)/.test(c)) return "unshipped"
  return null
}

/** 节点时间文转毫秒：「2026-11-09 09:35:34」「11-09 09:35」「08-07 18:59」都行 */
export function timeOfTrack(text: string): number {
  const s = (text || "").trim()
  let m = /^(\d{4})-(\d{1,2})-(\d{1,2})[ T](\d{1,2}):(\d{2})/.exec(s)
  if (m) return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5])).getTime()
  m = /^(\d{1,2})-(\d{1,2})\s+(\d{1,2}):(\d{2})/.exec(s)
  if (!m) return 0
  const now = new Date()
  const d = new Date(now.getFullYear(), Number(m[1]) - 1, Number(m[2]), Number(m[3]), Number(m[4]))
  if (d.getTime() - Date.now() > 7 * 86400_000) d.setFullYear(d.getFullYear() - 1)
  return d.getTime()
}

/** 不该进列表的包裹：退款/取消，或已经签收的历史单。
 *  已签收有两种：真签收（人拿到手了）和驿站代签（包裹还在驿站，有码）。
 *  没有任何取件线索的已签收 —— 当历史单丢掉。 */
export function shouldDropPkg(p: Pkg): boolean {
  if (p.status === "cancelled") return true
  if (p.status !== "delivered") return false
  if (isHistoricalPkg(p)) return true
  const stationLike = /驿站|快递柜|代收点|自提|智能柜|丰巢|菜鸟/.test(p.latest || "") || !!p.stationName
  if (!p.pickupCode && !stationLike && !p.lastTrackAt) return true
  return false
}

/** 历史已签收：已签收超过 7 天就不该再导入（三个平台共用） */
const HISTORY_DAYS = 7
export function isHistoricalPkg(p: Pkg): boolean {
  if (p.stale) return true
  if (p.status !== "delivered") return false
  if (!p.lastTrackAt) return false
  return Date.now() - p.lastTrackAt > HISTORY_DAYS * 86400_000
}

export function statusLabel(status: Pkg["status"]): string {
  if (status === "cancelled") return "已退款/退单"
  if (status === "delivered") return "已签收"
  if (status === "unshipped") return "未发货"
  if (status === "transit") return "在途"
  return "无物流"
}



/** 展示用短标题：去掉营销后缀，过长截断 */export function shortTitle(title: string, max = 18): string {
  let t = (title || "").replace(/\s+/g, " ").trim()
  if (!t) return "（未命名商品）"
  if (t.length <= max) return t
  return t.slice(0, max) + "…"
}

function parseSnapshot(raw: string | null): Snapshot | null {
  if (!raw) return null
  try {
    const v = JSON.parse(raw)
    if (v && Array.isArray(v.packages)) return v as Snapshot
  } catch { }
  return null
}





export function timeText(ts: number): string {
  if (!ts) return "尚未同步"
  const d = new Date(ts)
  const hm = `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`
  const today = new Date()
  const sameDay = d.getFullYear() === today.getFullYear() && d.getMonth() === today.getMonth() && d.getDate() === today.getDate()
  return sameDay ? `今天 ${hm}` : `${d.getMonth() + 1}/${d.getDate()} ${hm}`
}
