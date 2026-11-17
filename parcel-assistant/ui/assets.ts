// 本地图标缓存：Image 的 filePath 在部分环境读不到 iCloud 路径，统一用 UIImage 读文件。
import { Script } from "scripting"

const cache = new Map<string, UIImage | null>()

export function assetImage(relativePath: string): UIImage {
  return assetImageOrNull(relativePath) ?? UIImage.fromSFSymbol("photo")!
}

/** 取不到就返回 null：桌面小组件扩展读不到工程资源目录，
 *  这时宁可不显示图标，也不能拿占位图充数（以前会显示一个白框）。 */
export function assetImageOrNull(relativePath: string): UIImage | null {
  if (!cache.has(relativePath)) {
    let img: UIImage | null = null
    try { img = UIImage.fromFile(`${Script.directory}/assets/${relativePath}`) } catch { img = null }
    cache.set(relativePath, img)
  }
  return cache.get(relativePath) ?? null
}
