// 通知左侧小图标：直接用快递公司官方 logo。
// 例外：顺丰（2）和顺丰同城（21）只有白色单色版（sf_white.png），
// 浅色通知背景上只剩白圈看不清，只给这两家垫深色底。
import { Image, ImageRenderer, Script, Text, VStack } from "scripting"
import { courierAsset, RR } from "../theme"

/** 只有白色单色 logo、必须垫底的公司 */
const WHITE_ONLY = new Set([2, 21])

const cache = new Map<number, Data | undefined>()

function readIfExists(path: string): Data | undefined {
  try {
    return FileManager.existsSync(path) ? (Data.fromFile(path) ?? undefined) : undefined
  } catch { return undefined }
}

function genPath(code: number): string {
  return `${Script.directory}/assets/gen/icon-${code}.png`
}

/** 生成并缓存一张带深色底的通知图标；生成失败就退回原图 */
export async function courierIconData(code: number | null | undefined): Promise<Data | undefined> {
  if (!code) return undefined
  if (cache.has(code)) return cache.get(code)

  const slug = courierAsset(code)
  if (!slug) { cache.set(code, undefined); return undefined }
  const src = `${Script.directory}/assets/${slug}`
  const raw = readIfExists(src)
  if (!raw) { cache.set(code, undefined); return undefined }

  // 其它公司官方图标本来就能看清，不加工
  if (!WHITE_ONLY.has(code)) {
    cache.set(code, raw)
    return raw
  }

  // 生成过的直接用磁盘缓存（小组件环境里渲染不了，只能靠这里）
  const cached = readIfExists(genPath(code))
  if (cached) { cache.set(code, cached); return cached }

  try {
    const img = UIImage.fromFile(src)
    if (!img) throw new Error("no image")
    const png = await ImageRenderer.toPNGData(
      <VStack
        frame={{ width: 64, height: 64 }}
        background={{ style: "#1C1C1E", shape: RR(15) }}
        clipShape={RR(15)}>
        <Image image={img} resizable antialiased interpolation="high"
          frame={{ width: 40, height: 40 }} />
      </VStack>,
      { scale: 3, opaque: true }
    )
    try {
      FileManager.createDirectorySync(`${Script.directory}/assets/gen`)
      FileManager.writeAsDataSync(genPath(code), png)
    } catch { }
    cache.set(code, png)
    return png
  } catch {
    // 渲染失败（例如扩展环境）就用原图，宁可有图标也别没有
    cache.set(code, raw)
    return raw
  }
}

let warnCache: Data | undefined

/** 故障类通知（同步失败/需要验证）左侧图标：就一个 ⚠️，不加底色 */
export async function warningIconData(): Promise<Data | undefined> {
  if (warnCache) return warnCache
  const path = `${Script.directory}/assets/gen/icon-warning.png`
  const cached = readIfExists(path)
  if (cached) { warnCache = cached; return cached }
  try {
    const png = await ImageRenderer.toPNGData(
      <VStack frame={{ width: 64, height: 64 }}>
        <Text font={54}>⚠️</Text>
      </VStack>,
      { scale: 3, opaque: false }
    )
    try {
      FileManager.createDirectorySync(`${Script.directory}/assets/gen`)
      FileManager.writeAsDataSync(path, png)
    } catch { }
    warnCache = png
    return png
  } catch {
    // 渲染不了就退回「无自定义图标」，标题里的 ⚠️ 兜底
    return undefined
  }
}

/** 预热：把用得到的快递公司图标都生成一遍，避免排通知时现场渲染 */
export async function warmCourierIcons(codes: Array<number | null | undefined>): Promise<void> {
  for (const code of codes) {
    if (!code) continue
    try { await courierIconData(code) } catch { }
  }
}
