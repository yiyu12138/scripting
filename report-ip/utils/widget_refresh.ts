// 小组件侧的轻量自检：只查出口 IP、归属和 proxycheck 风险。
// 12 项服务探测、测速这些重活仍然留在页面里，小组件不跑。
import { fetchIPInfo } from "./ip"
import { queryReputation } from "./lookup"
import { withTimeout } from "./geo"
import { buildWidgetSnapshot, saveWidgetSnapshot } from "./widget_sync"
import type { WidgetSnapshot } from "./widget_sync"

/** 小组件执行时间有限，整轮控制在 12 秒内。 */
const REFRESH_BUDGET_MS = 12000

export async function refreshWidgetSnapshot(previous: WidgetSnapshot | null): Promise<WidgetSnapshot | null> {
  const started = Date.now()
  const info = await fetchIPInfo()
  if (!info || !info.query) return null

  const remaining = Math.max(2000, REFRESH_BUDGET_MS - (Date.now() - started))
  let reputation: Awaited<ReturnType<typeof queryReputation>> = null
  try {
    reputation = await withTimeout(queryReputation(info.query), remaining, "风险查询超时")
  } catch (error) {
    console.log("[IP检测] 轮询风险查询跳过", String(error))
    reputation = null
  }

  const snapshot = buildWidgetSnapshot({
    ip: info.query,
    info,
    reputation,
    pure: null,
    manual: false,
    // 出口没变时保留上一轮的网络报告；变了 buildWidgetSnapshot 会自己丢掉。
    network: previous?.network ?? null,
  })
  return saveWidgetSnapshot(snapshot) ? snapshot : null
}
