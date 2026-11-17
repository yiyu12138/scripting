// 小组件的交互意图：点圆圈把包裹标记为已取件。
// 注意：intent 必须注册在 app_intents.tsx（script.json 声明的专用入口）桌面扩展才会发现它；
// widget.tsx 里注册的 intent 点击不会触发（实测 2026-11-13 v20）。
import { AppIntentManager, AppIntentProtocol } from "scripting"
import { writeJsonFile, appendOperation } from "./utils/sharedJson"

export const WidgetMarkPickedIntent = AppIntentManager.register({
  name: "WidgetMarkPicked",
  protocol: AppIntentProtocol.AppIntent,
  perform: async ({ uuid }: { uuid: string }) => {
    if (!uuid) return
    const T0 = Date.now()
    const log = (msg: string) => {
      try {
        const pf = `${FileManager.appGroupDocumentsDirectory}/cc/intent.log`
        const prev = FileManager.existsSync(pf) ? FileManager.readAsStringSync(pf) : ""
        const line = `${new Date().toISOString()} ${uuid} ${msg}\n`
        FileManager.writeAsStringSync(pf, (line + prev).split("\n").slice(0, 40).join("\n"))
      } catch { }
    }
    log("start")
    // 双写：共享快照（桌面读这份）+ 主脚本 Storage（App 读这份）
    try {
      const file = `${FileManager.appGroupDocumentsDirectory}/cc/widget.json`
      if (FileManager.existsSync(file)) {
        const snap = JSON.parse(FileManager.readAsStringSync(file) || "{}")
        if (Array.isArray(snap.pickups)) {
          snap.pickups = snap.pickups.map((p: any) =>
            p.uuid === uuid ? { ...p, status: 2, pickedByUser: true } : p)
          snap.at = Date.now()
          snap.lastSync = Date.now()
          // 本次是本地操作触发的重建：5 分钟内不跑联网同步，避免扩展主线程被拉网卡住
          snap.quietUntil = Date.now() + 5 * 60 * 1000
          writeJsonFile(file, snap)
        }
      }
    } catch { }
    // 扩展的私有 Storage 与 App 不互通，只能走共享目录：记一条「已取」操作，
    // App 启动/回前台时消费（store.applyWidgetPicked）。快照自己也写一份，双保险。
    try {
      const dir = `${FileManager.appGroupDocumentsDirectory}/cc`
      if (!FileManager.existsSync(dir)) FileManager.createDirectorySync(dir, true)
      const at = Date.now()
      // 单操作单文件：两个 Intent 或 App 同时消费时不会相互覆盖。
      appendOperation(`${dir}/ops/picked`, { uuid, at })
      // 不再双写旧 picked.json：同一操作留两份会在用户改回待取后重复应用。
    } catch { }
    // intent 执行完系统会自己刷新组件；手动 reloadAll 会在点击处理中重建视图，
    // 导致按压动画卡住、要切屏才恢复（实测 2026-11-15）。不再手动刷。
    log(`done ${Date.now() - T0}ms`)
  },
})
