/**
 * 跨平台去重。
 *
 * 淘宝 / 京东 / 拼多多 都绑了同一个手机号时，同一张运单会被两个平台各同步一条。
 * 这里按运单号把它们并成一条：码合并、轨迹取更新的那条、状态取「已取优先」。
 * 只跑一次（Storage 记版本），避免每次启动都扫全表。
 */
import { getPickups, savePickups, type Pickup } from "../store"
import { codeKey, mergeCodes } from "./codes"

const VERSION_KEY = "cc.dedupe.version"
const VERSION = 1

export function dedupePickups(): number {
  try {
    if (Number(Storage.get<number>(VERSION_KEY) ?? 0) >= VERSION) return 0
  } catch { }

  const list = getPickups()
  const base = new Map<string, Pickup>()
  const out: Pickup[] = []
  const indexOf = new Map<string, number>()
  let removed = 0

  for (const p of list) {
    const key = p.mailNo
      ? `m:${codeKey(p.mailNo)}`
      : (p.orderId ? `o:${p.source ?? ""}:${p.orderId}` : "")
    if (!key) { out.push(p); continue }

    const prev = base.get(key)
    if (!prev) {
      base.set(key, p)
      indexOf.set(key, out.length)
      out.push(p)
      continue
    }

    // 谁更新就把轨迹/时间当基底，另一条只贡献码、商品名、驿站、状态
    const fresher = (p.trackUpdatedAt ?? p.createdAt) > (prev.trackUpdatedAt ?? prev.createdAt) ? p : prev
    const older = fresher === p ? prev : p
    const merged: Pickup = {
      ...fresher,
      // 已取件/用户手动标记优先，别因为合并又变回待取
      status: prev.status === 2 || p.status === 2 ? 2 : fresher.status,
      pickedByUser: prev.pickedByUser || p.pickedByUser,
      pickedAt: prev.pickedAt || p.pickedAt,
      itemTitle: fresher.itemTitle || older.itemTitle,
      courierStationName: fresher.courierStationName || older.courierStationName,
      courierStationUuid: fresher.courierStationUuid || older.courierStationUuid,
      address: fresher.address || older.address,
      phone: fresher.phone || older.phone,
      eta: fresher.eta || older.eta,
      etaAt: fresher.etaAt || older.etaAt,
      mailNo: fresher.mailNo || older.mailNo,
    }
    const codes = mergeCodes([
      ...(prev.codes ?? (prev.code ? [prev.code] : [])),
      ...(p.codes ?? (p.code ? [p.code] : [])),
    ])
    if (codes.length) {
      merged.codes = codes
      merged.code = codes[0]
    }
    const at = indexOf.get(key)!
    out[at] = merged
    base.set(key, merged)
    removed++
  }

  if (removed > 0) savePickups(out)
  try { Storage.set(VERSION_KEY, VERSION) } catch { }
  return removed
}
