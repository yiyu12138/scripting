// 轻量到期收尾：给「小组件刷新」这类不用跑完整同步的唤醒点用。
// 只依赖 "scripting" + Storage，刻意不 import live.ts / live_activity.tsx，
// 避免在扩展进程里把活动注册器一起拉进来。
import { LiveActivity } from "scripting"

const NAME = "PickupLiveActivity"
const ID_KEY = "cc.pickupActivityId"
const STARTED_KEY = "cc.live.startedAt"

function expiryMs(label: string): number | undefined {
  const text = String(label ?? "15分钟")
  if (text.includes("永不")) return undefined
  const n = Number(text.replace(/[^\d]/g, "")) || 24
  if (text.includes("秒")) return n * 1000
  if (text.includes("分钟")) return n * 60_000
  return n * 3_600_000
}

/** 到点就把活动 end 掉。iOS 自己只会把 staleDate 之后的活动置灰，不会移除。 */
export function expirePickupActivityIfDue(): void {
  void (async () => {
    try {
      const s: any = Storage.get("cc.settings") ?? {}
      const ms = expiryMs(s.liveExpiryCourier)
      if (ms == null) return
      const at = Number(Storage.get<number>(STARTED_KEY) ?? 0) || 0
      if (!at || Date.now() < at + ms) return
      const id = Storage.get<string>(ID_KEY)
      if (!id) return
      const act = await LiveActivity.from<any>(id, NAME).catch(() => null)
      if (!act) { Storage.remove(ID_KEY); return }
      const status = await act.getActivityState().catch(() => null)
      if (status !== "active" && status !== "stale") { Storage.remove(ID_KEY); return }
      // 收尾用的是一帧空态：渲染端本来就按 pending/items 走空态分支
      await act.end({
        pending: 0, items: [], code: "", company: "", station: "",
        style: s.liveStyle ?? "液态玻璃", updatedAt: Date.now(),
      }, { dismissTimeInterval: 0 }).catch(() => { })
      Storage.remove(ID_KEY)
    } catch { }
  })()
}
