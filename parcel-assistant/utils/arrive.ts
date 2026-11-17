/**
 * 到站时间：从物流轨迹里算，而不是用「包裹创建时间」。
 *
 * 以前取件页显示「已到站 N 小时」用的是 createdAt，一个早上揽收的包裹
 * 下午才到站，就会显示成「已到站 9 小时」（多了半天）。
 *
 * 注意：「已到达 沈阳转运中心」也算到达，但那是中转不是可取件，必须排掉，
 * 否则会把三四天前的转运记录当成到站时间。
 */
const PICKABLE = /待取件|已到站|已暂存|已存放|已放入|已代收|送达代收点|请及时取|请及时领取|凭取件码|待领取|已签收|已妥收|快递柜|驿站|代收点/
const TRANSIT_ONLY = /转运中心|分拨中心|集散中心|运转中心|发往|已发出|正在派送|派件中|揽收|已到达[^，。]*中心/

/** 解析「2026-11-12 13:28:33」这类轨迹时间 */
export function parseTrackTime(s?: string): number {
  if (!s) return 0
  const m = /(\d{4})-(\d{1,2})-(\d{1,2})[\sT](\d{1,2}):(\d{2})(?::(\d{2}))?/.exec(String(s))
  if (!m) return 0
  return new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +(m[6] ?? 0)).getTime()
}

/** 轨迹里最新一条「可取件」节点的时间（取最新，中转节点跳过） */
export function arrivedAtOf(nodes?: { time?: string; text?: string }[]): number | undefined {
  if (!Array.isArray(nodes)) return undefined
  let best = 0
  for (const n of nodes) {
    const t = String(n?.text ?? "")
    if (!PICKABLE.test(t)) continue
    if (TRANSIT_ONLY.test(t)) continue
    const at = parseTrackTime(n.time)
    if (at > best) best = at
  }
  return best > 0 ? best : undefined
}
