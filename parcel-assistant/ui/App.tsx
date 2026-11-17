// App 根层：原生 TabView（系统液态玻璃）+ 每个 Tab 独立 NavigationStack。
// 二级页面是 push（保留 Tab 栏、左上返回），只有新增/编辑表单用 sheet。
import { AppEvents, NavigationStack, Script, Tab, TabView, VStack, ZStack, useEffect, useObservable, useState } from "scripting"
import { C } from "../theme"
import { StackScope } from "./kit"
import { PickupTab } from "./PickupTab"
import { ParcelsTab } from "./ParcelsTab"
import { StatsTab } from "./StatsTab"
import { SettingsTab } from "./SettingsTab"
import { RouteHost } from "./sheets"
import { TrackSearchSheet, TrackDetailPage } from "./trackSearch"
import { syncPickupActivity } from "./live"
import { refreshTrackedPackages } from "../kdniao"
import { warmCourierIcons } from "../utils/notifyIcon"
import { refreshAll } from "../utils/refresh"
import { syncLocationReminders } from "../utils/geo"
import { dedupePickups } from "../utils/dedupe"
import { applyPickupCodes } from "../utils/cainiao"
import { platformEnabled, sanitizeTaobaoAuth } from "../platforms"
import { applyPddPickupCodes } from "../utils/pddExpress"
import { ToastHost } from "./toast"
import { applyWidgetPicked, applyWidgetTrackUpdates, applyWidgetNewPackages, getPickups, getSettings, normalizeCodes, setPickupStatus, type Pickup } from "../store"

function exitScript() { Script.exit() }

export type Modal = { kind: string; props?: any }
// 页面路由：栈式。二级页里再 open() 就是压栈（三级页），返回时弹栈回到上一页，
// 而不是替换掉 —— 之前三级页返回直接退到第一页就是这个原因。
export type Route = { kind: string; props?: any; tab: number; back?: Route | null }

