/**
 * 位置提醒 = 系统的地理围栏通知（LocationNotificationTrigger / UNLocationNotificationTrigger）。
 * iOS 自己监视区域、自己投递，不需要 App 在后台运行，也不会开 GPS 持续定位。
 * 这里只负责把「已保存的位置」和「系统里已排的围栏」对齐：
 * 先把缺的补排进去，再清掉不再需要的那几条。
 *
 * 顺序很关键：以前是「先全清、再重建」，重建一旦失败（例如定位权限不够，
 * schedule 返回 false）就变成一条都不剩——开关看着是开的，实际永远不响。
 * 现在先加后删，失败时至少保留原来那条。
 */
import { Notification } from "scripting"
import { getLocations } from "../store"

type Req = { identifier: string, content?: any, trigger?: any }

/** 当前定位授权等级。
 *  `startUpdatingLocation({requestAlwaysAuthorization:true})` 会返回系统实际给的 mode，
 *  顺手请求一次「始终」升级（系统只弹一次）。拿到后立刻 stop，不会持续定位。
 *  注意 Location 是**全局**，不能从 "scripting" import，否则是 undefined。 */
export type LocMode = "always" | "whenInUse" | "denied" | "unknown"

export async function locationMode(): Promise<LocMode> {
  const g: any = typeof Location === "undefined" ? null : Location
  if (!g) return "unknown"
  try {
    const r: any = await Promise.race([
      g.startUpdatingLocation({ requestAlwaysAuthorization: true }),
      new Promise(res => setTimeout(() => res("timeout"), 5000)),
    ])
    if (r === "timeout" || r == null) return "unknown"
    const m = typeof r === "object" ? r.mode : null
    return m === "always" ? "always" : m === "whenInUse" ? "whenInUse" : "unknown"
  } catch {
    // 定位服务关闭 / 被拒时这里会抛
    return "denied"
  } finally {
    try { g.stopUpdatingLocation() } catch { }
  }
}

export function locationModeText(m: LocMode): string {
  return m === "always" ? "始终" : m === "whenInUse" ? "仅使用期间" : m === "denied" ? "未授权" : "未知"
}

const TAG = "region"

/** 从已排通知里认出地理围栏，并取出它属于哪个位置（userInfo.region） */
function regionOf(r: Req): string | null {
  try {
    if (!(r.trigger instanceof LocationNotificationTrigger)) return null
    const id = (r.content as any)?.userInfo?.[TAG]
    return typeof id === "string" && id ? id : null
  } catch { return null }
}

/** 半径读不出来就当作没变，避免无谓地重排（重排就可能重复提醒） */
function radiusOf(r: Req): number | null {
  try {
    const v = r.trigger?.region?.radius
    return typeof v === "number" ? v : null
  } catch { return null }
}

export async function syncLocationReminders(): Promise<boolean> {
  const want = getLocations().filter(l => l.enabled && l.latitude != null && l.longitude != null)
  // 没有启用项也要继续清理旧围栏；删除最后一个位置/全部关闭时这里不能早退。
  if (want.length > 0) {
  // 没有「始终」时地理围栏不会投递，排了也是假开启
  const mode = await locationMode()
  if (mode !== "always" && mode !== "unknown") return false
  }

  let pend: Req[] = []
  try { pend = (await Notification.getAllPendingsOfCurrentScript()) as any[] } catch { }

  // 现有围栏，按位置 id 索引
  const live = new Map<string, Req>()
  const untagged: Req[] = []
  for (const r of pend) {
    if (!(r.trigger instanceof LocationNotificationTrigger)) continue
    const id = regionOf(r)
    if (id) live.set(id, r)
    else untagged.push(r)   // 老版本排的、没有标记的
  }

  let ok = true
  const keep = new Set<string>()

  for (const l of want) {
    const cur = live.get(l.id)
    const r = radiusOf(cur as Req)
    const lat = l.latitude as number
    const lng = l.longitude as number
    if (cur && (r == null || r === l.radius)) { keep.add(cur.identifier); continue }
    try {
      const done = await Notification.schedule({
        title: "位置提醒",
        body: `${l.arriveAtArrival ? "到达" : "离开"}${l.placeName}时提醒你取件`,
        userInfo: { [TAG]: l.id },
        trigger: new LocationNotificationTrigger({
          region: {
            identifier: l.id,
            center: { latitude: lat, longitude: lng },
            radius: l.radius,
            notifyOnEntry: l.arriveAtArrival,
            notifyOnExit: !l.arriveAtArrival,
          },
          repeats: true,
        }),
      })
      if (!done) { ok = false; if (cur) keep.add(cur.identifier) }
      // 新排成功就把旧的那条（半径/方向改过的）去掉，避免同一次进出自带两条
      else if (cur) { try { await Notification.removePendings([cur.identifier]) } catch { } }
    } catch { ok = false; if (cur) keep.add(cur.identifier) }
  }

  // 清掉不再需要的：停用的、删掉的位置、以及没有标记的老围栏
  const stale = [...live.values()].filter(r => !keep.has(r.identifier)).map(r => r.identifier)
    .concat(untagged.map(r => r.identifier))
  if (stale.length) {
    try { await Notification.removePendings(stale) } catch { ok = false }
  }
  return ok
}
