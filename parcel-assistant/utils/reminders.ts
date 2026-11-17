/**
 * 提醒调度。
 *
 * 关键约束：脚本没有后台进程。能真正在后台「自己响」的只有系统级触发器：
 *   - 时间/日历触发器（CalendarNotificationTrigger）——「到站 N 小时还没取」
 *   - 地理围栏触发器（LocationNotificationTrigger）——「到某个位置提醒」
 * 这两类都由 iOS 负责投递，不需要脚本在跑，也不耗电。
 *
 * 「包裹到站了」这种事件则必须由某次同步发现，同步只会发生在：
 * App 打开 / 手动刷新 / 桌面小组件刷新。所以到站提醒会滞后到下一次同步。
 *
 * ── 去重为什么曾经失效 ───────────────────────────────────────────────
 * 之前完全依赖「查系统待投递列表」（getAllPendingsOfCurrentScript）来判断
 * 「这条是不是已经排过了」。一旦这个接口查不到（返回空 / 报错 / 跨进程看不见），
 * 每次同步都会把同一包裹重新排一遍，到点就各投递一条，用户看到两条一样的
 * 「超时提醒 · 2/3」。
 *
 * 现在改成三层，互相独立：
 *   1. 自己的排期账本 cc/timedPlan.json —— 「某包裹第 i 条排在哪个绝对时刻」，
 *      每排完一条立刻落盘。这是判重的**唯一权威**，不依赖系统接口。
 *   2. 系统待投递列表只用来「清理重复/失效」，查不到就跳过清理，不影响判重。
 *   3. 通知中心里已经投递的重复项，按「同 thread + 同内容」收拾掉。
 * 另外排期前先确认枚举接口可用；不可用就整轮不排（宁可少一条，也不重复）。
 */
import { Notification } from "scripting"
import { getPickups, getSettings, type Pickup } from "../store"
import { isAwaitingPickup } from "./model"
import { courierIconData } from "./notifyIcon"
import { companyName } from "../theme"

const TIMED_PREFIX = "cc-timed-reminder"
const ARRIVED_PREFIX = "cc-arrived"
const NOTIFIED_KEY = "cc.arrivedNotified"
const PLAN_FILE = "timedPlan.json"
const OLD_SCHED_FILE = "notifSched.json"
const LOG_FILE = "remindLog.json"

// ---------------- 共享目录读写 ----------------

function ccPath(name: string): string {
  return `${FileManager.appGroupDocumentsDirectory}/cc/${name}`
}

function readShared<T>(name: string, fallback: T): T {
  try {
    const p = ccPath(name)
    if (!FileManager.existsSync(p)) return fallback
    const v = JSON.parse(FileManager.readAsStringSync(p) || "null")
    return (v ?? fallback) as T
  } catch { return fallback }
}

function writeShared(name: string, v: any): boolean {
  try {
    const dir = `${FileManager.appGroupDocumentsDirectory}/cc`
    if (!FileManager.existsSync(dir)) FileManager.createDirectorySync(dir, true)
    FileManager.writeAsStringSync(ccPath(name), JSON.stringify(v))
    return true
  } catch { return false }
}

/** 只留最近 40 条，方便出问题时回看上次排期发生了什么 */
function logLine(msg: string): void {
  try {
    const arr = readShared<any[]>(LOG_FILE, [])
    arr.push({ t: Date.now(), m: msg })
    writeShared(LOG_FILE, arr.slice(-40))
  } catch { }
}

// ---------------- 基础工具 ----------------

function dateComponents(d: Date): DateComponents {
  const c = new DateComponents()
  c.year = d.getFullYear()
  c.month = d.getMonth() + 1
  c.day = d.getDate()
  c.hour = d.getHours()
  c.minute = d.getMinutes()
  c.second = 0
  return c
}

/** 触发时刻的稳定字符串：用来做「同 thread 同时间」判重 */
function triggerStamp(x: any): string {
  const trig: any = x?.trigger ?? {}
  const dc = trig.dateMatching ?? trig.dateComponents ?? {}
  if (!dc.year) return `ts:${Number(trig.timestamp ?? 0) || 0}`
  return [dc.year, dc.month, dc.day, dc.hour, dc.minute].join("-")
}

function dcStamp(c: DateComponents): string {
  return [c.year, c.month, c.day, c.hour, c.minute].join("-")
}

