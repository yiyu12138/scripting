// 包裹助手外观主题 —— 浅色/深色双主题，色值全部取自真机截图
//   浅色：analysis 统计页截图 1206×3358 实测（底 #F1F1F5 / 卡片 #FFFFFF）
//   深色：screenshots/screen2-4.png 实测（底 #000 / 卡片 #1C1C1E / 统计卡 #202022）
// 用法：组件里直接写 C.text / C.card，取值在「读取的那一刻」按系统深浅色解析，所以切换主题会自动跟随。
// 液态玻璃：本机实测 UIGlass.*.tint() 与 GlassEffectContainer 会白屏，只使用无 tint 的 regular/clear。
import type { Color, LinearGradient } from "scripting"

export type Palette = {
  bg: Color          // 页面底色
  card: Color        // 卡片
  card2: Color       // 次级卡片（统计小块）
  elevated: Color    // 设置分组
  tabBar: Color      // TabBar 底（半透明，叠玻璃）
  tabPill: Color     // 选中 Tab 的胶囊
  text: Color
  white: Color       // 固定纯白（用于彩色底上的文字）
  secondary: Color
  tertiary: Color
  separator: Color
  accent: Color      // 选中紫
  orange: Color
  brown: Color
  green: Color
  blue: Color
  zto: Color
  purple: Color
  red: Color
  // 统计页专用
  limeCard: Color
  limeText: Color
  limeSub: Color
  nightTop: Color
  nightBottom: Color
  tileBox: Color
  tileCal: Color
  tileCup: Color
  tileFilm: Color
  iconBox: Color
  iconCal: Color
  iconCup: Color
  iconFilm: Color
  track: Color
  searchField: Color  // 搜索框：比页面底更清楚，但不抢卡片层次
  barTrack: Color
}

const LIGHT: Palette = {
  bg: "#F1F1F5" as Color,
  card: "#FFFFFF" as Color,
  card2: "#FFFFFF" as Color,
  elevated: "#FFFFFF" as Color,
  tabBar: "rgba(255,255,255,0.34)" as Color,
  tabPill: "#E9E8EF" as Color,
  text: "#0B0B0C" as Color,
  white: "#FFFFFF" as Color,
  secondary: "#6E6E73" as Color,
  tertiary: "#9A9AA0" as Color,
  separator: "rgba(0,0,0,0.07)" as Color,
  accent: "#6B5BD2" as Color,
  orange: "#F08A2E" as Color,
  brown: "#B4813A" as Color,
  green: "#34A853" as Color,
  blue: "#2F7BF6" as Color,
  zto: "#2C63C8" as Color,
  purple: "#6B5BD2" as Color,
  red: "#F0554F" as Color,
  limeCard: "#DDFBA6" as Color,
  limeText: "#2C3A12" as Color,
  limeSub: "#5C6B3A" as Color,
  nightTop: "#463D7A" as Color,
  nightBottom: "#2C6B4C" as Color,
  tileBox: "#FDECD8" as Color,
  tileCal: "#E6F7E3" as Color,
  tileCup: "#FDE7E5" as Color,
  tileFilm: "#ECE9FD" as Color,
  iconBox: "#E8833A" as Color,
  iconCal: "#34A853" as Color,
  iconCup: "#F0554F" as Color,
  iconFilm: "#6B5BD2" as Color,
  track: "#EDEDF1" as Color,
  searchField: "#E2E2E8" as Color,
  barTrack: "#E9E9EE" as Color,
}

const DARK: Palette = {
  bg: "#000000" as Color,
  card: "#1C1C1E" as Color,
  card2: "#202022" as Color,
  elevated: "#1C1C1E" as Color,
  tabBar: "rgba(32,32,34,0.42)" as Color,
  tabPill: "#0A0A0A" as Color,
  text: "#FFFFFF" as Color,
  white: "#FFFFFF" as Color,
  secondary: "#9C9CA0" as Color,
  tertiary: "#68686C" as Color,
  separator: "rgba(255,255,255,0.08)" as Color,
  accent: "#7B61FF" as Color,
  orange: "#E8A050" as Color,
  brown: "#937036" as Color,
  green: "#57C46B" as Color,
  blue: "#3478F6" as Color,
  zto: "#224F9A" as Color,
  purple: "#6B5BD2" as Color,
  red: "#F0554F" as Color,
  limeCard: "#2B3617" as Color,
  limeText: "#E8F5C8" as Color,
  limeSub: "#A9BA86" as Color,
  nightTop: "#3E3570" as Color,
  nightBottom: "#27624A" as Color,
  tileBox: "#3A2A1A" as Color,
  tileCal: "#1F3321" as Color,
  tileCup: "#3A1F1E" as Color,
  tileFilm: "#292346" as Color,
  iconBox: "#E8A05A" as Color,
  iconCal: "#57C46B" as Color,
  iconCup: "#F07070" as Color,
  iconFilm: "#8B7BE8" as Color,
  track: "#2A2A2C" as Color,
  searchField: "#343438" as Color,
  barTrack: "#2A2A2C" as Color,
}

