import { Button, HStack, Image, Link, Script, Spacer, Text, VStack, Widget } from "scripting"
import { WIDGET_VERSION } from "./widgetVersion"
import { runWidgetTasks, tickLive } from "./utils/widgetTasks"
import { isAwaitingPickup, isTransitPkg } from "./utils/model"
import { WidgetBody, TXT_C, SUB_C } from "./ui/widgetLayout"
import type { CardSize } from "./ui/parcelCard"
import { jdHasLogin } from "./utils/jd"
import { hasLogin } from "./utils/net"
import { pddHasLogin } from "./utils/pdd"
import { operationFiles, readJsonFile } from "./utils/sharedJson"

// 模块加载完成即落一条引导日志；没有 perf 新行时用它区分“没唤醒”和“初始化失败”。
try {
  const dir = `${FileManager.appGroupDocumentsDirectory}/cc`
  if (!FileManager.existsSync(dir)) FileManager.createDirectorySync(dir, true)
  FileManager.writeAsStringSync(`${dir}/widgetBoot.txt`, `${Date.now()}|${WIDGET_VERSION}`)
} catch { }

/** 构建版本只用于首帧判定和诊断日志，不在桌面页脚展示。 */

/** 组件下一次重建的间隔：直接用设置里的「重建」值（与设置页同一个下限 5 分钟）；
 *  设置从共享快照读，组件域读不到 App 的私有 Storage。 */
function widgetReloadMs(snap?: any): number {
  try {
    const s: any = (snap && snap.settings) || Storage.get<any>("cc.settings") || {}
    const m = Number(s.refreshWidgetMin)
    return Math.max(5, Number.isFinite(m) && m > 0 ? m : 10) * 60_000
  } catch { return 10 * 60_000 }
}

/* 卡片本身不在这里画：ui/parcelCard.tsx 是唯一实现，和 App 里的取件卡片是同一份代码。
   这里只负责桌面特有的事：尺寸、挑哪几行、右侧那个可点的圈、头像、页脚。 */

function WidgetView({ snapshot }: { snapshot: any }) {
  // 口径与 App 完全同一套函数：isAwaitingPickup 判待取、isTransitPkg 判在途。
  // 以前组件自己写了一套 stageOf，同一个包裹在桌面和 App 里可能一个算待取、一个算在途。
  const all: any[] = Array.isArray(snapshot.pickups) ? snapshot.pickups : []
  const st: any = snapshot.settings || {}
  const active = all.filter(p => (p.status ?? 1) < 2 && !p.pickedByUser && !p.closed)
  const sortBy = (l: any[]) => [...l].sort((a, b) => (b.trackUpdatedAt ?? b.createdAt ?? 0) - (a.trackUpdatedAt ?? a.createdAt ?? 0))
  const pending = sortBy(active.filter(p => isAwaitingPickup(p)))
  // 包含在途：设置里关掉就不显示（之前开关只影响预览）
  const transit = (st.widgetShowTransit === false ? [] : sortBy(active.filter(p => isTransitPkg(p))))

  // 头像：从快照 settings 读
  const avatarEmoji: string = st.avatarMode === "emoji" ? String(st.avatarEmoji || "") : ""
  const avatarFile = st.avatarMode === "photo" ? `${FileManager.appGroupDocumentsDirectory}/cc/avatar.png` : ""

  const family = Widget.family
  const size: CardSize = family === "systemLarge" || family === "systemExtraLarge" || family === "systemExtraLargePortrait" ? "large" : family === "systemMedium" ? "medium" : "small"
  const lastSync = (snapshot as any).syncedAt || (snapshot as any).lastSync || 0

  return <WidgetBody
    pending={pending}
    transit={transit}
    lastSync={lastSync}
    avatarEmoji={avatarEmoji}
    avatarFile={avatarFile}
    size={size}
  />
}

