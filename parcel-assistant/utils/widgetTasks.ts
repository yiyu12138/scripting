/**
 * 小组件后台任务调度（v30）
 *
 * 一次组件重建 = 一个时间片，只做一件联网的事，避免并发抢网络/风控：
 *   1. 每次都给：检查灵动岛是否到期（不联网，纯本地）
 *   2. 若「全量轮转」到点 → 只跑一个平台的全量找新单
 *   3. 否则若「数据刷新」到点 → 刷新已有单号的物流（+ 到站通知）
 *
 * 三个节拍各自记在共享目录 cc/widgetTasks.json 里，进程被杀也不丢。
 */
import { Notification } from "scripting"
import { expirePickupActivityIfDue } from "./liveExpire"
import { refreshMailNos } from "./widgetRefresh"
import { syncPlatformParcels, platformLastSyncedAt } from "./platformSync"
import { getPickups, getSettings } from "../store"
import { hasLogin } from "./net"
import { jdHasLogin } from "./jd"
import { pddHasLogin } from "./pdd"
import { fcHasLogin } from "./fengchao"
import { miHasLogin } from "./mi"
import { readJsonFile, writeJsonFile, appendOperation } from "./sharedJson"

const DIR = () => `${FileManager.appGroupDocumentsDirectory}/cc`
const STATE_FILE = () => `${DIR()}/widgetTasks.json`
const LOCK_FILE = () => `${DIR()}/widgetTasks.lock`
const NEW_PKGS = () => `${DIR()}/newPackages.json`
const SNAP = () => `${DIR()}/widget.json`

/** 互斥：系统可能连着唤起两次，锁住后一分钟内只做本地检查，不联网 */
const LOCK_MS = 60_000

/** 轻量刷新预算：扩展进程给的时间很短，8 秒是我们的经验值（45 单 = 15 并发 × 3 批） */
const LIGHT_BUDGET_MS = 8000
/** 单平台全量预算：一次只跑一个平台，18 秒够它翻完列表第一页 */
const FULL_BUDGET_MS = 18_000

type TaskState = {
  lightAt?: number
  fullAt?: number
  /** 每平台失败退避：n 次连败后 until 之前不再在组件里重试（防止一个坏平台把每次唤醒都吃掉） */
  fail?: Record<string, { n: number; until: number }>
}

function readState(): TaskState {
  try {
    if (!FileManager.existsSync(STATE_FILE())) return {}
    return JSON.parse(FileManager.readAsStringSync(STATE_FILE()) || "{}") || {}
  } catch { return {} }
}

function writeState(s: TaskState): void {
  try {
    if (!FileManager.existsSync(DIR())) FileManager.createDirectorySync(DIR(), true)
    writeJsonFile(STATE_FILE(), s)
  } catch { }
}

/** 单平台预算：对齐快递聚合旧版的做法（全平台 18s，单平台 10s） */
const PER_PLATFORM_MS = 10_000

/** 所有平台的授权列表（含京东/丰巢/小米）——参照快递聚合旧版：组件里全平台都能跑 */
function fullCandidates(): string[] {
  const s: any = getSettings()
  const out: string[] = []
  if (hasLogin()) {
    if (s.showTaobao !== false) out.push("taobao")
    if (s.showCainiao !== false) out.push("cainiao")
  }
  if (pddHasLogin() && s.showPdd !== false) out.push("pdd")
  if (jdHasLogin()) out.push("jd")
  if (fcHasLogin()) out.push("fengchao")
  if (miHasLogin()) out.push("mi")
  return out
}

/** 把这次新发现的包裹写成待合并文件（App 启动时并进自己的列表） */
function stashNewPackages(fresh: any[]): number {
  if (fresh.length === 0) return 0
  try {
    let prev: any[] = []
    if (FileManager.existsSync(NEW_PKGS())) prev = JSON.parse(FileManager.readAsStringSync(NEW_PKGS()) || "[]") || []
    const key = (p: any) => `${p?.source ?? ""}|${p?.orderId ?? p?.mailNo ?? ""}`
    const map = new Map<string, any>()
    for (const p of [...prev, ...fresh]) if (p) map.set(key(p), p)
    const arr = Array.from(map.values()).slice(-200)
    writeJsonFile(NEW_PKGS(), arr)
    // 事件目录避免 App 读旧文件后清空、恰好覆盖组件刚写入的新包裹。
    for (const p of fresh) try { appendOperation(`${DIR()}/ops/new`, p) } catch { }
    return arr.length
  } catch { return 0 }
}

