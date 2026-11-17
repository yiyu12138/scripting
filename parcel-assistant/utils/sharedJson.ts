/** App / Widget 共享 JSON。操作事件单文件写入，避免跨进程读后清空竞态。 */
export function readJsonFile<T>(path: string, fallback: T): T {
  try {
    if (!FileManager.existsSync(path)) return fallback
    const value = JSON.parse(FileManager.readAsStringSync(path) || "null")
    return value == null ? fallback : value as T
  } catch { return fallback }
}

/** 快照是完整新值，直接写正式文件；FileManager 自身覆盖写，避免“移走旧文件”产生缺文件窗口。 */
export function writeJsonFile(path: string, value: any): boolean {
  try {
    const slash = path.lastIndexOf("/")
    const dir = slash >= 0 ? path.slice(0, slash) : ""
    if (dir && !FileManager.existsSync(dir)) FileManager.createDirectorySync(dir, true)
    FileManager.writeAsStringSync(path, JSON.stringify(value))
    return true
  } catch { return false }
}

/** 操作独占一个新文件：不同进程不竞争同一路径，App 只有落库后才删除对应事件。 */
export function appendOperation(dir: string, value: any): string {
  FileManager.createDirectorySync(dir, true)
  const id = `${Date.now()}-${Math.random().toString(36).slice(2)}`
  const path = `${dir}/${id}.json`
  if (!writeJsonFile(path, value)) throw new Error("共享操作写入失败")
  return id
}

export function operationFiles(dir: string): string[] {
  try {
    if (!FileManager.existsSync(dir)) return []
    // readDirectorySync 返回的是文件名，不是完整路径；不拼接会读不到也删不掉。
    return FileManager.readDirectorySync(dir)
      .filter(name => name.endsWith(".json"))
      .map(name => `${dir}/${name}`)
      .sort()
  } catch { return [] }
}