/** 落在安静时段就顺延到结束那一刻 */
function avoidQuiet(d: Date, start: number, end: number): Date {
  if (start === end) return d
  const h = d.getHours()
  const inQuiet = start < end ? (h >= start && h < end) : (h >= start || h < end)
  if (!inQuiet) return d
  const out = new Date(d)
  out.setHours(end, 0, 0, 0)
  if (out.getTime() <= d.getTime()) out.setDate(out.getDate() + 1)
  return out
}

/** 同一个物理包裹的稳定标识：运单号 > 取件码 > uuid。
 *  库里同一包裹存成两条（uuid 不同、一条有码一条没码）时，靠这个合成一条。 */
function parcelKey(p: Pickup): string {
  const m = String(p.mailNo ?? "").trim()
  if (m) return m
  const c = String(p.code ?? "").trim()
  if (c) return c
  return p.uuid
}

function contentKey(c: any): string {
  return `${c?.title ?? ""}|${c?.subtitle ?? ""}|${c?.body ?? ""}`
}

/** 查全 App 的待投递；备份与正式版可能同时存在，不能只看当前脚本。
 *  后续只处理 cc-timed-reminder / cc-arrived 前缀，不碰其他脚本通知。 */
async function listPendings(): Promise<any[] | null> {
  try {
    const v = await Notification.getAllPendings()
    return Array.isArray(v) ? v : null
  } catch { return null }
}

/** 查全 App 的已投递；清理时仍只认领包裹助手自己的 thread 前缀。 */
export async function listDelivereds(): Promise<any[] | null> {
  try {
    const v = await Notification.getAllDelivereds()
    return Array.isArray(v) ? v : null
  } catch { return null }
}

/** 挂在待投递项上的 thread 前缀（超时 / 到站），其它通知忽略 */
function threadPrefix(x: any): string {
  const c: any = x?.content ?? x?.request?.content ?? {}
  const th = String(c.threadIdentifier ?? c.thread ?? "")
  if (th.startsWith(TIMED_PREFIX)) return TIMED_PREFIX
  if (th.startsWith(ARRIVED_PREFIX)) return ARRIVED_PREFIX
  return ""
}

function threadIdOf(x: any): string {
  const c: any = x?.content ?? x?.request?.content ?? {}
  return String(c.threadIdentifier ?? c.thread ?? "")
}

function contentOf(x: any): any {
  return x?.content ?? x?.request?.content ?? {}
}

// ---------------- 已投递的重复项清理 ----------------

/** 清通知中心里的重复项：同 thread 同内容的只留一条；包裹已取走的一并撤掉。
 *  每次 App 启动 / 每次刷新都会跑，不排期、不受闸门限制。 */
export async function dedupeDeliveredReminders(): Promise<number> {
  const delivered = await listDelivereds()
  if (!delivered) return 0
  const alive = new Set(getPickups().filter(p => (p.status ?? 1) === 1).map(parcelKey))
  const seen = new Set<string>()
  const drop: string[] = []
  for (const n of delivered as any[]) {
    const pfx = threadPrefix(n)
    if (!pfx) continue
    const th = threadIdOf(n)
    const key = th.slice(pfx.length + 1)
    const id = (n as any).identifier ?? (n as any).request?.identifier
    if (pfx === TIMED_PREFIX && !alive.has(key)) { if (id) drop.push(id); continue }
    const k = `${th}|${contentKey(contentOf(n))}`
    if (seen.has(k)) { if (id) drop.push(id) }
    else seen.add(k)
  }
  if (!drop.length) return 0
  try { await Notification.removeDelivereds(drop) } catch { return 0 }
  logLine(`清理已投递重复 ${drop.length} 条`)
  return drop.length
}

// ---------------- 重建排期 ----------------

/** 跨进程闸门：30 秒内不管 App/设置页谁又调一次都跳过（force 不受限） */
const RESCHED_GAP = 30_000
const GATE_FILE = () => `${FileManager.appGroupDocumentsDirectory}/cc/remindGate.json`

function recentlyRescheduled(): boolean {
  try {
    if (!FileManager.existsSync(GATE_FILE())) return false
    const v = JSON.parse(FileManager.readAsStringSync(GATE_FILE()) || "{}")
    return Date.now() - (Number(v.at) || 0) < RESCHED_GAP
  } catch { return false }
}