/** 该平台最近一次「动过」的时间：成功（platformLast）与失败（syncErr）取晚的那个。
 *  失败后同样要等一个节拍再重试，否则一个总失败的平台会把每次唤醒都占满，饿死轻量刷新。 */
function lastTouchedAt(id: string): number {
  let fail = 0
  try {
    const f = `${DIR()}/syncErr.json`
    if (FileManager.existsSync(f)) {
      const v = JSON.parse(FileManager.readAsStringSync(f) || "{}") || {}
      fail = Number(v?.[id]?.at ?? 0) || 0
    }
  } catch { }
  return Math.max(platformLastSyncedAt(id), fail)
}

/** 轻量刷新的共享时间戳：App 的 refreshAll 也写这个文件，两边互斥靠它 */
function sharedLastRefreshAt(): number {
  try {
    const f = `${DIR()}/lastRefresh.json`
    if (!FileManager.existsSync(f)) return 0
    return Number(JSON.parse(FileManager.readAsStringSync(f) || "{}")?.at ?? 0) || 0
  } catch { return 0 }
}

/** 任务 1：灵动岛到期检查，纯本地，每次重建都做 */
export function tickLive(): void {
  try { expirePickupActivityIfDue() } catch { }
}

/** 单次唤醒最多补几个平台：即使一起欠账，也不要一次把扩展拖满 */
const MAX_PLATFORMS_PER_WAKE = 2

/**
 * 任务 2：全量找新单（带补漏 + 失败隔离）
 *
 *   - 欠账判定：`lastTouchedAt`（成功时间与 syncErr 时间取晚者）超过节拍就入队，**最旧优先**
 *   - 一次唤醒最多补 `MAX_PLATFORMS_PER_WAKE` 个，总预算 18s、单平台 10s（双保险：内部 deadline + 外部 race）
 *   - 失败/超时：记一次连败，退避 `failCoolMin × n`（上限 6 小时）内不再在组件里重试；
 *     连败 3 次后直接停 6 小时——交给 App，不会把桌面拖死
 *   - 成功：清掉连败记录，由 syncPlatformParcels 自己写 platformLast
 */