/** 当前系统深浅色（每次读取都重新取，切换主题立即生效） */
export function isDark(): boolean {
  const forced = (globalThis as any).__ccForceDark
  if (typeof forced === "boolean") return forced
  try { return Device.colorScheme === "dark" } catch { return false }
}

/**
 * 手动指定的配色（AppearancePage 选了深/浅色时才有值）。
 * Sheet / 二级页是独立 presentation，不会继承主界面的 preferredColorScheme，
 * 所以它们需要自己再应用一次。
 */
export function schemeOverride(): "dark" | "light" | undefined {
  return (globalThis as any).__ccScheme
}

export function palette(): Palette {
  const base = isDark() ? DARK : LIGHT
  // 主题色：主页颜色设置选中项映射到 accent，让选中 tab、按钮、高亮一起变色。
  const theme = (globalThis as any).__ccThemeColor as string | undefined
  if (theme === "天空蓝") return { ...base, accent: "#2F7BF6" as Color }
  if (theme === "青柠绿") return { ...base, accent: "#7BB661" as Color }
  if (theme === "品牌橙") return { ...base, accent: "#F08A2E" as Color }
  return base // 星辉紫/未设置：默认紫
}

/** 系统级动态颜色：同时给出深浅两套值，由 SwiftUI 按当前配色表自动选择。
 *  这样切换深浅色不需要 JS 重新渲染，彻底避免“标题/按钮颜色停在旧值、重启才恢复”。 */
export function dyn(light: Color, dark: Color): any {
  return { light, dark } as any
}

// 动态化白名单：只包含仅用于前景/背景/形状填色的 token。
// 排除：渐变用（nightTop/nightBottom/lime*）与靠字符串比较的 barTrack。
const DYN_KEYS = [
  "bg", "card", "card2", "elevated", "text", "white", "secondary", "tertiary", "separator",
  "orange", "brown", "green", "blue", "zto", "red", "track", "searchField", "barTrack", "tabBar", "tabPill",
  "tileBox", "tileCal", "tileCup", "tileFilm", "iconBox", "iconCal", "iconCup", "iconFilm",
] as const

const DYN: Record<string, any> = (() => {
  const out: Record<string, any> = {}
  for (const k of DYN_KEYS) out[k] = dyn((LIGHT as any)[k], (DARK as any)[k])
  return out
})()

/** 主题色：三套预设同色适用深浅两模式，故也用动态对象 */
const THEME_ACCENT: Record<string, string> = {
  "天空蓝": "#2F7BF6",
  "青柠绿": "#7BB661",
  "品牌橙": "#F08A2E",
}

/** 动态调色板：C.xxx 取到的是「此刻」的颜色（大部分为系统自适应） */
export const C: Palette = new Proxy({} as Palette, {
  get(_t, key: string) {
    if (key === "accent") {
      const theme = (globalThis as any).__ccThemeColor as string | undefined
      if (theme && THEME_ACCENT[theme]) return THEME_ACCENT[theme] as any
      return dyn(LIGHT.accent, DARK.accent)
    }
    if (key in DYN) return DYN[key]
    return (palette() as any)[key]
  },
  has(_t, key: string) { return key in LIGHT },
  ownKeys() { return Object.keys(LIGHT) },
  getOwnPropertyDescriptor() { return { enumerable: true, configurable: true } },
}) as Palette

/** 退款 / 退货 / 取消这类终态的颜色（与「派送中」的橙区分开） */
export const CLOSED_TINT: Color = "#FF453A" as Color

