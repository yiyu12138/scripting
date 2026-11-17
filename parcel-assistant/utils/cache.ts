/**
 * 缓存清理 —— 清掉会长大的东西：30 天前已取的包裹、旧识别记录、日志与图标副本。
 *
 * 会清的：
 *  - 已取件超过 30 天的历史包裹（含它那整条物流轨迹）—— 真正会越攒越多的部分
 *  - 识别记录里已经落库/已失败的旧条目（只留还没处理的）
 *  - 身份码缓存（带姓名/证件号）
 *  - 日志与图标副本：cc/*.log、*.html、*.txt、*.keep、*.bak，以及 cc/logos 里历史遗留的大图副本
 *
 * 绝不碰：
 *  - 在途 / 待取的包裹
 *  - 设置、授权 cookie、亲友关系、驿站
 *  - cc/widget.json、timedPlan.json、picked.json、trackUpdates.json、syncErr.json、
 *    platformLast.json、arrivedNotif.json、fullSync.json（跨进程状态，删了会重复提醒或丢已取）
 *  - cc/history-backup-*.json（历史遗留备份，留着当保险）
 */
import { deletePickup, getPickups, resetImportedPackages, resetPickedPackages, type Pickup } from "../store"
import { appliedIntentCount, clearAppliedIntentItems } from "./intentInbox"
import { clearIdentityCaches } from "./identity"

const CC = () => `${FileManager.appGroupDocumentsDirectory}/cc`

/** 历史包裹的保留天数 */
export const HISTORY_DAYS = 30

/** 历史遗留的大图副本目录 */
const LEGACY_DIR = "logos"
/** 诊断/临时文件后缀 */
const TEMP_EXT = /\.(log|html|txt|keep|bak|tmp)$/i
const TEMP_NAMES = new Set(["probe.txt"])

function join(dir: string, name: string): string {
  return name.startsWith(dir) ? name : `${dir}/${name}`
}

function children(dir: string): string[] {
  try { return FileManager.readDirectorySync(dir) ?? [] } catch { return [] }
}

function dirBytes(dir: string): number {
  let total = 0
  for (const raw of children(dir)) {
    const p = join(dir, raw)
    try {
      if (FileManager.isDirectorySync(p)) total += dirBytes(p)
      else total += Number((FileManager.statSync(p) as any)?.size ?? 0)
    } catch { }
  }
  return total
}

/** 收集要清的文件：临时文件 + 历史大图目录 */
function targets(): { files: string[]; dirs: string[] } {
  const files: string[] = []
  const dirs: string[] = []
  for (const raw of children(CC())) {
    const p = join(CC(), raw)
    const name = p.split("/").pop() ?? ""
    let isDir = false
    try { isDir = FileManager.isDirectorySync(p) } catch { }
    if (isDir) {
      if (name === LEGACY_DIR) dirs.push(p)
      continue
    }
    if (TEMP_EXT.test(name) || TEMP_NAMES.has(name)) files.push(p)
  }
  return { files, dirs }
}

/** 已取件且超过 days 天的历史包裹 */
export function oldPickups(days = HISTORY_DAYS): Pickup[] {
  const cut = Date.now() - days * 86400_000
  return getPickups().filter(p => {
    if (p.status !== 2) return false
    const at = Number(p.pickedAt ?? p.arrivedAt ?? p.createdAt ?? 0)
    return at > 0 && at < cut
  })
}

/** 用序列化长度估体积：Storage 拿不到字节数，这是最接近的口径 */
function sizeOf(list: any[]): number {
  let n = 0
  for (const x of list) { try { n += JSON.stringify(x).length } catch { } }
  return n
}

export interface CacheInfo {
  /** 预计可释放的字节数（含历史包裹、识别记录、日志、图标副本） */
  bytes: number
  /** 要删的文件/目录条目数 */
  files: number
  /** 要删的历史包裹数 */
  packages: number
  /** 要删的识别记录数 */
  intents: number
}

/** 当前可清理的内容与体积（按钮上显示的数字） */
export function cacheInfo(days = HISTORY_DAYS): CacheInfo {
  const { files, dirs } = targets()
  let bytes = sizeOf(oldPickups(days))
  for (const f of files) {
    try { bytes += Number((FileManager.statSync(f) as any)?.size ?? 0) } catch { }
  }
  for (const d of dirs) bytes += dirBytes(d)
  const intents = appliedIntentCount()
  bytes += intents * 120
  return { bytes, files: files.length + dirs.length, packages: oldPickups(days).length, intents }
}

/** 清掉；返回实际清理的内容 */
export function clearCache(days = HISTORY_DAYS): CacheInfo {
  const before = cacheInfo(days)
  // 1) 历史包裹：走 store 的 deletePickup，连带清掉它的到站记录与提醒排期
  for (const p of oldPickups(days)) {
    try { deletePickup(p.uuid) } catch { }
  }
  // 2) 识别记录：只留还没处理的
  try { clearAppliedIntentItems() } catch { }
  // 2.5) 身份码缓存：带真实姓名与证件号，清缓存时一并清掉（下次取码会重新向平台要）
  try { clearIdentityCaches() } catch { }
  // 3) 日志与图标副本
  const { files, dirs } = targets()
  for (const f of files) { try { FileManager.removeSync(f) } catch { } }
  for (const d of dirs) { try { FileManager.removeSync(d) } catch { } }
  // 统计的累计口径重置为当前剩余包裹（导入数=剩余总数，已取数=剩余已取数）
  try {
    const left = getPickups()
    resetImportedPackages(left.length)
    resetPickedPackages(left.filter(p => p.status === 2 || p.pickedByUser).length)
  } catch { }
  return before
}

/** 12345 → “12.1 KB” */
export function sizeText(bytes: number): string {
  const b = Math.max(0, Number(bytes) || 0)
  if (b < 1024) return `${b} B`
  if (b < 1024 * 1024) return `${(b / 1024).toFixed(0)} KB`
  return `${(b / 1024 / 1024).toFixed(1)} MB`
}