async function run() {
  const T0 = Date.now()
  // 数据源：主脚本共享快照 cc/widget.json（主脚本 writeWidgetSnapshot 持续维护），Storage 兑底取较新。
  let snap: any = {}
  let lastSync = 0
  try {
    const file = `${FileManager.appGroupDocumentsDirectory}/cc/widget.json`
    if (FileManager.existsSync(file)) {
      snap = JSON.parse(FileManager.readAsStringSync(file) || "{}")
      if (typeof snap.lastSync === "number") lastSync = snap.lastSync
    }
  } catch { }
  // 只认共享快照：组件域读不到 App 的 Storage，这段回退永远拿不到更新，
  // 反而可能拿旧数据盖掉快照。
  if (!Array.isArray(snap.pickups)) { try { snap.pickups = Storage.get<any[]>("cc.pickups") ?? [] } catch { } }
  if (!snap.settings || typeof snap.settings !== "object") { try { snap.settings = Storage.get<any>("cc.settings") ?? {} } catch { } }

  // AppIntent 点圈写的「已取」操作：快照里已写一份，这里再把共享操作文件叠一次，
  // 防止快照写失败 / 读到的是旧快照时圈了又跳回待取。
  try {
    const pf = `${FileManager.appGroupDocumentsDirectory}/cc/picked.json`
    if (FileManager.existsSync(pf)) {
      const ops = JSON.parse(FileManager.readAsStringSync(pf) || "{}") || {}
      const ids = Object.keys(ops)
      if (ids.length > 0 && Array.isArray(snap.pickups)) {
        const set = new Set(ids)
        snap.pickups = snap.pickups.map((p: any) =>
          p && set.has(p.uuid) ? { ...p, status: 2, pickedByUser: true } : p)
      }
    }
  } catch { }
  try {
    const dir = `${FileManager.appGroupDocumentsDirectory}/cc/ops/picked`
    for (const file of operationFiles(dir)) {
      const op = readJsonFile<{ uuid?: string }>(file, {})
      if (!op.uuid || !Array.isArray(snap.pickups)) continue
      snap.pickups = snap.pickups.map((p: any) => p?.uuid === op.uuid ? { ...p, status: 2, pickedByUser: true } : p)
    }
  } catch { }

  // quietUntil：刚刚在组件上点过圈，本地已改数据，这次重建只出图，不跑联网。
  const quiet = Number((snap as any).quietUntil || 0) > Date.now()
  try { Storage.set("cc.widget.render", `${Date.now()}|n=${(snap.pickups || []).length}|v=30`, { shared: true }) } catch { }
  // 诊断日志：记录每次重建耗时，用来判断卡死是渲染慢还是 WidgetKit 没回来
  try {
    const pf = `${FileManager.appGroupDocumentsDirectory}/cc/perf.log`
    const prev = FileManager.existsSync(pf) ? FileManager.readAsStringSync(pf) : ""
    const line = `${new Date().toISOString()} ${Date.now() - T0}ms quiet=${quiet ? 1 : 0} n=${(snap.pickups || []).length}\n`
    FileManager.writeAsStringSync(pf, (line + prev).split("\n").slice(0, 40).join("\n"))
  } catch { }

  try {
    const pf = `${FileManager.appGroupDocumentsDirectory}/cc/perf.log`
    const prev = FileManager.existsSync(pf) ? FileManager.readAsStringSync(pf) : ""
    const line = `${new Date().toISOString()} auth taobao=${hasLogin()} jd=${jdHasLogin()} pdd=${pddHasLogin()}\n`
    FileManager.writeAsStringSync(pf, (line + prev).split("\n").slice(0, 40).join("\n"))
  } catch { }

  // v1：新构建后的「第一帧」不联网，先把图打出来（版本号写在共享文件里，一变即新构建）。
  // 旧写法是 present 之后 await 联网，一卡住 exit 就不执行，系统丢掉这帧 → 桌面灰屏。
  let firstOfBuild = false
  try {
    const vf = `${FileManager.appGroupDocumentsDirectory}/cc/widgetBuiltVersion.txt`
    const seen = FileManager.existsSync(vf) ? (FileManager.readAsStringSync(vf) || "").trim() : ""
    firstOfBuild = seen !== WIDGET_VERSION
    if (firstOfBuild) FileManager.writeAsStringSync(vf, WIDGET_VERSION)
  } catch { }

  // 联网放在 present 之后（见下方），绝不阻塞首帧。

  // 同步期间可能刚点过已取；最后一层叠加，避免旧快照把状态画回待取。
  try {
    const dir = `${FileManager.appGroupDocumentsDirectory}/cc/ops/picked`
    for (const file of operationFiles(dir)) {
      const op = readJsonFile<{ uuid?: string }>(file, {})
      if (op.uuid && Array.isArray(snap.pickups)) snap.pickups = snap.pickups.map((p: any) => p?.uuid === op.uuid ? { ...p, status: 2, pickedByUser: true } : p)
    }
  } catch { }

  const present = (view: any) => Widget.present(view, {
    // 刷新间隔可以在「设置 → 刷新频率」改；iOS 只当建议，实际可能更晚
    reloadPolicy: { policy: "after", date: new Date(Date.now() + widgetReloadMs(snap)) },
  })
  try { present(<WidgetView snapshot={snap as any} />) }
  catch {
    // 单条脏数据或图片异常不能拖垮整个组件；退回最小缓存视图，仍保留点击入口和下次更新。
    present(<VStack widgetURL={Script.createRunURLScheme(Script.name)} padding={14} frame={{ maxWidth: "infinity", maxHeight: "infinity" }}>
      <Text font={14} fontWeight="semibold" foregroundStyle={TXT_C}>包裹助手</Text>
      <Spacer />
      <Text font={11} foregroundStyle={SUB_C}>打开 App 查看包裹</Text>
    </VStack>)
  }

  try {
    const pf = `${FileManager.appGroupDocumentsDirectory}/cc/widgetPresent.log`
    FileManager.writeAsStringSync(pf, `${new Date().toISOString()} ${WIDGET_VERSION} presented\n`)
  } catch { }

  // 首帧已提交，现在才做联网；最多 3 秒，无论成败都退出。
  // 不依赖 App 或推送：每次 WidgetKit 唤醒都把同步往前推一步。
  if (!quiet && !firstOfBuild) {
    const tSync = Date.now()
    try { await backgroundSync(snap) } catch { }
    // 本轮联网可能已写新快照；请求系统再拿一帧，避免新数据固定晚一个刷新周期才显示。
    try { Widget.reloadAll() } catch { }
    try {
      const pf = `${FileManager.appGroupDocumentsDirectory}/cc/perf.log`
      const prev = FileManager.existsSync(pf) ? FileManager.readAsStringSync(pf) : ""
      const line = `${new Date().toISOString()} bg ${Date.now() - tSync}ms\n`
      FileManager.writeAsStringSync(pf, (line + prev).split("\n").slice(0, 40).join("\n"))
    } catch { }
  }
  // 官方要求组件结束调用 exit；首帧早已 present。
  try { Script.exit() } catch { }
}