function g(colors: Color[], vertical = true): LinearGradient {
  return {
    colors,
    startPoint: vertical ? { x: 0.5, y: 0 } : { x: 0, y: 0.5 },
    endPoint: vertical ? { x: 0.5, y: 1 } : { x: 1, y: 0.5 },
  }
}

export const GRAD = {
  get reminder() {
    return isDark()
      ? g(["#1D2F20" as Color, "#0C150E" as Color, "#000000" as Color])
      : g(["#E9F4EA" as Color, "#F3F3F7" as Color, "#F1F1F5" as Color])
  },
  get stats() {
    return isDark()
      ? g(["#0B1510" as Color, "#030704" as Color, "#000000" as Color])
      : g(["#F1F1F5" as Color, "#F1F1F5" as Color])
  },
  gold: g(["#F7E3A1" as Color, "#B8862B" as Color, "#F0D68A" as Color], false),
  get night() {
    return g([C.nightTop, C.nightBottom])
  },
  // 白昼卡（浅色模式的「本月取件」）：晴空蓝→草绿，呼应夜空紫→绿
  get day() {
    return g(["#5B8DEF" as Color, "#57B66D" as Color])
  },
  get lime() {
    return isDark()
      ? g(["#333F1B" as Color, "#283314" as Color])
      : g(["#E4FFB4" as Color, "#D6F79A" as Color])
  },
}

export function alpha(hex: string, a: number): Color {
  const h = hex.replace("#", "")
  return `rgba(${parseInt(h.slice(0, 2), 16)},${parseInt(h.slice(2, 4), 16)},${parseInt(h.slice(4, 6), 16)},${a})` as Color
}

export const RR = (r: number) => ({ type: "rect" as const, cornerRadius: r, style: "continuous" as const })
export const CAPSULE = { type: "capsule" as const, style: "continuous" as const }

// iOS 26 液态玻璃（本机实测可渲染的无 tint 配置）。
// 用 getter：UIGlass 只在 App 里存在，桌面小组件扩展加载 theme.ts 时不能碰它（一碰就整包抛错）。
export const GLASS = {
  get tab() { return { glass: UIGlass.regular().interactive(false), shape: CAPSULE } },
  get selectedTab() { return { glass: UIGlass.clear(), shape: CAPSULE } },
  get topButton() { return { glass: UIGlass.clear().interactive(true), shape: CAPSULE } },
  get floating() { return { glass: UIGlass.clear().interactive(true), shape: CAPSULE } },
} as const

/** 玻璃按钮的底色：深色半透黑、浅色半透白。
 *  参考真机截图：深色按钮内部为 #202020（背景纯黑），且卡片文字能透出来——
 *  即“clear 玻璃（磨砂层约 #414141）+ 黑 0.5 左右半透底”。不能用实心色，否则会变成一块死灰。 */
export const GLASS_TINT = alpha(isDark() ? "#000000" : "#FFFFFF", 0.55)


/** 非交互容器的半透底（Tab 栏等）。动态，不依赖重渲染。 */
export function glassFill(): any {
  return dyn(alpha("#FFFFFF", 0.55), alpha("#000000", 0.34))
}

/** 卡片玻璃：本机实测会在卡片外围多画一层淡阴影（用户反馈的多余阴影），卡片一律不加。 */
export function glassCard(_radius: number): any {
  return undefined
}

/** 图标块同理不加玻璃（不然小方块周围也有一圈影） */
export function glassLogo(_radius: number): any {
  return undefined
}

export function companyName(code: number | null | undefined): string {
  switch (code) {
    case 1: return "中通快递"; case 2: return "顺丰速运"; case 3: return "圆通速递"
    case 4: return "韵达快递"; case 5: return "申通快递"; case 6: return "极兔速递"
    case 7: return "中国邮政"; case 8: return "京东物流"; case 9: return "德邦快递"
    case 10: return "丰巢"; case 11: return "菜鸟驿站"; case 12: return "百世快递"
    case 13: return "天天快递"; case 14: return "宅急送"; case 15: return "苏宁物流"
    case 16: return "DHL"; case 17: return "联邦快递"; case 18: return "UPS"
    case 19: return "达达快送"; case 20: return "闪送"; case 21: return "顺丰同城"
    default: return "其他快递"
  }
}

export type CourierSymbol = { icon: string; tint: string; iconColor: string }