async function runPlatformSync(state: TaskState, rotateMin: number, snap: any, budgetMs?: number): Promise<void> {
  const cand = fullCandidates()
  if (cand.length === 0) return
  const now = Date.now()
  const fail = (state.fail ??= {})
  const coolMs = Math.max(5, Number(getSettings().failCoolMin) || 30) * 60_000
  const overdue = cand
    .filter(id => now >= (fail[id]?.until ?? 0))                       // 退避中的不参与
    .filter(id => now - lastTouchedAt(id) >= Math.max(10, rotateMin) * 60_000)
    .sort((a, b) => lastTouchedAt(a) - lastTouchedAt(b))                // 最旧优先
  if (overdue.length === 0) { state.fullAt = now; writeState(state); return }

  const before = new Set(getPickups().map(p => p.uuid))
  // 组件进程的 Storage 与 App 不同域：全量过程会顺手重写 cc/widget.json，
  // 这里先留一份原文，跑完盖回去，免得桌面组件丢包裹。
  let snapBackup = ""
  try { if (FileManager.existsSync(SNAP())) snapBackup = FileManager.readAsStringSync(SNAP()) } catch { }

  const totalDeadline = now + Math.max(800, Number(budgetMs) || FULL_BUDGET_MS)
  const fresh: any[] = []
  for (const target of overdue.slice(0, MAX_PLATFORMS_PER_WAKE)) {
    if (Date.now() >= totalDeadline) break
    const budget = Math.max(2_000, Math.min(PER_PLATFORM_MS, totalDeadline - Date.now()))
    // 不用 setTimeout 包 race：扩展进程里 Timer 会报
    // “Timer requires its active script on the main JS execution queue”。
    // 内部每步都看 deadline（jd 的 WebView 等待循环也是 while(Date.now()<deadline)），
    // 所以用报告里的 ran[] 判断它到底跑没跑成。
    let ran = false
    try {
      const report = await syncPlatformParcels(undefined, {
        // force: 外层已经用 platformLast 判过「欠账」了，内部的 3 小时闸门会把它又挡回去，
        // 导致组件的全量永远空转（App 每 3h 跑一遍正好把闸门填满）。
        only: [target], deadline: Date.now() + budget, silent: true, quietIssues: true, force: true,
      })
      ran = Array.isArray(report?.ran) && report.ran.includes(target)
    } catch { ran = false }
    if (ran) {
      delete fail[target]
    } else {
      const n = (fail[target]?.n ?? 0) + 1
      // 连败 3 次就停 6 小时（交回 App），避免一个坏平台把每次唤醒都拖住
      const backoff = n >= 3 ? 6 * 3_600_000 : Math.min(6 * 3_600_000, coolMs * n)
      fail[target] = { n, until: Date.now() + backoff }
    }
    // 收集本平台新出现的包裹（本进程 Storage 可能本来就是空的，由快照合并侧去重兜底）
    if (ran) {
      for (const p of getPickups()) {
        if (!p || before.has(p.uuid)) continue
        if (!fresh.some(x => x.uuid === p.uuid)) fresh.push(p)
      }
    }
  }

  // 同步可能持续数秒，期间 App 或点圈 Intent 都可能写新快照；必须合并磁盘最新值。
  try {
    const latestRaw = FileManager.existsSync(SNAP()) ? FileManager.readAsStringSync(SNAP()) : snapBackup
    if (latestRaw) writeJsonFile(SNAP(), JSON.parse(mergeFreshIntoSnapshot(latestRaw, fresh)))
  } catch { }
  if (fresh.length > 0) stashNewPackages(fresh)

  state.fullAt = Date.now()
  writeState(state)
  void snap
}

/** 组件自己发现了新单：不能只写待合并文件（要等 App 打开才上桌面），
 *  必须同时把新单合进本轮快照盖回去，否则桌面看不到。 */
function mergeFreshIntoSnapshot(raw: string, fresh: any[]): string {
  if (fresh.length === 0) return raw
  try {
    const snap = JSON.parse(raw || "{}") || {}
    const list: any[] = Array.isArray(snap.pickups) ? snap.pickups : []
    const key = (p: any) => `${p?.source ?? ""}|${String(p?.orderId ?? "") || String(p?.mailNo ?? "")}`
    const have = new Set(list.map(key))
    const uuids = new Set(list.map(p => String(p?.uuid ?? "")))
    const added = fresh.filter(p => p && !have.has(key(p)) && !uuids.has(String(p.uuid ?? "")))
    if (added.length === 0) return raw
    snap.pickups = [...added, ...list]
    snap.at = Date.now()
    return JSON.stringify(snap)
  } catch { return raw }
}

