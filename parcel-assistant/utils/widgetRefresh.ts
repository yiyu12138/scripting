/**
 * 小组件轻量刷新（v21）：
 * - 平台单（taobao/pdd/jd）走平台自身接口（复用 sync.ts 的 refreshOne 分派线路）
 * - 其余（手动/快递鸟/kdniao）走快递鸟批量查轨迹
 * - 分批并发：每批 15 个，批间隔 300ms，最多 3 批（45 单），总预算默认 8 秒
 * 返回 key（mailNo 或 orderId）→ 变化字段 的 Map，由调用方合并回主脚本快照。
 */
import { extractPickupCode, pickupCodeInText } from "./pickupCode"
import { mergeCodes } from "./codes"
import { queryTracking } from "../kdniao"
import { fetchPackage as taobaoFetchPackage } from "./net"
import { jdFetchPackage } from "./jd"
import { pddFetchPackage } from "./pdd"

const ARRIVED_RE = /待取件|已到站|已到达|已投递|已暂存|已存放|已放入|已代收|请及时取|请及时领取|凭取件码|待领取|快递柜|驿站|代收点/

/** 快递鸟线路：单号查轨迹，返回变化字段 */
async function refreshViaKdniao(no: string, shipperCode?: string): Promise<Partial<any> | null> {
  try {
    const r = await queryTracking(no, { shipperCode })
    const newCode = extractPickupCode((r.nodes || []).map((n: any) => ({ text: String(n?.text ?? n) })))
      || pickupCodeInText(String(r.latest || ""))
    const u: any = {
      trackLatest: String(r.latest || "").replace(/\s+/g, " "),
      trackUpdatedAt: Date.now(),
    }
    if (r.nodes) u.trackNodes = r.nodes
    if (ARRIVED_RE.test(String(r.latest || ""))) u.arrivedAt = Date.now()
    if (newCode) { u.codes = mergeCodes([], newCode); u.code = newCode }
    return u
  } catch {
    return null
  }
}

/** 平台线路：查平台包裹最新状态（与 sync.ts refreshOne 同一接口） */
async function refreshViaPlatform(src: string, orderId: string, pkg: any): Promise<Partial<any> | null> {
  try {
    if (src === "jd") {
      const fresh = await jdFetchPackage({
        orderId: orderId.replace(/^jd:/, ""),
        itemTitle: pkg.itemTitle || "",
        shopName: pkg.shopName || "",
        statusHint: pkg.trackLatest || pkg.latest || "",
      })
      return fresh ? {
        trackLatest: String(fresh.latest || "").replace(/\s+/g, " "),
        trackUpdatedAt: Date.now(),
        status: fresh.status === "delivered" ? 2 : (fresh.status === "transit" ? 1 : (pkg.status ?? 1)),
        mailNo: fresh.mailNo || pkg.mailNo,
        itemTitle: fresh.itemTitle || pkg.itemTitle,
      } : null
    }
    if (src === "pdd") {
      const fresh = await pddFetchPackage({
        orderSn: orderId.replace(/^pdd:/, ""),
        itemTitle: pkg.itemTitle,
        shopName: pkg.shopName,
        statusHint: pkg.trackLatest || pkg.latest,
      })
      return fresh ? {
        trackLatest: String(fresh.latest || "").replace(/\s+/g, " "),
        trackUpdatedAt: Date.now(),
        status: fresh.status === "delivered" ? 2 : (fresh.status === "transit" ? 1 : (pkg.status ?? 1)),
        mailNo: fresh.mailNo || pkg.mailNo,
        itemTitle: fresh.itemTitle || pkg.itemTitle,
      } : null
    }
    const fresh = await taobaoFetchPackage(orderId, pkg)
    return fresh ? {
      trackLatest: String(fresh.latest || "").replace(/\s+/g, " "),
      trackUpdatedAt: Date.now(),
      status: fresh.status === "delivered" ? 2 : (fresh.status === "transit" ? 1 : (pkg.status ?? 1)),
      mailNo: fresh.mailNo || pkg.mailNo,
      itemTitle: fresh.itemTitle || pkg.itemTitle,
    } : null
  } catch {
    return null
  }
}

export async function refreshMailNos(
  items: Array<{ no?: string; orderId?: string; source?: string; shipperCode?: string; pkg?: any }>,
  opts?: { deadline?: number },
): Promise<Map<string, Partial<any>>> {
  const out = new Map<string, Partial<any>>()
  const deadline = opts?.deadline ?? Date.now() + 8000
  const timeUp = () => Date.now() > deadline
  const BATCH = 15
  for (let i = 0; i < items.length && i < 45; i += BATCH) {
    if (timeUp()) break
    const batch = items.slice(i, i + BATCH)
    await Promise.all(batch.map(async it => {
      let u: Partial<any> | null = null
      const src = String(it.source || "")
      if (src === "taobao" || src === "jd" || src === "pdd") {
        u = await refreshViaPlatform(src, String(it.orderId || ""), it.pkg || {})
      } else if (it.no) {
        u = await refreshViaKdniao(it.no, it.shipperCode)
      }
      if (u) out.set(String(it.no || it.orderId || ""), u)
    }))
    if (i + BATCH < items.length && !timeUp()) {
      await new Promise<void>(res => setTimeout(() => res(), 300))
    }
  }
  return out
}
