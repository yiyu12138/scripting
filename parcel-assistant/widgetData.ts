// 小组件数据层：只读取本机存储，不做网络请求（同步由 widget 入口统一触发）
import { getPickups, getSettings, type Pickup } from "./store"
import { isAwaitingPickup, isTransitPkg, sourceOf } from "./utils/model"

/** 小组件上次成功同步的时间（毫秒） */
export const WIDGET_SYNC_KEY = "cc.widget.lastSync"
/** 小组件在桌面上真正渲染过的时间：用来判断用户到底有没有添加小组件 */
export const WIDGET_SEEN_KEY = "cc.widget.seen"
/** 小组件超过这个时间没渲染，就当它已被移除（删除组件后 iOS 不会再回调，只能靠时效） */
export const WIDGET_SEEN_TTL = 2 * 24 * 3600 * 1000

export function widgetSeenAt(): number {
  const legacy = Number(Storage.get<number>(WIDGET_SEEN_KEY) ?? 0) || 0
  let rendered = 0
  try { rendered = Number(String(Storage.get<string>("cc.widget.render", { shared: true }) || "").split("|")[0]) || 0 } catch { }
  const v = Math.max(legacy, rendered)
  if (!isFinite(v)) return 0
  return Date.now() - v <= WIDGET_SEEN_TTL ? v : 0
}

export interface WidgetAvatar {
  mode: "none" | "emoji" | "photo"
  emoji?: string
  photo?: string
}

/** 用户当前设置的头像 */
export function widgetAvatar(): WidgetAvatar {
  const s = getSettings()
  return { mode: s.avatarMode ?? "none", emoji: s.avatarEmoji, photo: s.avatarPhoto }
}

export interface WidgetPack {
  uuid: string
  /** 卡片主码：有取件码就是取件码，否则是运单号 */
  code: string
  companyName: number
  company: string
  station: string
  itemTitle: string
  /** 最新一条轨迹文案 */
  latest: string
  /** 更新时间（用于排序与「x 分钟前」） */
  updatedAt: number
  mailNo?: string
  eta?: string
  /** 同一包裹的其它取件码 */
  codes?: string[]
  /** 来源平台（显示的卡片要在商品名前带平台小标） */
  source?: string
}

/** 待取包裹：按最近更新排序（与取件页同一口径） */
export function widgetPacks(limit = 8): { list: WidgetPack[]; total: number } {
  return collect(p => isAwaitingPickup(p), limit)
}

/** 在途包裹：已发货、还没到站签收。
 *  原来这里写的是 `p.status === 0`，而本地状态只有 1/2，所以「在途」永远是空的。 */
export function widgetTransit(limit = 6): { list: WidgetPack[]; total: number } {
  return collect(p => isTransitPkg(p), limit)
}

function collect(keep: (p: any) => boolean, limit: number): { list: WidgetPack[]; total: number } {
  const hit = getPickups().filter(keep)
  const sorted = [...hit].sort(
    (a, b) => (b.trackUpdatedAt ?? b.createdAt) - (a.trackUpdatedAt ?? a.createdAt),
  )
  const list = sorted.slice(0, limit).map(toPack)
  return { list, total: hit.length }
}

function toPack(p: any): WidgetPack {
  return {
    uuid: p.uuid,
    code: p.code || p.mailNo || "",
    companyName: p.companyName,
    company: p.trackCompany || "",
    station: p.courierStationName || p.address || "",
    itemTitle: p.itemTitle || "",
    latest: p.trackLatest || p.notes
      || (p.trackNodes && p.trackNodes.length > 0 ? p.trackNodes[p.trackNodes.length - 1].text : ""),
    updatedAt: p.trackUpdatedAt ?? p.createdAt,
    mailNo: p.mailNo,
    eta: p.eta,
    codes: p.codes,
    source: sourceOf(p),
  }
}

export interface WidgetVM {
  /** 待取件 */
  pending: WidgetPack[]
  pendingTotal: number
  /** 在途（已发货、还没到站） */
  transit: WidgetPack[]
  transitTotal: number
  lastSync: number
  avatar: WidgetAvatar
  /** 是否显示在途包裹 */
  showTransit: boolean
  /** 第二行优先显示商品名还是物流动态 */
  subtitle: "item" | "track"
}

/** 给小组件渲染用的一份快照 */
export function buildWidgetVM(): WidgetVM {
  const s = getSettings()
  const showTransit = s.widgetShowTransit !== false
  const pending = widgetPacks(10)
  const transit = showTransit ? widgetTransit(6) : { list: [] as WidgetPack[], total: 0 }
  return {
    pending: pending.list,
    pendingTotal: pending.total,
    transit: transit.list,
    transitTotal: transit.total,
    lastSync: widgetLastSync(),
    avatar: widgetAvatar(),
    showTransit,
    subtitle: s.widgetSubtitle === "track" ? "track" : "item",
  }
}

export function widgetLastSync(): number {
  const v = Storage.get<number>(WIDGET_SYNC_KEY)
  return typeof v === "number" ? v : 0
}

export function markWidgetSynced(at = Date.now()) {
  try { Storage.set(WIDGET_SYNC_KEY, at) } catch { }
}


const p2 = (n: number) => String(n).padStart(2, "0")

/** 同步时间文案：今天只显示 HH:mm，昨天/更早带日期 */
export function syncLabel(ts: number, now = Date.now()): string {
  if (!ts) return "尚未同步"
  const d = new Date(ts)
  const t = `${p2(d.getHours())}:${p2(d.getMinutes())}`
  const today = new Date(now)
  const sameDay = d.getFullYear() === today.getFullYear() && d.getMonth() === today.getMonth() && d.getDate() === today.getDate()
  if (sameDay) return `${t} 同步`
  const y = new Date(now - 86_400_000)
  const isYesterday = d.getFullYear() === y.getFullYear() && d.getMonth() === y.getMonth() && d.getDate() === y.getDate()
  if (isYesterday) return `昨天 ${t} 同步`
  return `${d.getMonth() + 1}月${d.getDate()}日 ${t} 同步`
}
