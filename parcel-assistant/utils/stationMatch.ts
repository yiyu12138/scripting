/**
 * 驿站匹配的唯一实现：主列表卡片、设置页预览、桌面小组件都调这里。
 * 原来这段逻辑长在 store.ts 里，桌面组件要复用就得把整个数据层拖进扩展包，
 * 所以拆成不含存储依赖的纯函数（store.matchStationIn 仍从这里转发）。
 *
 * 打分优先级：关键词(100+) > 驿站名(50+) > 地址(20+)；同分取更长的命中串，仍并列取先添加的。
 * 关键词是用户自己配的「小区楼下」「东侧大门」这类叫法，最能代表实际归属。
 */
export interface StationLike {
  courierStationUuid?: string
  courierStationName?: string
  address?: string
  keywords?: string[]
}

export function matchStationIn(
  stations: StationLike[] | undefined,
  text: string,
): { name: string; uuid: string } | null {
  const t = (text ?? "").trim()
  if (!t || !Array.isArray(stations)) return null
  let best: { name: string; uuid: string; score: number } | null = null
  for (const s of stations) {
    const name = (s?.courierStationName ?? "").trim()
    const addr = (s?.address ?? "").trim()
    let score = 0
    for (const raw of s?.keywords ?? []) {
      const k = (raw ?? "").trim()
      if (k.length >= 2 && t.includes(k)) score = Math.max(score, 100 + k.length)
    }
    if (name.length >= 2 && t.includes(name)) score = Math.max(score, 50 + name.length)
    if (addr.length >= 4 && t.includes(addr)) score = Math.max(score, 20 + addr.length)
    if (score > 0 && (!best || score > best.score)) best = { name, uuid: s.courierStationUuid ?? "", score }
  }
  return best ? { name: best.name, uuid: best.uuid } : null
}
