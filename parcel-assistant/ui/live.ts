// 把「待取件」同步到灵动岛 / 锁屏实时活动。
import { LiveActivity, Script } from "scripting"
import { PickupLiveActivity, type PickupActivityState } from "../live_activity"
import { getPickups, getSettings, getStations, matchStationIn } from "../store"
import { companyName, courierAsset, courierSymbol } from "../theme"
import { isAwaitingPickup, stationHaystack } from "../utils/model"

const NAME = "PickupLiveActivity"
const ID_KEY = "cc.pickupActivityId"
const RENDERER_KEY = "cc.pickupActivityRenderer"
// 改实时活动布局就要 +1：旧活动会结束并按新 UI 重建，否则系统继续用旧快照。
const RENDERER_VERSION = 5

let current: LiveActivity<PickupActivityState> | null = null
let running = false
let again = false
let dismissed = false
let lastPending = 0

function noteError(e: any) {
  try { Storage.set("cc_last_live_error", String(e ?? "unknown")) } catch {}
}

function clearError() {
  try { Storage.remove("cc_last_live_error") } catch {}
}

function expiryMs(label: string): number | undefined {
  const text = String(label)
  if (text.includes("永不")) return undefined
  const n = Number(text.replace(/[^\d]/g, "")) || 24
  if (text.includes("秒")) return n * 1000
  if (text.includes("分钟")) return n * 60_000
  return n * 3_600_000
}

/** 开始展示的时刻：过期时间从这里算，不随后续同步往后滑 */
const STARTED_KEY = "cc.live.startedAt"
/** 最后一次展示的数据指纹：内容不变就不重开 */
const SHOWED_SIG_KEY = "cc.live.shownSig"

/** 用户改了开关/过期时间：重新计时，允许立即重新展示 */
export function resetLiveExpiry(): void {
  try { Storage.remove(STARTED_KEY); Storage.remove(SHOWED_SIG_KEY) } catch { }
}

function sigOf(s: PickupActivityState): string {
  return `${s.pending}|${(s.items ?? []).map(i => i.code ?? "").join(",")}`
}

/** 记一笔排期/过期决策，便于事后对账（cc/liveDiag.json，只留 20 条） */
function diag(entry: Record<string, any>): void {
  try {
    const f = `${FileManager.appGroupDocumentsDirectory}/cc/liveDiag.json`
    const prev = FileManager.existsSync(f) ? JSON.parse(FileManager.readAsStringSync(f) || "[]") : []
    const arr = Array.isArray(prev) ? prev : []
    arr.push({ t: Date.now(), ...entry })
    FileManager.writeAsStringSync(f, JSON.stringify(arr.slice(-20)))
  } catch { }
}

const LOGO_DIR = `${FileManager.appGroupDocumentsDirectory}/cc-live-logos`
const logoReady = new Set<string>()

/** 实时活动扩展读不到脚本 assets，先把 logo 复制到 App Group。 */
function ensureLogo(slug: string | undefined): string | undefined {
  if (!slug) return undefined
  try {
    const name = slug.split("/").pop() ?? slug
    const dest = `${LOGO_DIR}/${name}`
    if (logoReady.has(dest)) return dest
    FileManager.createDirectorySync(LOGO_DIR, true)
    if (!FileManager.existsSync(dest)) {
      const src = `${Script.directory}/assets/${slug}`
      if (!FileManager.existsSync(src)) return undefined
      FileManager.copyFileSync(src, dest)
    }
    if (!FileManager.existsSync(dest)) return undefined
    logoReady.add(dest)
    return dest
  } catch { return undefined }
}

function snapshot(): PickupActivityState {
  const settings = getSettings()
  // 在途包裹不进灵动岛：岛上写的是「N 件待取」，拿不到码的运输中也算进来就是虚数
  const pending = getPickups()
    .filter(p => (p.type ?? "delivery") === "delivery" && isAwaitingPickup(p))
    .sort((a, b) => (b.arrivedAt ?? b.createdAt) - (a.arrivedAt ?? a.createdAt))
  const first = pending[0]
  // 分组名与 App 里一致：驿站管理匹配名 > 平台驿站名 > 地址。
  // 以前岛上直接用平台地址，同一条路的不同包裹会被拆成好几行。
  const stations = getStations()
  return {
    pending: pending.length,
    items: pending.slice(0, 8).map(p => {
      const name = companyName(p.companyName)
      const sym = courierSymbol(p.companyName)
      const matched = matchStationIn(stations, stationHaystack(p))
      return {
        code: p.code,
        company: name,
        station: matched?.name || p.courierStationName || p.address || name,
        icon: sym.icon,
        tint: sym.tint,
        iconColor: sym.iconColor,
        logoPath: ensureLogo(courierAsset(p.companyName)),
      }
    }),
    code: first?.code ?? "",
    company: first ? companyName(first.companyName) : "",
    station: first ? (first.courierStationName || first.address || "") : "",
    style: settings.liveStyle,
    updatedAt: Date.now(),
  }
}