/** 出图前的联网任务：一个时间片只做一件联网的事（全量轮转 / 已有单刷新），外加灵动岛到期检查 */
async function backgroundSync(snap: any) {
  const s: any = (snap && snap.settings) || {}
  // 设置里的「通过小组件后台刷新物流」：关闭后只出图，不联网。
  if (s.bgRefresh === false) { try { tickLive() } catch { } return }
  await runWidgetTasks(snap, {
    rebuildMin: Number(s.refreshWidgetMin ?? 5),
    lightMin: Number(s.refreshExistingMin ?? 10),
    fullMin: Number(s.fullRotateMin ?? 15),
    // 组件扩展预算：3 秒（与备份一致）；到点无论底层卡在哪个请求，都会回到出图流程并 exit。
    budgetMs: 3000,
  })
}

run().catch(() => {
  try {
    Widget.present(<VStack widgetURL={Script.createRunURLScheme(Script.name)} padding={14}>
      <Text font={13} foregroundStyle={TXT_C}>包裹助手</Text>
      <Text font={10} foregroundStyle={SUB_C}>打开 App 查看包裹</Text>
    </VStack>, { reloadPolicy: { policy: "after", date: new Date(Date.now() + widgetReloadMs()) } })
  } catch { }
  try { Script.exit() } catch { }
})