/** 任务 3：刷新已有单号的物流（预算可传，默认 LIGHT_BUDGET_MS） */
async function runLightRefresh(state: TaskState, snap: any, budgetMs?: number): Promise<void> {
  const login = { taobao: hasLogin(), pdd: pddHasLogin(), jd: jdHasLogin() }
  if (!login.taobao && !login.pdd && !login.jd) return
  const allPk: any[] = Array.isArray(snap.pickups) ? snap.pickups : []
  const active = allPk.filter((p: any) => (p.status ?? 1) < 2 && !p.pickedByUser)
  // 最旧优先：否则旧包裹永远轮不到 45 条之外（与 App 侧同一规则）
  const targets = active
    .sort((a: any, b: any) => (a.trackUpdatedAt ?? a.createdAt ?? 0) - (b.trackUpdatedAt ?? b.createdAt ?? 0))
    .slice(0, 45)
  if (targets.length === 0) return

  const updates = await refreshMailNos(
    targets.map((p: any) => ({
      no: String(p.mailNo || ""),
      orderId: String(p.uuid || ""),
      source: String(p.source || ""),
      shipperCode: p.shipperCode || "",
      pkg: p,
    })),
    { deadline: Date.now() + Math.max(800, Number(budgetMs) || LIGHT_BUDGET_MS) },
  )
  state.lightAt = Date.now()
  writeState(state)
  if (updates.size === 0) return

  // 到站通知跟 App 用同一份去重表（cc/arrivedNotif.json + uuid）
  const arrivedFile = `${DIR()}/arrivedNotif.json`
  let notified: string[] = []
  try {
    if (FileManager.existsSync(arrivedFile)) notified = JSON.parse(FileManager.readAsStringSync(arrivedFile) || "[]") || []
  } catch { notified = [] }
  const seen = new Set(notified)
  const allowNotify = !(snap.settings && snap.settings.trackNotify === false)
  const ops: Record<string, any> = {}
  snap.pickups = allPk.map((p: any) => {
    const key = String(p.mailNo || p.uuid || "")
    const u = updates.get(key)
    if (!u) return p
    if (allowNotify && u.arrivedAt && !p.arrivedAt && p.uuid && !seen.has(String(p.mailNo || p.code || p.uuid))) {
      const nkey = String(p.mailNo || p.code || p.uuid)
      seen.add(nkey)
      try {
        Notification.schedule({
          title: "包裹到站",
          subtitle: p.itemTitle || "",
          body: p.code ? `取件码 ${p.code}` : "可以去取了",
          threadIdentifier: `cc-arrived:${p.uuid}`,
          userInfo: { uuid: p.uuid },
        })
      } catch { }
    }
    // 组件进程写不到 App 的 Storage，攒成操作文件给 App 合并
    if (p.uuid) ops[String(p.uuid)] = { ...(ops[String(p.uuid)] || {}), ...u, at: Date.now() }
    return { ...p, ...u }
  })
  try {
    FileManager.createDirectorySync(DIR(), true)
    writeJsonFile(arrivedFile, Array.from(seen).slice(-120))
  } catch { }
  try {
    const f = `${DIR()}/trackUpdates.json`
    const prev = FileManager.existsSync(f) ? JSON.parse(FileManager.readAsStringSync(f) || "{}") || {} : {}
    const cutoff = Date.now() - 7 * 86_400_000
    const merged: Record<string, any> = { ...prev }
    for (const k of Object.keys(merged)) if (Number(merged[k]?.at ?? 0) < cutoff) delete merged[k]
    writeJsonFile(f, { ...merged, ...ops })
    for (const [uuid, update] of Object.entries(ops)) {
      try { appendOperation(`${DIR()}/ops/track`, { uuid, update }) } catch { }
    }
  } catch { }
  snap.lastSync = Date.now()
  try { writeJsonFile(`${DIR()}/lastRefresh.json`, { at: Date.now() }) } catch { }
  try {
    // 不用本轮开始时的整份旧 snap 覆盖磁盘；点圈和 App 写入在联网期间也可能发生。
    const latest = readJsonFile<any>(SNAP(), {})
    const base = Array.isArray(latest.pickups) ? latest.pickups : []
    const changes = new Map(allPk.filter((p: any) => updates.has(String(p.mailNo || p.uuid || ""))).map((p: any) => [String(p.uuid), updates.get(String(p.mailNo || p.uuid || ""))]))
    const picked = new Set(Object.keys(readJsonFile<Record<string, number>>(`${DIR()}/picked.json`, {})))
    latest.pickups = base.map((p: any) => {
      const u = changes.get(String(p.uuid))
      const merged = u ? { ...p, ...u } : p
      return picked.has(String(p.uuid)) ? { ...merged, status: 2, pickedByUser: true } : merged
    })
    latest.lastSync = Date.now()
    latest.at = Date.now()
    writeJsonFile(SNAP(), latest)
  } catch { }
}