function markRescheduled(): void {
  try {
    const dir = `${FileManager.appGroupDocumentsDirectory}/cc`
    if (!FileManager.existsSync(dir)) FileManager.createDirectorySync(dir, true)
    FileManager.writeAsStringSync(GATE_FILE(), JSON.stringify({ at: Date.now() }))
  } catch { }
}

/** 串行链：这个函数是「先删后加」，App 启动、刷新、设置页都会调，
 *  两个调用交叉执行（A 删 → B 删 → A 加 → B 加）会排两遍。 */
let remindChain: Promise<void> = Promise.resolve()

export function reschedulePickupReminders(force = false): Promise<void> {
  if (!force && recentlyRescheduled()) return Promise.resolve()
  markRescheduled()
  const run = remindChain.then(() => rescheduleOnce())
  remindChain = run.catch(() => { })
  return run
}

/** 算一个包裹该在哪些时刻提醒（纯函数，方便单测）。
 *  base 必须是一次写入、不再变化的值（arrivedAt，退而求其次 createdAt）；
 *  用 trackUpdatedAt 这种每次都刷新的值会把每次同步都当成新起点。 */
export function reminderTimes(
  base: number,
  s: { reminderAfterHours: number; reminderMaxTimes: number; quietStart: number; quietEnd: number },
  now: number,
): { i: number; when: Date }[] {
  const gapMs = Math.max(1, s.reminderAfterHours) * 3_600_000
  const maxTimes = Math.max(1, Math.min(5, s.reminderMaxTimes))
  const out: { i: number; when: Date }[] = []
  for (let i = 0; i < maxTimes; i++) {
    const when = avoidQuiet(new Date(base + gapMs + i * 86_400_000), s.quietStart, s.quietEnd)
    // 错过的时间点不补发：否则好几天没开 App，一打开就连升几条旧提醒
    if (when.getTime() < now + 60_000) continue
    out.push({ i, when })
  }
  return out
}

