// 本地备份：每次备份一个时间目录，最新的一份另存 latest.json 方便读取。
import { Path } from "scripting"

// FileManager 同样是全局对象。
declare const FileManager: {
  documentsDirectory: string
  appGroupDocumentsDirectory: string | null
  existsSync(path: string): boolean
  createDirectorySync(path: string, recursive?: boolean): void
  writeAsStringSync(path: string, content: string): void
  readAsStringSync(path: string): string | null
  readDirectorySync(path: string): string[]
}

export interface BackupModule {
  name: string
  type: string
  enabled: boolean
  description: string
  header: Record<string, string>
  file: string
  bytes: number
  url: string
}

export interface Manifest {
  version: 1
  savedAt: number
  host: string
  dir: string
  modules: BackupModule[]
}

export interface BackupInput {
  name: string
  type: string
  enabled: boolean
  description: string
  header: Record<string, string>
  text: string
}

const ROOT = "SurgeModules"
const LATEST = "latest.json"

export function backupRoot(): string {
  return Path.join(FileManager.appGroupDocumentsDirectory ?? FileManager.documentsDirectory, ROOT)
}

function ensureDir(path: string) {
  if (!FileManager.existsSync(path)) FileManager.createDirectorySync(path, true)
}

function stamp(date = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, "0")
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`
}

function hash(text: string): string {
  let h = 5381
  for (let i = 0; i < text.length; i++) h = ((h << 5) + h + text.charCodeAt(i)) >>> 0
  return h.toString(36)
}

/** 文件名走 ASCII；中文名用短哈希兜底，避免安装链接里出现转义问题。 */
export function safeFileName(name: string): string {
  const base = name.replace(/\.sgmodule$/i, "").replace(/[^\w.@-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60)
  return `${base || "module"}-${hash(name)}.sgmodule`
}

export function saveBackup(host: string, items: BackupInput[]): Manifest {
  const root = backupRoot()
  ensureDir(root)
  const dir = stamp()
  const dirPath = Path.join(root, dir)
  ensureDir(dirPath)

  const modules: BackupModule[] = []
  for (const item of items) {
    const file = safeFileName(item.name)
    FileManager.writeAsStringSync(Path.join(dirPath, file), item.text)
    modules.push({
      name: item.name, type: item.type, enabled: item.enabled, description: item.description,
      header: item.header, file, bytes: item.text.length, url: "",
    })
  }

  const manifest: Manifest = { version: 1, savedAt: Date.now(), host, dir, modules }
  FileManager.writeAsStringSync(Path.join(dirPath, "manifest.json"), JSON.stringify(manifest, null, 2))
  FileManager.writeAsStringSync(Path.join(root, LATEST), JSON.stringify(manifest, null, 2))
  return manifest
}

function parseManifest(raw: unknown): Manifest | null {
  if (!raw || typeof raw !== "object") return null
  const data = raw as Record<string, unknown>
  if (data.version !== 1 || !Array.isArray(data.modules)) return null
  const modules: BackupModule[] = []
  for (const entry of data.modules) {
    if (!entry || typeof entry !== "object") continue
    const item = entry as Record<string, unknown>
    const name = typeof item.name === "string" ? item.name : ""
    const file = typeof item.file === "string" ? item.file : ""
    if (!name || !file) continue
    modules.push({
      name,
      file,
      type: typeof item.type === "string" ? item.type : "",
      enabled: item.enabled === true,
      description: typeof item.description === "string" ? item.description : "",
      header: item.header && typeof item.header === "object" ? item.header as Record<string, string> : {},
      bytes: typeof item.bytes === "number" ? item.bytes : 0,
      url: typeof item.url === "string" ? item.url : "",
    })
  }
  return {
    version: 1,
    savedAt: typeof data.savedAt === "number" ? data.savedAt : 0,
    host: typeof data.host === "string" ? data.host : "",
    dir: typeof data.dir === "string" ? data.dir : "",
    modules,
  }
}

export function readLatest(): Manifest | null {
  try {
    const path = Path.join(backupRoot(), LATEST)
    if (!FileManager.existsSync(path)) return null
    const raw = FileManager.readAsStringSync(path) ?? ""
    return parseManifest(JSON.parse(raw))
  } catch { return null }
}

export function writeLatest(manifest: Manifest): void {
  try {
    FileManager.writeAsStringSync(Path.join(backupRoot(), LATEST), JSON.stringify(manifest, null, 2))
  } catch { /* 写不进去就只保留目录里那份 */ }
}

export function readModuleText(manifest: Manifest, module: BackupModule): string {
  try {
    return FileManager.readAsStringSync(Path.join(backupRoot(), manifest.dir, module.file)) ?? ""
  } catch { return "" }
}