export default function App({ initialTab, forceDark, pickupUuid }: { initialTab?: number; forceDark?: boolean; pickupUuid?: string } = {}) {
  const params = (Script.queryParameters ?? {}) as Record<string, any>
  if (forceDark != null) (globalThis as any).__ccForceDark = forceDark
  const [tab, setTab] = useState(() => {
    if (initialTab != null && isFinite(initialTab) && initialTab >= 0 && initialTab <= 4) return initialTab
    const t = Number(params.tab)
    return isFinite(t) && t >= 0 && t <= 4 ? t : 0
  })
  const [revision, setRevision] = useState(0)
  const [simpleMode, setSimpleMode] = useState(() => getSettings().simpleMode)
  const appearance = getSettings().appearanceMode
  if (forceDark == null) {
    ;(globalThis as any).__ccForceDark = appearance === "dark" ? true : appearance === "light" ? false : undefined
  }
  const scheme: "dark" | "light" | undefined = forceDark != null
    ? (forceDark ? "dark" : "light")
    : appearance === "dark" ? "dark" : appearance === "light" ? "light" : undefined
  // 实际生效的配色：显式设置优先，否则跟随系统。
  // 传给需要切换图标/渐变的组件（如统计页彩蛋卡），让它们随配色重画，不靠组件内部判断。
  const effScheme: "dark" | "light" = scheme ?? ((Device.colorScheme === "dark") ? "dark" : "light")
  ;(globalThis as any).__ccScheme = scheme
  // 从小组件某一行点进来（URL 带 uuid）直接推入那条详情页，包裹已不在了就正常进首页
  const entryUuid = pickupUuid ? String(pickupUuid) : (params.uuid ? String(params.uuid) : "")
  // 从小组件上点圆圈时带 act=pick：直接标已取，不进详情页
  const entryAct = String(params.act ?? "")
  // 识别失败的通知点进来：iid = 那条识别记录的 id，直接弹「关联到包裹」
  const entryIntent = String(params.iid ?? "")
  const [route, setRoute] = useState<Route>(() => {
    if (entryIntent) return { kind: "shortcuts", props: { linkIntentId: entryIntent }, tab: getSettings().simpleMode ? 0 : 3 }
    if (entryAct !== "pick" && entryUuid && getPickups().some(p => p.uuid === entryUuid)) {
      return { kind: "trackDetail", props: { uuid: entryUuid }, tab: 0 }
    }
    return { kind: "none", tab: 0 }
  })
  // 普通点卡片走弹窗；从小组件带 uuid 进来走上面的 route 推入
  const [sheet, setSheet] = useState<Modal>({ kind: "none" })
  // 每次打开都换 key，避免上一次的查询结果留在新弹窗里
  const [sheetNonce, setSheetNonce] = useState(0)
  const [_, setSchemeTick] = useState(0)

  useEffect(() => {
    // 登录页匿名 cookie 被误存成登录态时自愈（否则显示已授权、接口全 SESSION_EXPIRED）
    sanitizeTaobaoAuth()
    // 老数据里同一个运单可能被两个平台各存了一条，启动时并一次
    dedupePickups()
    // 老数据里把运单号当取件码存过的，清掉（卡片改显示「待取件」）
    normalizeCodes()
    // 用菜鸟接口补全取件码（同单号多平台时只追加，不覆盖已有码）
    // 菜鸟被单独解除授权时不拉驿站取件码（淘宝那边不受影响）
    if (platformEnabled("cainiao")) void applyPickupCodes().catch(() => { })
    // 拼多多驿站待取件也有取件码，授权过就一并补进包裹
    void applyPddPickupCodes().catch(() => { })
    // 小组件点圈进来：带 act=pick 直接把这条标成已取（只处理一次）
    if (entryAct === "pick" && entryUuid && getPickups().some(p => p.uuid === entryUuid)) {
      setPickupStatus(entryUuid, 2)
      setRevision(r => r + 1)
    }
    // 进 App 对一次地理围栏：装/卸位置、改权限后能自愈（不动其它通知）
    void syncLocationReminders()
    const bump = () => setRevision(r => r + 1)
    // 已在前台/刚从后台回来时点小部组件：参数不在 Script.queryParameters，而在 resume 事件里。
    // 不处理这个分支，点包裹只会把 App 拉回当前页，不会进详情（用户实测）。
    const offResume = Script.onResume((e: any) => {
      applyWidgetTrackUpdates()
      applyWidgetNewPackages()
      applyWidgetPicked()
      const q: Record<string, any> = (e && e.queryParameters) || {}
      // 点通知进来：uuid 在 Script.notificationInfo.userInfo 里，不是 queryParameters
      const nUuid = (() => {
        try {
          const v = (Script as any).notificationInfo?.userInfo?.uuid
          return typeof v === "string" ? v : ""
        } catch { return "" }
      })()
      const u = q.uuid ? String(q.uuid) : (nUuid || "")
      if (q.act === "pick" && u) {
        setPickupStatus(u, 2)
        setRevision(r => r + 1)
        return
      }
      if (u && getPickups().some(p => p.uuid === u)) {
        setRoute({ kind: "trackDetail", props: { uuid: u }, tab: 0 })
      }
      // 识别失败的通知（App 在前台时点）：同样直达关联页
      const qIid = q.iid ? String(q.iid) : ""
      if (qIid) {
        setRoute({ kind: "shortcuts", props: { linkIntentId: qIid }, tab: getSettings().simpleMode ? 0 : 3 })
        setRevision(r => r + 1)
        return
      }
      // 同步验证通知：userInfo.openAuthorize = 平台 id，点开直达账号授权页去手动过验证
      const openAuth = (() => {
        try {
          const v = (Script as any).notificationInfo?.userInfo?.openAuthorize
          return typeof v === "string" ? v : ""
        } catch { return "" }
      })()
      // 去「账号授权」而不是个人主页：要过验证/重新授权的是平台那一行
      if (openAuth) setRoute({ kind: "authorize", props: {}, tab: getSettings().simpleMode ? 0 : 3 })
      setRevision(r => r + 1)
    })
    let offScheme: (() => void) | undefined
    try {
      const off = (AppEvents as any).colorScheme?.addListener?.(() => setSchemeTick(n => n + 1))
      offScheme = typeof off === "function" ? off : undefined
    } catch {}
    // 小组件带 uuid 进来时已经在初始 route 里推了详情，这里不再处理
    return () => {
      try { offResume() } catch {}
      try { offScheme?.() } catch {}
    }
  }, [])

  const bump = () => {
    setSimpleMode(getSettings().simpleMode)
    // 不要用 withAnimation：整个页面一起做动画时，原生分段控件会把新旧标签叠在一起淡入淡出，
    // 看起来就是筛选栏“显示异常后又正常”。数据变更直接重渲染即可。
    setRevision(r => r + 1)
    // 临时：登录/数据变更后记录一次凭证诊断（用完删）
  }

  // 用户正在看 App：只刷新内容，不再特殊对待。到期后是否重新展示只取决于包裹有没有变化
  useEffect(() => { syncPickupActivity() }, [revision])
  // 物流包裹刷新（内部限频 5 分钟；顺带重排提醒与更新灵动岛）
  useEffect(() => {
    void refreshAll("app").then(r => { if (r.changed > 0) setRevision(x => x + 1) })
    // 通知图标预热：顺丰这类只有白色 logo 的公司，要在 App 里先把深色底版本渲染成 PNG 落盘，
    // 否则小组件后台发通知时渲染不了，只能退回白图标。
    void warmCourierIcons(getPickups().map(p => p.companyName)).catch(() => { })
  }, [revision])
  // 没真轨迹的运单：快捷指令刚导入的，或旧数据里写着「已识别，等待物流更新」的占位。
  // 全局限频 5 分钟拦得住 refreshAll 拦住它们，所以这里单独定向补一次，进 App 就能看到真物流。
  useEffect(() => {
    const PLACEHOLDER = "已识别，等待物流更新"
    const cold = getPickups()
      .filter(p => !!p.mailNo && p.source === "kdniao" && !p.pickedByUser && !p.closed)
      .filter(p => {
        const t = (p.trackLatest ?? "").trim()
        return !t || t === PLACEHOLDER
      })
      .map(p => String(p.mailNo))
    if (!cold.length) return
    void refreshTrackedPackages({ platforms: false, force: true, only: cold, max: 4 })
      .then(n => { if (n > 0) setRevision(x => x + 1) })
      .catch(() => { })
  }, [])
  // 平台订单：每 3 小时全量同步一次（由 refreshAll → maybeFullSync 统一处理，小组件刷新也会跑）
  const closeSheet = () => setSheet({ kind: "none" })
  const openSheet = (kind: string, props?: any) => { setSheetNonce(n => n + 1); setSheet({ kind, props }) }
  const closeRoute = () => setRoute(r => {
    // 有上一页就弹回上一页（三级页返回二级页）；没有才是真正的关闭
    const back = r.back
    return back ? { ...back, tab: r.tab } : { ...r, kind: "none" }
  })
  // 简洁模式没有 TabView，tab 状态是残留值；不修正会把页面推到不存在的栈上，表现就是「点了没反应」
  const open = (kind: string, props?: any) => setRoute(cur => ({ kind, props, tab: simpleMode ? 0 : tab, back: cur.kind !== "none" ? cur : null }))
  const sel = useObservable<number>(tab)
  useEffect(() => sel.subscribe((v: number) => {
    setTab(v)
    setRoute({ kind: "none", tab: v })
  }), [])

  const pickupPage = (
    <PickupTab revision={revision}
      onAdd={() => openSheet("trackSearch")}
      onEdit={(p: Pickup) => { setSheetNonce(n => n + 1); setSheet({ kind: "trackDetail", props: { uuid: p.uuid } }) }}
      onIdentityCode={(id: any) => open("identityCode", { id })}
      onManageIdentity={() => open("identity")}
      onAll={() => { if (getSettings().simpleMode) open("all"); else sel.setValue(1) }}
      onStationTap={(name: string) => open("stationDetail", { name })}
      onExit={exitScript}
      onChanged={bump}
      onSimpleModeChanged={bump} />
  )
  const editPickup = (p: Pickup) => {
    // 现在所有快递都来自授权同步 / 手动查询，一律进物流详情页（sheet 卡片形式）
    setSheetNonce(n => n + 1)
    setSheet({ kind: "trackDetail", props: { uuid: p.uuid } })
  }
  const parcelsPage = (
    <ParcelsTab revision={revision}
      onAdd={() => openSheet("trackSearch")}
      onEdit={editPickup}
      onExit={exitScript}
      onChanged={bump} />
  )
  const statsPage = <StatsTab revision={revision} scheme={effScheme} onExit={exitScript} onAll={() => open("all")} />
  const settingsPage = <SettingsTab revision={revision} onOpen={(p: string) => open(p)} onExit={exitScript} />

  function stack(index: number, content: any) {
    const presented = route.kind !== "none" && route.tab === index
    return (
      <NavigationStack toolbarBackgroundVisibility={{ visibility: "hidden", bars: ["navigationBar"] }}>
        <VStack frame={{ maxWidth: "infinity", maxHeight: "infinity" }}
          background={C.bg}
          toolbarBackground={{ style: C.bg, bars: ["tabBar"] }}
          navigationDestination={{
            isPresented: presented,
            onChanged: (v: boolean) => { if (!v && route.tab === index) closeRoute() },
            content: (
              <StackScope>
                <RouteHost route={route} close={closeRoute} bump={bump} revision={revision}
                  open={open} openSheet={openSheet} closeSheet={closeSheet} />
              </StackScope>
            ),
          }}>
          {content}
        </VStack>
      </NavigationStack>
    )
  }

  return (
    <ZStack frame={{ maxWidth: "infinity", maxHeight: "infinity" }}>
      <VStack frame={{ maxWidth: "infinity", maxHeight: "infinity" }} background={C.bg} ignoresSafeArea />
      <VStack frame={{ maxWidth: "infinity", maxHeight: "infinity" }}
      background={C.bg}
      preferredColorScheme={scheme}
      sheet={{
        isPresented: sheet.kind !== "none",
        onChanged: v => { if (!v) closeSheet() },
        content: (
          <ZStack frame={{ maxWidth: "infinity", maxHeight: "infinity" }}>
          {sheet.kind === "trackSearch"
          ? <TrackSearchSheet key={`ts-${sheetNonce}`} close={closeSheet} bump={() => { bump(); closeSheet() }} />
          : sheet.kind === "trackDetail"
          ? (() => { const pkg = getPickups().find(x => x.uuid === sheet.props?.uuid); return pkg
              ? <TrackDetailPage key={`td-${sheetNonce}`} pkg={pkg} standalone close={closeSheet} onAdd={undefined} />
              : <VStack /> })()
          : sheet.kind === "addLocation"
            ? <RouteHost route={{ kind: "addLocation", tab }} close={closeSheet} bump={() => { bump(); closeSheet() }} revision={revision}
                open={open} openSheet={openSheet} closeSheet={closeSheet} modal />
            : <VStack />}
          <ToastHost />
          </ZStack>
        ),
      }}>
      {simpleMode ? stack(0, pickupPage) : (
        <TabView selection={sel} tabBarMinimizeBehavior="never" tint={C.accent as any}
          background={C.bg}
          toolbarBackground={{ style: C.bg, bars: ["tabBar"] }}>
          <Tab title="取件" systemImage="shippingbox" value={0}>{stack(0, pickupPage)}</Tab>
          <Tab title="包裹" systemImage="archivebox" value={1}>{stack(1, parcelsPage)}</Tab>
          <Tab title="统计" systemImage="chart.bar" value={2}>{stack(2, statsPage)}</Tab>
          <Tab title="设置" systemImage="gearshape" value={3}>{stack(3, settingsPage)}</Tab>
        </TabView>
      )}
      </VStack>
      <ToastHost />
    </ZStack>
  )
}