/**
 * 组件每次重建调用一次：一个时间片只做一件联网的事。
 * 三条晚约束（防止用户在设置里乱配后打架）：
 *   1. 锁：一分钟内只允许一次联网任务，系统重复唤起时直接退化成本地检查
 *   2. 互排：全量与轻量永不同时跑
 *   3. 公平：两边都到期时，比谁「拖延得更厉害」（overdue / interval），不会把轻量饿死
 */
export async function runWidgetTasks(snap: any, opts: { rebuildMin: number; lightMin: number; fullMin: number; budgetMs?: number }): Promise<void> {
  // 这是扩展最后一道保险：底层任何 Promise 卡住，也不能让它拖死本次 WidgetKit 唤醒。
  // 超时返回后请求由系统回收；没写完的结果不假装成功，下一轮按原节拍重试。
  const budget = Math.max(500, Number(opts.budgetMs) || 3000)
  // 到点本轮立即收尾；调度锁保留一分钟，阻止迟到任务与下一次唤醒叠写。
  let timer: any = null
  try {
    await Promise.race([
      runWidgetTasksInner(snap, opts),
      new Promise<void>(resolve => { timer = setTimeout(resolve, budget) }),
    ])
  } finally { if (timer != null) clearTimeout(timer) }
}

async function runWidgetTasksInner(snap: any, opts: { rebuildMin: number; lightMin: number; fullMin: number; budgetMs?: number }): Promise<void> {
  tickLive()
  // 倍数约束（防用户配成互撞）：数据刷新 ≥ 2×重建；全量轮转 ≥ 3×重建，且必须严格大于数据刷新
  const rebuild = Math.max(5, Math.min(180, Number(opts.rebuildMin) || 5))
  const lightMin = Math.max(rebuild * 2, Math.min(120, Number(opts.lightMin) || rebuild * 2))
  let fullMin = Math.max(rebuild * 3, Math.min(240, Number(opts.fullMin) || rebuild * 3))
  if (fullMin <= lightMin) fullMin = lightMin * 2

  // 锁：拿到锁的才算这一次的联网任务
  const now = Date.now()
  const token = `${now}-${Math.random().toString(36).slice(2)}`
  try {
    if (FileManager.existsSync(LOCK_FILE())) {
      const until = Number((FileManager.readAsStringSync(LOCK_FILE()) || "0").split("|")[0]) || 0
      if (now < until) return
    }
    if (!FileManager.existsSync(DIR())) FileManager.createDirectorySync(DIR(), true)
    FileManager.writeAsStringSync(LOCK_FILE(), `${now + LOCK_MS}|${token}`)
  } catch { return }

  const state = readState()
  const lastLight = Math.max(Number(state.lightAt ?? 0), sharedLastRefreshAt())
  const lightOverdue = (now - lastLight) / (lightMin * 60_000)
  const fullOverdue = (now - Number(state.fullAt ?? 0)) / (fullMin * 60_000)
  // 补漏优先：只要有平台超过轮转节拍还没成功，不管 fullAt 到没到，这次都该去补
  const anyPlatformOverdue = fullCandidates().some(
    id => now - lastTouchedAt(id) >= fullMin * 60_000)
  const lightDue = lightOverdue >= 1
  const fullDue = fullOverdue >= 1 || anyPlatformOverdue
  // 看门狗超时后底层 Promise 仍可能迟到返回；锁必须保留到自然过期，不能由迟到任务提前释放。
  const release = () => {
    try {
      const current = FileManager.existsSync(LOCK_FILE()) ? FileManager.readAsStringSync(LOCK_FILE()) : ""
      if (current.endsWith(`|${token}`)) FileManager.removeSync(LOCK_FILE())
    } catch { }
  }

  try {
    if (fullDue && (!lightDue || fullOverdue >= lightOverdue)) {
      await runPlatformSync(state, fullMin, snap, opts.budgetMs)
    } else if (lightDue) {
      await runLightRefresh(state, snap, opts.budgetMs)
    }
  } catch {
  } finally {
    release()
  }
}