async function saved(): Promise<LiveActivity<PickupActivityState> | null> {
  if (current) return current
  const id = Storage.get<string>(ID_KEY)
  if (!id) return null
  try {
    current = await LiveActivity.from<PickupActivityState>(id, NAME)
  } catch {
    current = null
  }
  return current
}

async function endAllOurs(state: PickupActivityState): Promise<void> {
  const all = await LiveActivity.getAllActivities().catch(() => [])
  for (const d of all) {
    if (d.state !== "active" && d.state !== "stale") continue
    const act = await LiveActivity.from<PickupActivityState>(d.id, NAME).catch(() => null)
    if (act) await act.end(state, { dismissTimeInterval: 0 }).catch(() => {})
  }
}

async function endCurrent(state: PickupActivityState): Promise<void> {
  const id = Storage.get<string>(ID_KEY) ?? current?.activityId
  let act = current
  if (!act && id) {
    try { act = await LiveActivity.from<PickupActivityState>(id, NAME) } catch {}
  }
  if (act) {
    const status = await act.getActivityState().catch(() => null)
    if (status !== "dismissed") {
      await act.end(state, { dismissTimeInterval: 0 }).catch(() => {})
    }
  }
  current = null
  if (id) Storage.remove(ID_KEY)
  await endAllOurs(state)
  Storage.set(RENDERER_KEY, RENDERER_VERSION)
}

