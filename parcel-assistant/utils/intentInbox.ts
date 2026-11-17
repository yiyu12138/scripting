/**
 * 快捷指令识别结果 → 包裹数据的桥。
 *
 * intent.tsx 跑在快捷指令的进程里，不保证和 App 的 Storage 同域，
 * 所以统一走共享文件：intent 只负责「识别 + 落盘」，App 启动/回前台时消费。
 * 和小组件点圈那套 picked.json 是同一个思路（见 app_intents.tsx）。
 */
import { addPickup, getPickups, updatePickup, type Pickup } from "../store"
import { codeKey, mergeCodes } from "./codes"
import { parseDeliveryText, looksLikeStation, type ParsedPackage } from "./smsParse"

export interface IntentItem {
  id: string
  at: number
  kind: "image" | "text"
  parsed: ParsedPackage
  status: "pending" | "applied" | "failed"
  note?: string
  /** 截图/文字来自哪个 App（快捷指令用 CurrentApp 取，见 utils/appBrand） */
  srcApp?: { id?: string; name?: string }
  /** 手动关联到哪个包裹（撤回用） */
  linkedUuid?: string
  /** 手动关联时补进去的取件码（撤回用） */
  linkedCode?: string
  /** 关联时是不是这条记录把包裹标成了「已到站」：撤回时一并清掉，不然会凭空多一个待取 */
  linkedSetArrived?: boolean
}

const DIR = () => `${FileManager.appGroupDocumentsDirectory}/cc`
const FILE = () => `${DIR()}/intentInbox.json`
const MAX_KEEP = 5
const LINKED_KEEP = 5

function readAll(): IntentItem[] {
  try {
    if (!FileManager.existsSync(FILE())) return []
    const v = JSON.parse(FileManager.readAsStringSync(FILE()) || "[]")
    return Array.isArray(v) ? v.filter((x: any) => x && x.parsed) : []
  } catch { return [] }
}

function writeAll(list: IntentItem[]): void {
  try {
    if (!FileManager.existsSync(DIR())) FileManager.createDirectorySync(DIR(), true)
    FileManager.writeAsStringSync(FILE(), JSON.stringify(trim(list)))
  } catch { }
}

/**
 * 裁剪：总共 10 条——普通 5 条 + 手动关联过 5 条，超了丢最旧的。
 * 关联记录单独计数，以免撤回入口被新流水挤掉。
 */
function trim(list: IntentItem[]): IntentItem[] {
  const out: IntentItem[] = []
  let plain = 0
  let linked = 0
  for (const it of list) {
    if (it.linkedUuid) {
      if (linked < LINKED_KEEP) { out.push(it); linked++ }
    } else if (plain < MAX_KEEP) {
      out.push(it); plain++
    }
  }
  return out
}