async function rescheduleOnce(): Promise<void> {
  const s = getSettings()
  const pend = await listPendings()
  // 枚举接口不可用就整轮不动：看不见已有排期时继续排，就是在制造重复。
  if (pend == null) {
    logLine("枚举待投递失败：本轮不排期")
    return
  }

  // 待取清单：同一包裹多条记录按 parcelKey 合并，最早到站的优先
  const byKey = new Map<string, Pickup>()
  for (const p of getPickups()) {
    if ((p.status ?? 1) !== 1 || !isAwaitingPickup(p)) continue
    const k = parcelKey(p)
    const prev = byKey.get(k)
    if (!prev) { byKey.set(k, p); continue }
    const a = p.arrivedAt ?? p.createdAt
    const b = prev.arrivedAt ?? prev.createdAt
    if (a < b) byKey.set(k, p)
  }
  const chosen = [...byKey.entries()]
    .sort((a, b) => (a[1].arrivedAt ?? a[1].createdAt) - (b[1].arrivedAt ?? b[1].createdAt))
    .slice(0, 8)
  const alive = new Set(byKey.keys())

  // 账本：parcelKey → { 第 i 条: 绝对时刻 }。判重以此为准（见文件头注释）。
  const plan = readShared<Record<string, Record<string, number>>>(PLAN_FILE, {})
  const legacy = readShared<Record<string, number>>(OLD_SCHED_FILE, {})
  const now = Date.now()

  // 本轮「应该存在」的排期。设置/安静时段一变时刻就变，旧的要撤掉重排，
  // 否则新旧两套同时在系统里，到点各响一次。
  const desired = new Map<string, { i: number; when: Date; whenMs: number }[]>()
  if (s.reminderEnabled) {
    for (const [key, p] of chosen) {
      const base = p.arrivedAt ?? p.createdAt
      const seenMs = new Set<number>()
      const list: { i: number; when: Date; whenMs: number }[] = []
      for (const t of reminderTimes(base, s, now)) {
        const ms = t.when.getTime()
        // 安静时段顺延后可能两条撞到同一分钟：只留一条，避免同一时刻双响
        if (seenMs.has(ms)) continue
        seenMs.add(ms)
        list.push({ i: t.i, when: t.when, whenMs: ms })
      }
      desired.set(key, list)
    }
  }
  const allowed = new Set<string>()
  for (const [key, list] of desired) {
    for (const t of list) allowed.add(`${TIMED_PREFIX}:${key}|${dcStamp(dateComponents(t.when))}`)
  }

  // 1) 待投递清理：不在应排清单里的（已取走 / 提醒关了 / 设置改过）全部撤掉；
  //    清单内同 thread 同触发时刻的重复项只留一条。
  //    注意：同一包裹的 1/3、2/3、3/3 同 thread 但**不同时刻**，必须都留着。
  const present = new Set<string>()
  const dropPend: string[] = []
  for (const r of pend as any[]) {
    const pfx = threadPrefix(r)
    if (!pfx) continue
    const th = threadIdOf(r)
    const k = `${th}|${triggerStamp(r)}`
    const id = (r as any).identifier
    if (pfx === TIMED_PREFIX && !allowed.has(k)) {
      if (id) dropPend.push(id)
      continue
    }
    if (present.has(k)) { if (id) dropPend.push(id) } else present.add(k)
  }
  if (dropPend.length) { try { await Notification.removePendings(dropPend) } catch { } }

  // 2) 已投递清理（包裹已取走的、重复的）
  const delivered = await listDelivereds()
  if (delivered) {
    const dropDel: string[] = []
    const seen = new Set<string>()
    for (const n of delivered as any[]) {
      const pfx = threadPrefix(n)
      if (!pfx) continue
      const th = threadIdOf(n)
      const key = th.slice(pfx.length + 1)
      const id = (n as any).identifier ?? (n as any).request?.identifier
      if (pfx === TIMED_PREFIX && !alive.has(key)) { if (id) dropDel.push(id); continue }
      const k = `${th}|${contentKey(contentOf(n))}`
      if (seen.has(k)) { if (id) dropDel.push(id) } else seen.add(k)
    }
    if (dropDel.length) { try { await Notification.removeDelivereds(dropDel) } catch { } }
  }

  if (!s.reminderEnabled) {
    writeShared(PLAN_FILE, {})
    logLine(`提醒关闭：待取 ${alive.size} 条，已撤掉全部超时提醒`)
    return
  }

  let scheduled = 0
  let skipped = 0

  for (const [key, p] of chosen) {
    const where = p.courierStationName || p.trackCompany || ""
    const brand = companyName(p.companyName)
    const th = `${TIMED_PREFIX}:${key}`
    for (const { i, when, whenMs } of desired.get(key) ?? []) {
      // 账本里有这个绝对时刻 → 已经排过了，不再排（权威判据，不依赖系统接口）
      if (plan[key]?.[String(i)] === whenMs) { skipped++; continue }
      const dc = dateComponents(when)
      // 系统里已经看得见这条（账本丢了但通知还在）→ 补回账本，不重复排
      if (present.has(`${th}|${dcStamp(dc)}`)) {
        plan[key] = { ...(plan[key] ?? {}), [i]: whenMs }
        writeShared(PLAN_FILE, plan)
        skipped++
        continue
      }
      let ok = false
      try {
        ok = await Notification.schedule({
          title: i === 0 ? "超时提醒" : `超时提醒 · ${i + 1}/${Math.max(1, Math.min(5, s.reminderMaxTimes))}`,
          subtitle: `${brand}${where ? ` · ${where}` : ""}`,
          body: `${p.code || p.mailNo || "包裹"} 已放置 ${s.reminderAfterHours} 小时`,
          iconImageData: await courierIconData(p.companyName),
          threadIdentifier: th,
          userInfo: { uuid: p.uuid, key, i },
          trigger: new CalendarNotificationTrigger({ dateMatching: dc, repeats: false }),
        })
      } catch { ok = false }
      if (!ok) break
      scheduled++
      plan[key] = { ...(plan[key] ?? {}), [i]: whenMs }
      legacy[`${key}|${whenMs}|${i}`] = Date.now()
      present.add(`${th}|${dcStamp(dc)}`)
      // 每排一条立刻落盘：中途被打断/崩溃也不会丢掉「已排过」这个事实
      writeShared(PLAN_FILE, plan)
      writeShared(OLD_SCHED_FILE, legacy)
    }
  }

  // 账本只留「本轮应排且确实排了」的条目，其它（已过点、设置改过）清掉
  const nextPlan: Record<string, Record<string, number>> = {}
  for (const [key, list] of desired) {
    const rec: Record<string, number> = {}
    for (const t of list) {
      if (plan[key]?.[String(t.i)] === t.whenMs) rec[String(t.i)] = t.whenMs
    }
    if (Object.keys(rec).length) nextPlan[key] = rec
  }

  // 老账本只留 7 天内的键，防止无限膨胀
  try {
    const cutoff = Date.now() - 7 * 86_400_000
    const trimmed: Record<string, number> = {}
    for (const [k, v] of Object.entries(legacy)) if (v > cutoff) trimmed[k] = v
    writeShared(OLD_SCHED_FILE, trimmed)
  } catch { }

  writeShared(PLAN_FILE, nextPlan)
  let want = 0
  for (const list of desired.values()) want += list.length
  logLine(`排期：待取 ${alive.size} 条 / 应排 ${want} / 新排 ${scheduled} / 已有 ${skipped} / 可见待投递 ${present.size}`)
}