async function doSync(): Promise<void> {
  const settings = getSettings()
  const state = snapshot()
  if (state.pending > lastPending) dismissed = false
  if (state.pending === 0) {
    dismissed = false
    lastPending = 0
  } else {
    lastPending = state.pending
  }

  const storedId = Storage.get<string>(ID_KEY) ?? ""
  if (Storage.get<number>(RENDERER_KEY) !== RENDERER_VERSION && storedId) {
    await endCurrent(state)
  }

  const want = settings.liveActivityEnabled && state.pending > 0
  if (!want) {
    await endCurrent(state)
    return
  }

  if (!(await LiveActivity.areActivitiesEnabled().catch(() => false))) {
    await endCurrent(state)
    return
  }

  const expiry = expiryMs(settings.liveExpiryCourier)
  // 到期时间 = 「开始展示的时刻 + 设置时长」，这是唯一口径；内容没变就不再拉起
  const sig = sigOf(state)
  const shownSig = Storage.get<string>(SHOWED_SIG_KEY) ?? ""
  const keepHiddenByTime = (): boolean => {
    if (expiry == null) return false
    const at = Number(Storage.get<number>(STARTED_KEY) ?? 0) || 0
    if (!at) return false
    return Date.now() >= at + expiry && shownSig === sig
  }
  let startedAt = Number(Storage.get<number>(STARTED_KEY) ?? 0) || 0
  const markShown = (): void => {
    // 内容变了就重新计时；否则保留原起点，到期时间不会随同步往后滑
    if (!startedAt || shownSig !== sig) startedAt = Date.now()
    try { Storage.set(STARTED_KEY, startedAt); Storage.set(SHOWED_SIG_KEY, sig) } catch { }
  }
  const staleDateOf = (): number | undefined => {
    if (expiry == null) return undefined
    if (!startedAt) startedAt = Date.now()
    return startedAt + expiry
  }
  // relevanceScore 是系统给多个实时活动排优先级用的（0–100，100 最高）；
  // 取件码属于要看一眼就该看到的信息，直接拉满，别被音乐/外卖活动盖掉。
  const options = (): { staleDate?: number; relevanceScore?: number } => {
    const o: { staleDate?: number; relevanceScore?: number } = { relevanceScore: 100 }
    const sd = staleDateOf()
    if (sd != null) o.staleDate = sd
    return o
  }
  const existing = await saved()

  if (existing) {
    const status = await existing.getActivityState().catch(() => null)
    if (keepHiddenByTime()) {
      // 已经到期且内容没变：让系统收起，不再拉起
      diag({ ev: "endHiddenByTime", status, startedAt, staleDate: staleDateOf(), sig })
      await existing.end(state, { dismissTimeInterval: 0 }).catch(() => { })
      current = null
      Storage.remove(ID_KEY)
      return
    }
    if (status === "active") {
      diag({ ev: "update", startedAt, staleDate: staleDateOf(), sig })
      await existing.update(state, options())
      Storage.set(RENDERER_KEY, RENDERER_VERSION)
      clearError()
      return
    }
    if (status === "stale") {
      // 已过期。iOS 只会把它置灰，真正收起来要我们自己调 end。
      // 内容没变 → 收起，且保留 startedAt/shownSig，之后任何一次唤醒都不会再拉起
      //（包括重新打开 App：以前这里给前台开了个「revive」的口子，导致
      //  「第一次进来消失、第二次进来又冒出来」，现在只有包裹真变了才重新显示）。
      if (keepHiddenByTime()) {
        diag({ ev: "endStale", startedAt, staleDate: staleDateOf(), sig })
        await existing.end(state, { dismissTimeInterval: 0 }).catch(() => { })
        Storage.remove(ID_KEY)
        current = null
        return
      }
      // 内容变了：就地 update 打回 active 并重新计时，别「先 end 再 start」——那样会闪一下
      markShown()
      diag({ ev: "reviveStale", startedAt, staleDate: staleDateOf(), sig })
      await existing.update(state, options())
      Storage.set(RENDERER_KEY, RENDERER_VERSION)
      clearError()
      return
    }
    if (status === "dismissed") {
      dismissed = true
      current = null
      Storage.remove(ID_KEY)
      return
    }
    if (status === "ended") {
      await existing.end(state, { dismissTimeInterval: 0 }).catch(() => {})
    }
    current = null
    Storage.remove(ID_KEY)
  }

  if (dismissed) return
  // 到期且内容没变（可能系统早就把它收掉了）→ 不再拉一个新活动
  if (keepHiddenByTime()) return

  // 脚本重装/重启后可能留下没有本地 ID 的活动，优先接管而不是再开一个。
  const all = await LiveActivity.getAllActivities().catch(() => [])
  for (const d of all) {
    if (d.state !== "active" && d.state !== "stale") continue
    const act = await LiveActivity.from<PickupActivityState>(d.id, NAME).catch(() => null)
    if (!act) continue
    if (d.state === "stale") {
      // 已过期的遗留活动：收掉，不接管
      await act.end(state, { dismissTimeInterval: 0 }).catch(() => {})
      continue
    }
    const status = await act.getActivityState().catch(() => null)
    if (status !== "active") continue
    current = act
    await act.update(state, options())
    // 同名活动只保留一条，避免脚本重装后出现两个灵动岛。
    for (const other of all) {
      if (other.id === d.id) continue
      if (other.state !== "active" && other.state !== "stale") continue
      const extra = await LiveActivity.from<PickupActivityState>(other.id, NAME).catch(() => null)
      if (extra) await extra.end(state, { dismissTimeInterval: 0 }).catch(() => {})
    }
    Storage.set(ID_KEY, d.id)
    markShown()
    Storage.set(RENDERER_KEY, RENDERER_VERSION)
    clearError()
    return
  }

  markShown()
  diag({ ev: "start", startedAt, staleDate: options().staleDate, sig })
  const next = PickupLiveActivity()
  const ok = await next.start(state, options()).catch(e => { noteError(e); return false })
  if (ok && next.activityId) {
    current = next
    Storage.set(ID_KEY, next.activityId)
    Storage.set(RENDERER_KEY, RENDERER_VERSION)
    clearError()
  } else {
    noteError("start returned false")
  }
}

/** 可由任意页面调用；内部串行，避免连续 bump 时重复 start。
 *  到期后是否重新展示只看数据指纹（有包裹变化才重新显示），调用者不需要、也不能传「强制复活」。*/
export function syncPickupActivity(): void {
  if (running) { again = true; return }
  running = true
  void doSync().catch(e => noteError(e)).finally(() => {
    running = false
    if (again) { again = false; syncPickupActivity() }
  })
}