/** intent 侧调用：记一条识别结果，等 App 消费 */
export function pushIntentItem(
  kind: "image" | "text",
  parsed: ParsedPackage,
  srcApp?: { id?: string; name?: string },
): IntentItem {
  const item: IntentItem = {
    id: `ir_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
    at: Date.now(),
    kind,
    parsed,
    status: "pending",
    ...(srcApp && (srcApp.id || srcApp.name) ? { srcApp } : {}),
  }
  writeAll([item, ...readAll()])
  return item
}

export function loadIntentInbox(): IntentItem[] {
  return readAll()
}

/** 快捷指令进程读 App 写的共享快照（widget.json）：只用来判断“能不能自动落地”，
 *  真正写库还是在 App 里做。没有快照返回 null（这时不下结论）。 */
export function loadSharedPickups(): Pickup[] | null {
  try {
    const f = `${DIR()}/widget.json`
    if (!FileManager.existsSync(f)) return null
    const v = JSON.parse(FileManager.readAsStringSync(f) || "null")
    return v && Array.isArray(v.pickups) ? v.pickups as Pickup[] : null
  } catch { return null }
}

/** 删一条识别记录（列表右滑删除用） */
export function appliedIntentCount(): number {
  return readAll().filter(x => x.status !== "pending").length
}

/** 清掉已经落库/已失败的旧识别记录，只留还没处理的（“清除缓存”用） */
export function clearAppliedIntentItems(): number {
  const all = readAll()
  const keep = all.filter(x => x.status === "pending")
  const n = all.length - keep.length
  if (n > 0) writeAll(keep)
  return n
}
export function removeIntentItem(id: string): void {
  writeAll(readAll().filter(x => x.id !== id))
}

/** 手动关联后把记录改回已入库 */
export function markIntentApplied(id: string, note: string, linkedUuid?: string, linkedCode?: string, setArrived?: boolean): void {
  const all = readAll()
  const it = all.find(x => x.id === id)
  if (!it) return
  it.status = "applied"
  it.note = note
  it.linkedUuid = linkedUuid
  it.linkedCode = linkedCode
  it.linkedSetArrived = setArrived
  writeAll(all)
}

/** 撤回手动关联：把补进去的码从包裹上取下来，记录恢复为失败 */
export function undoIntentLink(id: string): string {
  const all = readAll()
  const it = all.find(x => x.id === id)
  if (!it || !it.linkedUuid) return "这条没有关联记录"
  const p = getPickups().find(x => x.uuid === it.linkedUuid)
  if (!p) return "原包裹已经不在了"
  // 按归一后的码比对：存进去的是原文，大小写/连字符不一定跟识别的一致
  const k = codeKey(it.linkedCode ?? "")
  const codes = (p.codes ?? (p.code ? [p.code] : [])).filter(c => codeKey(c) !== k)
  const patch: Partial<Pickup> = { codes, code: codes[0] ?? "" }
  // 关联时是这条记录把包裹标成到站的，撤回就把这个标记也收回，否则它永远挂在待取
  if (it.linkedSetArrived) patch.arrivedAt = undefined
  updatePickup(p.uuid, patch as any)
  it.status = "failed"
  it.note = `已撤回关联（取件码 ${it.linkedCode ?? ""} 未写入）`
  it.linkedUuid = undefined
  it.linkedCode = undefined
  it.linkedSetArrived = undefined
  writeAll(all)
  return `已从「${p.itemTitle || p.mailNo || "包裹"}」撤回`
}

/** 驿站名比对：双向包含即可（短信常写「XX路2号店」，记录里是「菜鸟驿站(XX路2号店)」） */
function stationMatch(a?: string, b?: string): boolean {
  const norm = (s?: string) => (s || "").replace(/[\s()（）【】\[\]，,。.]/g, "")
  const x = norm(a), y = norm(b)
  if (!x || !y) return false
  return x.includes(y) || y.includes(x)
}

/** 尾号匹配：收货人手机尾号，或物流文案里出现过这个尾号 */
function tailMatch(p: Pickup, tail: string): boolean {
  if (!/^\d{4}$/.test(tail)) return false
  if ((p.receiverPhone || "").replace(/\D/g, "").endsWith(tail)) return true
  if ((p.phone || "").replace(/\D/g, "").endsWith(tail)) return true
  const blob = [p.trackLatest, p.notes, p.itemTitle, p.trackCompany].filter(Boolean).join(" ")
  return blob.includes(tail)
}

/** 这个码是不是只是运单号（旧数据常把它存在 code 里，不能当真取件码） */
export function codeIsMailNo(p: Pickup, code: string): boolean {
  const a = String(code ?? "").replace(/[\s-]/g, "").toLowerCase()
  const b = String(p.mailNo ?? "").replace(/[\s-]/g, "").toLowerCase()
  return !!a && !!b && a === b
}

/**
 * 只拿到取件码时，从待取包裹里猜一条最可能的。
 * 快捷指令进程（只能读共享快照）和 App 落库都用这一份，
 * 否则会出现「通知说没匹配上，打开 App 却自动匹配上了」。
 */
export function pickIntentTarget(p: { code?: string; station?: string; tail?: string }, cands: Pickup[]): Pickup | undefined {
  const byStation = p.station ? cands.filter(x => stationMatch(x.courierStationName || x.address, p.station)) : []
  const byTail = p.tail ? cands.filter(x => tailMatch(x, p.tail!)) : []
  const pool = byStation.length > 0 ? byStation : byTail
  return pool[0] ?? (cands.length === 1 ? cands[0] : undefined)
}

function applyOne(it: IntentItem): { ok: boolean; note: string; addedMailNo?: string } {
  const p = it.parsed
  const list = getPickups()
  // 驿站名/地址只收真名字：短信里的「如遇问题请联系代理点」要在这里就挡掉
  const station = p.station && looksLikeStation(p.station) ? p.station : ""

  // ① 有运单号：命中已有包裹就补信息，没有就新建
  if (p.mailNo) {
    const key = codeKey(p.mailNo)
    const hit = list.find(x => x.mailNo && codeKey(x.mailNo) === key)
    if (hit) {
      const merged = mergeCodes(hit.codes ?? (hit.code ? [hit.code] : []), p.code)
      const patch: Partial<Pickup> = { trackUpdatedAt: Date.now() }
      if (p.company) patch.trackCompany = p.company
      if (station) { patch.courierStationName = station; patch.address = station }
      if (merged.length > (hit.codes?.length ?? (hit.code ? 1 : 0))) {
        patch.codes = merged
        if (!hit.code) patch.code = merged[0]
      }
      updatePickup(hit.uuid, patch)
      return { ok: true, note: `已补充到 ${hit.itemTitle || p.mailNo}` }
    }
    addPickup({
      code: p.code || "",
      codes: p.code ? [p.code] : [],
      companyName: 1,
      address: station,
      phone: "",
      notes: `快捷指令识别：${p.raw.slice(0, 60)}`,
      status: 1,
      type: "delivery",
      smsContent: p.raw.slice(0, 200),
      courierStationName: station,
      courierStationUuid: "",
      // 没有商品名：拿识别时的平台名当商品名（用户要求），没有平台才退回快递公司
      itemTitle: it.srcApp?.name || p.company || "快递包裹",
      mailNo: p.mailNo,
      trackCompany: p.company || "",
      // 不能写「已识别，等待物流更新」这种假轨迹：那会盖住真实的签收/到站状态。
      // 留空 + trackUpdatedAt=0，让快递鸟下一轮刷新直接把真轨迹填进来。
      trackLatest: "",
      trackNodes: [],
      trackUpdatedAt: 0,
      // source 必须是 kdniao：refreshTrackedPackages 只刷这一类，写 manual 就永远不刷新
      source: "kdniao",
      ...(it.srcApp && (it.srcApp.id || it.srcApp.name) ? { srcApp: it.srcApp } : {}),
      orderId: `manual:${p.mailNo}`,
      // 不在这里凭空写 arrivedAt：到站时间只由真实轨迹决定，
      // 否则刚导入的快递会立刻变成「待取」并参与超时提醒。
    } as any)
    return { ok: true, note: "已新建包裹", addedMailNo: p.mailNo }
  }

  // ② 只有取件码：找对应的待取包裹补码
  if (p.code) {
    const cands = list.filter(x => x.status === 1 && !x.closed)
    const pick = pickIntentTarget(p, cands)
    if (!pick) {
      const awaiting = cands.filter(x => x.arrivedAt || x.code).length
      return {
        ok: false,
        note: `有取件码 ${p.code}，但没找到对应包裹（待取 ${awaiting} 个，需手动关联）`,
      }
    }
    const merged = mergeCodes(pick.codes ?? (pick.code ? [pick.code] : []), p.code)
    const patch: Partial<Pickup> = { trackUpdatedAt: Date.now() }
    if (merged.length > (pick.codes?.length ?? (pick.code ? 1 : 0))) {
      patch.codes = merged
      // 旧数据里 code 存的是运单号：要用真取件码替掉，不能因为「已有 code」就不写
      if (!pick.code || codeIsMailNo(pick, pick.code)) { patch.code = p.code; (patch as any).pickupCode = p.code }
    }
    if (station) { patch.courierStationName = station; patch.address = station }
    if (pick.status !== 1) { patch.status = 1 }
    if (!pick.arrivedAt) patch.arrivedAt = Date.now()
    updatePickup(pick.uuid, patch)
    return { ok: true, note: `取件码已补到 ${pick.itemTitle || pick.mailNo || "包裹"}` }
  }

  return { ok: false, note: "未识别到单号或取件码" }
}

/** App 侧调用：把 pending 记录逐条落地 */
export function consumeIntentInbox(): { applied: number; failed: number; added: string[] } {
  const all = readAll()
  let applied = 0, failed = 0
  const added: string[] = []
  let dirty = false
  for (const it of all) {
    if (it.status !== "pending") continue
    let r: { ok: boolean; note: string; addedMailNo?: string }
    try { r = applyOne(it) } catch (e) { r = { ok: false, note: String((e as any)?.message ?? e) } }
    it.status = r.ok ? "applied" : "failed"
    it.note = r.note
    if (r.ok && r.addedMailNo) added.push(r.addedMailNo)
    dirty = true
    if (r.ok) applied++; else failed++
  }
  if (dirty) writeAll(all)
  return { applied, failed, added }
}