// ---------------- 到站提醒 ----------------

/** 包裹刚进「待取」（到站）时立刻弹一条。同一个包裹只提醒一次，取走后重置 */
export async function notifyArrived(p: Pickup): Promise<void> {
  if (getSettings().trackNotify === false) return
  const key = parcelKey(p)
  let seen: string[] = []
  try { seen = Storage.get<string[]>(NOTIFIED_KEY) ?? [] } catch { }
  if (seen.includes(key)) return
  // 跨进程去重：App 和小组件两个进程都会跑这里，Storage 互不可见，
  // 共享文件里记一份才能防止同一包裹两个进程各弹一条
  const dedupFile = `${FileManager.appGroupDocumentsDirectory}/cc/arrivedNotif.json`
  let dedup: string[] = []
  try {
    if (FileManager.existsSync(dedupFile)) dedup = JSON.parse(FileManager.readAsStringSync(dedupFile) || "[]")
  } catch { dedup = [] }
  if (dedup.includes(key)) { Storage.set(NOTIFIED_KEY, [...seen.slice(-60), key]); return }
  // 先占位再发：App 打开时多条同步路径并发，先发后记会让两条路径同时通过去重检查，同一包裹弹两次
  Storage.set(NOTIFIED_KEY, [...seen.slice(-60), key])
  dedup = [...dedup.slice(-120), key]
  try { FileManager.writeAsStringSync(dedupFile, JSON.stringify(dedup)) } catch { }
  try {
    await Notification.schedule({
      title: "包裹到站",
      subtitle: `${companyName(p.companyName)}${p.courierStationName ? ` · ${p.courierStationName}` : ""}`,
      body: `${p.code || p.mailNo || "包裹"} 可以去取了`,
      iconImageData: await courierIconData(p.companyName),
      threadIdentifier: `${ARRIVED_PREFIX}:${key}`,
      userInfo: { uuid: p.uuid, key },
    })
  } catch {
    // 发送失败才回退占位，下次同步还能补发
    try {
      const cur = Storage.get<string[]>(NOTIFIED_KEY) ?? []
      Storage.set(NOTIFIED_KEY, cur.filter(k => k !== key))
      if (FileManager.existsSync(dedupFile)) {
        const d2 = JSON.parse(FileManager.readAsStringSync(dedupFile) || "[]")
        FileManager.writeAsStringSync(dedupFile, JSON.stringify(d2.filter((k: string) => k !== key)))
      }
    } catch { }
  }
}

/** 包裹取走后把「已提醒过」记删掉，下次到站还能再提醒。
 *  传包裹对象时按 parcelKey 清（与 notifyArrived 写入的键一致）；
 *  传字符串时当兼容键直接清。 */
export function forgetArrived(target: Pickup | { uuid: string; mailNo?: string; code?: string } | string): void {
  const keys = typeof target === "string"
    ? [target]
    : [parcelKey(target as Pickup), (target as any).uuid].filter(Boolean) as string[]
  const drop = (arr: string[]) => arr.filter(k => !keys.includes(k))
  try {
    const seen = Storage.get<string[]>(NOTIFIED_KEY) ?? []
    Storage.set(NOTIFIED_KEY, drop(seen))
  } catch { }
  try {
    const f = `${FileManager.appGroupDocumentsDirectory}/cc/arrivedNotif.json`
    if (FileManager.existsSync(f)) {
      const d = JSON.parse(FileManager.readAsStringSync(f) || "[]") as string[]
      FileManager.writeAsStringSync(f, JSON.stringify(drop(d)))
    }
  } catch { }
}
