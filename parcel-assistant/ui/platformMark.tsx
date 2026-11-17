// 商品名前的小平台标：直接用各平台官方 App 图标（assets/identity 下）。
// 优先读 App Group 里的 cc/platform/*.png（小组件也是读这份），没有再退回工程资源。
// 两处都取不到就返回 null —— 组件扩展读不到工程资源，不能拿占位图充数。
import { Image, ZStack } from "scripting"
import { RR } from "../theme"
import { assetImageOrNull } from "./assets"
import { appBrandIconPath, platformIconPath } from "../utils/platformIcons"
import { brandOf } from "../utils/appBrand"

const FILE: Record<string, string> = {
  taobao: "identity/taobao.png",
  jd: "identity/jd.png",
  pdd: "identity/pdd.jpg",
  fengchao: "logos64/hive.png",
}

function fileImage(path: string): UIImage | null {
  if (!path) return null
  try { return FileManager.existsSync(path) ? UIImage.fromFile(path) : null } catch { return null }
}

/** 平台小标（按 source：淘宝/京东/拼多多/丰巢） */
export function platformMarkImage(source?: string): UIImage | null {
  if (!source || !FILE[source]) return null
  return fileImage(platformIconPath(source)) ?? assetImageOrNull(FILE[source])
}

export function PlatformMark({ source, size = 14 }: { source?: string; size?: number }) {
  const image = platformMarkImage(source)
  if (!image) return null
  const radius = Math.max(2, Math.round(size * 0.28))
  return (
    <ZStack frame={{ width: size, height: size }} clipShape={RR(radius)}>
      <Image image={image} resizable antialiased
        interpolation="high" frame={{ width: size, height: size }} />
    </ZStack>
  )
}

/** 来源 App 的市场图标（按 bundle id 查 appBrand：转转/得物/小红书…都能认）。 */
export function appBrandMarkImage(app?: { id?: string; name?: string }): UIImage | null {
  const shared = fileImage(appBrandIconPath(app))
  if (shared) return shared
  const icon = brandOf(app)?.icon
  return icon ? assetImageOrNull(icon) : null
}

/** 来源 App 的平台图标：没收录返回 null，调用方自己决定要不要退回快递公司图标。 */
export function AppBrandMark({ app, size = 14 }: { app?: { id?: string; name?: string }; size?: number }) {
  const image = appBrandMarkImage(app)
  if (!image) return null
  const radius = Math.max(2, Math.round(size * 0.28))
  return (
    <ZStack frame={{ width: size, height: size }} clipShape={RR(radius)}>
      <Image image={image} resizable antialiased
        interpolation="high" frame={{ width: size, height: size }} />
    </ZStack>
  )
}
