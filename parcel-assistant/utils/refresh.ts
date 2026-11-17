/**
 * 唯一刷新入口。
 *
 * 脚本没有后台常驻，所以「多久刷新一次」的真实上限是：
 *   - App 在前台：打开 / 每次数据变动后，按设置里的间隔（默认 20 分钟）最多一次
 *   - 桌面小组件刷新：由 iOS 决定（我们按设置里的间隔请求下一次时间线），实际往往更晚
 *   - 手动刷新：随时
 * 系统级通知（超时提醒、位置提醒）不依赖这条链路，由 iOS 自己投递。
 */
import { refreshTrackedPackages } from "../kdniao"
import { getSettings, writeWidgetSnapshot } from "../store"
import { syncPickupActivity } from "../ui/live"
import { markWidgetSynced } from "../widgetData"
import { reschedulePickupReminders, dedupeDeliveredReminders } from "./reminders"
import { maybeFullSync } from "./platformSync"

export type RefreshReason = "app"

/** 限频跟着「设置 → 刷新频率」里的 App 前台间隔走，不在代码里写死 */
function appGapMs(): number {
  const s = getSettings()
  return Math.max(1, Number(s.refreshAppMin) || 20) * 60_000
}

/** 轻量刷新的时间戳也放共享目录：App 与组件两个进程各存一份 Storage 就会各拉一遍、白耗流量 */
const SHARED_LAST = () => `${FileManager.appGroupDocumentsDirectory}/cc/lastRefresh.json`

function readSharedLast(): number {
  let at = 0
  try {
    const f = SHARED_LAST()
    if (FileManager.existsSync(f)) at = Number(JSON.parse(FileManager.readAsStringSync(f) || "{}")?.at ?? 0) || 0
  } catch { }
  try { at = Math.max(at, Number(Storage.get<number>("cc.track.lastRefresh") ?? 0) || 0) } catch { }
  return at
}

function markSharedLast(): void {
  const now = Date.now()
  try { Storage.set("cc.track.lastRefresh", now) } catch { }
  try {
    const dir = `${FileManager.appGroupDocumentsDirectory}/cc`
    if (!FileManager.existsSync(dir)) FileManager.createDirectorySync(dir, true)
    FileManager.writeAsStringSync(SHARED_LAST(), JSON.stringify({ at: now }))
  } catch { }
}

export interface RefreshResult {
  changed: number
  /** 这次是否真的联网拉了数据（被限频就是 false） */
  fetched: boolean
}

export async function refreshAll(reason: RefreshReason = "app"): Promise<RefreshResult> {
  let changed = 0
  let fetched = false
  // 先在外面判断一次，才知道这次到底有没有真的联网（下面要报给 UI）
  const last = readSharedLast()
  const gap = appGapMs()
  const canFetch = Date.now() - last >= gap
  if (canFetch) {
    markSharedLast()
    try {
      changed = await refreshTrackedPackages({
        // 平台包裹也刷：淘宝走 HTTP；京东/拼多多要 WebView，扩展里没有就自动跳过
        platforms: true,
        minGapMs: gap,
        // 外层已判过冷却并先写共享时间；内层必须执行，不能再被刚写的时间挡回。
        force: true,
      })
      // 每 fullSyncHours 一次全量发现新订单（App 与小组件共用时间戳）。
      // 预算 60 秒：这是前台，用户在看，可以等；组件那边是 18 秒。
      changed += await maybeFullSync(60_000)
      fetched = true
    } catch { }
  }

  // 系统通知（超时/到站）由 iOS 日历触发器投递；每次刷新先清掉历史并发留下的重复项
  try { void dedupeDeliveredReminders() } catch { }

  // 下面两步不联网，很便宜：每次都要对齐，否则提醒和灵动岛会停在旧数据
  try { await reschedulePickupReminders() } catch { }
  try { syncPickupActivity() } catch { }
  // 一定要跟着写快照：小组件读的是 App Group 里的 widget.json，
  // 只更新 Storage 里的 lastSync 的话，桌面会一直停在旧时间和旧数据
  if (fetched) {
    markWidgetSynced()
    writeWidgetSnapshot()
  }
  // 不在这里 reload 小组件：数据写入时 store 已经带 600ms 合并刷过了
  return { changed, fetched }
}
