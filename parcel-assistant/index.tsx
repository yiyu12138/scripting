// 包裹助手入口：自适应深/浅色，iOS 26 液态玻璃悬浮组件
import { Navigation, Script } from "scripting"
import App from "./ui/App"
import { applyWidgetPicked, applyWidgetTrackUpdates, applyWidgetNewPackages, getSettings, cleanStations } from "./store"
import { syncPlatformIcons } from "./utils/platformIcons"
import { dedupeDeliveredReminders } from "./utils/reminders"
import { consumeIntentInbox } from "./utils/intentInbox"
import { presentRecognizeResult } from "./utils/clipboardRecognize"

/** 点通知进来时，包裹 uuid 在 Script.notificationInfo.userInfo 里（不是 queryParameters） */
function notifUuid(): string | undefined {
  try {
    const ui: any = (Script as any).notificationInfo?.userInfo
    const u = ui?.uuid
    return typeof u === "string" && u ? u : undefined
  } catch { return undefined }
}

async function run() {  try {
    // 小组件刷到的物流先合（它同样写不到 App Storage），再合「已取」操作——
    // 顺序反了的话，组件的旧轨迹会把刚标好的已取改回待取
    applyWidgetTrackUpdates()
    applyWidgetNewPackages()
    applyWidgetPicked()
    // 快捷指令识别出来的包裹/取件码：同理，启动时统一落库
    try { consumeIntentInbox() } catch { }
    // 旧数据把「如遇问题请联系代理点」当驿站名存过：启动时清一次
    try { cleanStations() } catch { }
    // 快捷指令用 URL scheme 拉起来的识别请求：不打开主界面，只出结果卡片
    const qp: any = Script.queryParameters ?? {}
    const wantOcr = String(qp.ocr ?? "") === "1"
    const wantText = String(qp.text ?? "") === "1"
    if (wantOcr || wantText) {
      await presentRecognizeResult(wantOcr ? "image" : "text")
      return
    }
    // 平台小标写一份到 App Group，小组件扩展读不到主工程资源目录
    syncPlatformIcons()
    // 入口直跑一次已投递通知去重：不依赖 UI 挂载/刷新限频，开 App 就清掉历史并发留下的重复项
    void dedupeDeliveredReminders()
    // 主题色给 theme.ts 的 palette() 用（模块加载早于页面渲染，启动时同步注入）
    ;(globalThis as any).__ccThemeColor = getSettings().homeColor
    await Navigation.present({
      element: <App pickupUuid={notifUuid() ?? (typeof Script.queryParameters?.uuid === "string" ? Script.queryParameters.uuid : undefined)} />,
      modalPresentationStyle: "fullScreen",
    })
  } catch (e) {
    try { Storage.set("cc_last_error", String(e)) } catch {}
  } finally {
    // 右上角 X 已直接调用 Script.exit()；present 被关闭时这里兜底，避免实例泄漏
    Script.exit()
  }
}

void run()