/** App 内 assets/vcards 的文件名；实时活动会把它们复制到 App Group 再显示。 */
export function courierAsset(code: number | null | undefined): string | undefined {
  switch (code) {
    case 1: return "vcards/zto.png"
    case 2: return "vcards/sf_white.png"
    case 3: return "vcards/yto.png"
    case 4: return "vcards/yunda.png"
    case 5: return "vcards/sto.png"
    case 6: return "vcards/jtexpress.png"
    case 7: return "vcards/china_post.png"
    case 8: return "vcards/jd.png"
    case 9: return "vcards/debang.png"
    case 10: return "vcards/hive.png"
    case 11: return "vcards/cainiao.png"
    case 12: return "vcards/best.png"
    case 16: return "vcards/dhl.png"
    case 17: return "vcards/fedex.png"
    case 18: return "vcards/ups.png"
    case 19: return "vcards/dada.png"
    case 20: return "vcards/shansong.png"
    case 21: return "vcards/sf_white.png"
    default: return undefined
  }
}

/** 实时活动只能使用 SF Symbols，用品牌色圆角块 + 白色符号接近 App 内的快递 logo。 */
export function courierSymbol(code: number | null | undefined): CourierSymbol {
  switch (code) {
    case 1: return { icon: "shippingbox.fill", tint: "#2F6BFF", iconColor: "#FFFFFF" }
    case 2: return { icon: "paperplane.fill", tint: "#111111", iconColor: "#FFFFFF" }
    case 3: return { icon: "shippingbox.fill", tint: "#7B61FF", iconColor: "#FFFFFF" }
    case 4: return { icon: "shippingbox.fill", tint: "#F0A03C", iconColor: "#FFFFFF" }
    case 5: return { icon: "shippingbox.fill", tint: "#2F7BF6", iconColor: "#FFFFFF" }
    case 6: return { icon: "shippingbox.fill", tint: "#F0554F", iconColor: "#FFFFFF" }
    case 7: return { icon: "envelope.fill", tint: "#1E8E3E", iconColor: "#FFFFFF" }
    case 8: return { icon: "shippingbox.fill", tint: "#F0554F", iconColor: "#FFFFFF" }
    case 9: return { icon: "shippingbox.fill", tint: "#2F7BF6", iconColor: "#FFFFFF" }
    case 10: return { icon: "mailbox.fill", tint: "#F5C400", iconColor: "#111111" }
    case 11: return { icon: "shippingbox.fill", tint: "#2F7BF6", iconColor: "#FFFFFF" }
    case 12: return { icon: "shippingbox.fill", tint: "#F0A03C", iconColor: "#FFFFFF" }
    case 16: return { icon: "shippingbox.fill", tint: "#FFCC00", iconColor: "#111111" }
    case 17: return { icon: "shippingbox.fill", tint: "#7B61FF", iconColor: "#FFFFFF" }
    case 18: return { icon: "shippingbox.fill", tint: "#6B4A2B", iconColor: "#FFFFFF" }
    case 19: return { icon: "bicycle", tint: "#2F7BF6", iconColor: "#FFFFFF" }
    case 20: return { icon: "bolt.fill", tint: "#2F7BF6", iconColor: "#FFFFFF" }
    case 21: return { icon: "paperplane.fill", tint: "#111111", iconColor: "#FFFFFF" }
    default: return { icon: "truck.box.fill", tint: "#F0A23A", iconColor: "#FFFFFF" }
  }
}

export function companyCode(name: string): number {
  const m: Record<string, number> = {
    "中通快递": 1, "中通": 1, "顺丰速运": 2, "顺丰": 2,
    "圆通速递": 3, "圆通": 3, "韵达快递": 4, "韵达": 4, "申通快递": 5, "申通": 5,
    "极兔速递": 6, "极兔": 6, "邮政快递": 7, "邮政": 7, "中国邮政": 7,
    "京东物流": 8, "京东": 8, "德邦快递": 9, "德邦": 9,
    "丰巢": 10, "丰巢柜": 10, "菜鸟驿站": 11, "菜鸟": 11,
    "百世快递": 12, "百世": 12, "天天快递": 13, "天天": 13,
    "宅急送": 14, "苏宁物流": 15, "苏宁": 15,
    "DHL": 16, "dhl": 16, "联邦快递": 17, "FedEx": 17, "fedex": 17,
    "UPS": 18, "ups": 18, "达达快送": 19, "达达": 19,
    "闪送": 20, "顺丰同城": 21,
  }
  return m[name] ?? 0
}


