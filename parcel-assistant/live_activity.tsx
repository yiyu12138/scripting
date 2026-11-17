// 灵动岛 / 锁屏实时活动 UI —— 必须独立注册，系统渲染时直接运行此文件。
import {
  HStack, Image, LiveActivity, LiveActivityUI, LiveActivityUIExpandedBottom,
  Script, Text, VStack, type LiveActivityUIBuilder,
} from "scripting"

/** 点实时活动/锁屏卡片直接跑本脚本（不是只把 Scripting 拉到前台）。
 *  widgetURL 必须是根节点的修饰符，子节点上会被忽略。 */
const OPEN_APP_URL = Script.createRunURLScheme(Script.name)

export type PickupActivityItem = {
  code: string
  company: string
  station: string
  icon: string
  tint: string
  iconColor: string
  logoPath?: string
}

export type PickupActivityState = {
  pending: number
  items?: PickupActivityItem[]
  // 兼容旧活动状态
  code?: string
  company?: string
  station?: string
  style: string
  updatedAt: number
}

const RR = (r: number) => ({ type: "rect" as const, cornerRadius: r, style: "continuous" as const })

/** 深浅两套值，由系统按当前渲染环境选（锁屏是深色就用白字） */
const dyn = (light: any, dark: any) => ({ light, dark }) as any

function palette(style: string) {
  if (style === "纯白色") return {
    bg: "white" as any,
    fg: "black" as any,
    dim: "gray" as any,
    line: "#D1D1D6" as any,
  }
  if (style === "纯黑色") return {
    bg: "black" as any,
    fg: "white" as any,
    dim: "secondary" as any,
    line: "#3A3A3C" as any,
  }
  // 液态玻璃：背景交给系统材质，文字不能写 "primary"/"secondary"
  // —— 实测这两个词在该环境直接渲染成黑色，深色锁屏上等于看不见。
  return {
    bg: dyn("clear", "clear"),
    fg: dyn("#111111", "#FFFFFF"),
    dim: dyn("rgba(0,0,0,0.55)", "rgba(255,255,255,0.72)"),
    line: dyn("rgba(0,0,0,0.16)", "rgba(255,255,255,0.3)"),
  }
}

function normalizedItems(state: PickupActivityState): PickupActivityItem[] {
  if (state.items?.length) return state.items
  if (!state.code) return []
  return [{
    code: state.code,
    company: state.company ?? "",
    station: state.station ?? "",
    icon: "truck.box.fill",
    tint: "#F0A23A",
    iconColor: "#FFFFFF",
  }]
}

/** Image 的 filePath 在实时活动/组件环境里经常读不到（只剩灰块），
 *  统一先用 UIImage 把文件读进来再交给 Image。 */
const logoCache = new Map<string, UIImage | null>()
function logoImage(path: string | undefined): UIImage | null {
  if (!path) return null
  if (!logoCache.has(path)) {
    let img: UIImage | null = null
    try { img = UIImage.fromFile(path) } catch { img = null }
    logoCache.set(path, img)
  }
  return logoCache.get(path) ?? null
}

export function Logo({ item, size, zIndex }: { item: PickupActivityItem; size: number; zIndex?: number }) {
  const radius = Math.round(size * 0.26)
  const img = logoImage(item.logoPath)
  return (
    <VStack frame={{ width: size, height: size }} zIndex={zIndex}
      background={{ style: item.tint as any, shape: RR(radius) }} clipShape={RR(radius)}>
      {img ? (
        <Image image={img} resizable antialiased interpolation="high"
          frame={{ width: size, height: size }} />
      ) : (
        <Image systemName={item.icon} font={Math.round(size * 0.45)}
          foregroundStyle={(item.iconColor === "#FFFFFF" ? "white" : "black") as any} />
      )}
    </VStack>
  )
}

function Dashed({ color }: { color: any }) {
  return (
    <HStack spacing={4} frame={{ maxWidth: "infinity" }}>
      {Array.from({ length: 32 }, (_, i) => (
        <VStack key={i} frame={{ width: 4, height: 1 }} background={color} />
      ))}
    </HStack>
  )
}

/** 单条：和设置里的预览一致（logo + 驿站/快递 + 虚线 + 大码）。 */
function SingleItem({ item, p }: { item: PickupActivityItem; p: ReturnType<typeof palette> }) {
  return (
    <VStack spacing={6} alignment="leading" frame={{ maxWidth: "infinity", alignment: "leading" }}>
      <HStack spacing={10} frame={{ maxWidth: "infinity" }}>
        <Logo item={item} size={40} />
        <VStack alignment="leading" spacing={1} frame={{ maxWidth: "infinity", alignment: "leading" }}>
          <Text font={15} fontWeight="semibold" foregroundStyle={p.fg} lineLimit={1}>
            {item.station || item.company}
          </Text>
          <Text font={12} foregroundStyle={p.dim} lineLimit={1}>{item.company}</Text>
        </VStack>
      </HStack>
      <Dashed color={p.line} />
      <Text font={28} fontWeight="bold" foregroundStyle={p.fg} lineLimit={1}>{item.code || "暂无取件码"}</Text>
    </VStack>
  )
}

/** 按驿站归组：同一个驿站的包裹算一组，一组占一行。没有驿站信息的退回快递公司。 */
function groupByStation(items: PickupActivityItem[]) {
  const out: { name: string; codes: string[] }[] = []
  for (const it of items) {
    const name = (it.station || it.company || "").trim()
    const g = out.find(x => x.name === name)
    if (g) g.codes.push(it.code)
    else out.push({ name, codes: [it.code] })
  }
  return out
}

/** 同一家快递只画一个图标（两件中通不画两个中通）。 */
function uniqueLogos(items: PickupActivityItem[], max: number) {
  const seen = new Set<string>()
  const out: PickupActivityItem[] = []
  for (const it of items) {
    const key = it.logoPath || it.company || it.icon
    if (seen.has(key)) continue
    seen.add(key)
    out.push(it)
    if (out.length >= max) break
  }
  return out
}

/** 图标条：去重后并排，越靠左 zIndex 越高（叠加时左边压右边）。 */
export function LogoStack({ items, size, spacing, max }: {
  items: PickupActivityItem[]; size: number; spacing: number; max: number
}) {
  const picks = uniqueLogos(items, max)
  return (
    <HStack spacing={spacing} alignment="center">
      {picks.map((it, i) => (
        <Logo key={`${it.company}-${i}`} item={it} size={size} zIndex={picks.length - i} />
      ))}
    </HStack>
  )
}

/** 名称太长时保留哪一头：
 *   · 驿站/柜机名 → 留前面（菜鸟驿站…），省略号在末尾；
 *   · 纯地址 → 用「头部省略」，剩下的永远是末尾（…XX路 2 号某公寓），
 *     因为地址只有最后几级才能看出是哪里。
 *  不能自己先切片再交给 Text 截断——那样末尾的具体位置会被再截一次删掉。 */
function stationText(name: string): { text: string; mode: "head" | "tail" } {
  const t = (name || "").replace(/\s+/g, " ").trim()
  if (!t) return { text: "", mode: "tail" }
  if (/驿站|快递柜|代收|自提|服务点|店|柜/.test(t)) return { text: t, mode: "tail" }
  return { text: t, mode: "head" }
}

/** 码拼接：没有码的单不要留空行 */
function codesText(codes: string[]): string {
  return codes.map(c => (c || "").trim() || "暂无取件码").join(" · ")
}

/** 取件码字号：同一页里统一。
 *  单驿站时右边没有驿站名列，宽度富裕，用 18；多驿站要留出驿站名+图标，用 15。 */
const CODE_FONT_SINGLE = 18
const CODE_FONT_MULTI = 15
/** 单驿站时一行放几个码 */
const CODES_PER_ROW = 2
/** 驿站名定宽：名字长了就省略号，绝不挤压左边的取件码 */
const STATION_COL = 74
/** 图标区定宽：放不下的图标就不再加（最多 3 个） */
const ICON_COL = 68
const ICON_SIZE = 26

/** 多条：保持原来的排版——左边「N 件待取」+（单驿站时）驿站名 + 码行，右边叠放的图标。 */
function MultiItems({ state, items, p }: {
  state: PickupActivityState; items: PickupActivityItem[]; p: ReturnType<typeof palette>
}) {
  const groups = groupByStation(items)
  const single = groups.length === 1
  const pending = state.pending || items.length
  const shown = single ? items.length : groups.slice(0, 4).reduce((n, g) => n + g.codes.length, 0)
  const rest = Math.max(0, pending - shown)
  const codeFont = single ? CODE_FONT_SINGLE : CODE_FONT_MULTI
  const rows: string[] = []
  if (single) {
    const codes = groups[0].codes
    for (let i = 0; i < codes.length; i += CODES_PER_ROW) {
      rows.push(codesText(codes.slice(i, i + CODES_PER_ROW)))
    }
  }
  return (
    <HStack spacing={8} frame={{ maxWidth: "infinity", alignment: "center" }}>
      <VStack spacing={4} alignment="leading" frame={{ maxWidth: "infinity", alignment: "leading" }}>
        <HStack spacing={6} frame={{ maxWidth: "infinity", alignment: "leading" }}>
          <Text font={17} fontWeight="bold" foregroundStyle={p.fg} lineLimit={1}>{pending} 件待取</Text>
          {single && groups[0].name
            ? <Text font={12} foregroundStyle={p.dim} lineLimit={1}
              truncationMode={stationText(groups[0].name).mode}>
              {stationText(groups[0].name).text}
            </Text>
            : null}
        </HStack>
        {single ? (
          // 只有一个驿站：整行宽度全给码（驿站名已在标题行）
          rows.map((r, i) => (
            <Text key={i} font={codeFont} fontWeight="bold" foregroundStyle={p.fg} lineLimit={1}
              truncationMode="tail" frame={{ maxWidth: "infinity", alignment: "leading" }}>{r}</Text>
          ))
        ) : (
          // 多个驿站：一行一个驿站——左边只放取件码，右边驿站名占固定宽度
          groups.slice(0, 4).map((g, i) => (
            <HStack key={i} spacing={6} frame={{ maxWidth: "infinity", alignment: "leading" }}>
              <Text font={codeFont} fontWeight="bold" foregroundStyle={p.fg} lineLimit={1}
                truncationMode="tail" frame={{ maxWidth: "infinity", alignment: "leading" }}>
                {codesText(g.codes)}
              </Text>
              <Text font={10} foregroundStyle={p.dim} lineLimit={1}
                truncationMode={stationText(g.name).mode}
                frame={{ width: STATION_COL, alignment: "trailing" }}>{stationText(g.name).text}</Text>
            </HStack>
          ))
        )}
        {rest > 0 ? <Text font={12} foregroundStyle={p.dim}>还有 {rest} 件</Text> : null}
      </VStack>
      {/* 图标区定宽：去重后叠放，放不下的不再加 */}
      <VStack frame={{ width: ICON_COL, alignment: "trailing" }}>
        <LogoStack items={items} size={ICON_SIZE} spacing={-9} max={3} />
      </VStack>
    </HStack>
  )
}

export function Content({ state, dark = false }: { state: PickupActivityState; dark?: boolean }) {
  // 灵动岛底色恒为黑色：展开区的文字必须用深色套（白字），
  // 否则用户选了「纯白色」样式时，岛上就是黑字黑底 = 什么都看不到。
  const p = palette(dark ? "纯黑色" : state.style)
  const items = normalizedItems(state)
  if (!items.length) {
    return <Text font={14} foregroundStyle={p.dim}>所有快递都已取走</Text>
  }
  return items.length === 1
    ? <SingleItem item={items[0]} p={p} />
    : <MultiItems state={state} items={items} p={p} />
}

const builder: LiveActivityUIBuilder<PickupActivityState> = state => {
  const items = normalizedItems(state)
  const first = items[0]
  const p = palette(state.style)
  return (
    <LiveActivityUI
      keylineTint={"systemOrange" as any}
      content={
        <VStack padding={{ horizontal: 16, vertical: 12 }} frame={{ maxWidth: "infinity" }}
          widgetURL={OPEN_APP_URL}
          activityBackgroundTint={p.bg}>
          <Content state={state} />
        </VStack>
      }
      // 紧凑态：左边待取件数，右边叠起来的快递图标（去重，最多两个）
      compactLeading={
        // 紧凑区很窄：字号 12 再允许缩到 0.75，保证「12 件待取」不会被截断
        <Text font={12} fontWeight="semibold" foregroundStyle="white" lineLimit={1} minScaleFactor={0.75}>
          {`${state.pending} 件待取`}
        </Text>
      }
      compactTrailing={
        items.length
          ? <LogoStack items={items} size={18} spacing={-5} max={2} />
          : <Image systemName="shippingbox.fill" font={13} foregroundStyle={p.fg} />
      }
      minimal={first ? <Logo item={first} size={20} /> : (
        <Image systemName="shippingbox.fill" font={14} foregroundStyle={"systemOrange" as any} />
      )}>
      <LiveActivityUIExpandedBottom>
        <VStack padding={{ bottom: 10, horizontal: 4 }} frame={{ maxWidth: "infinity" }}
          widgetURL={OPEN_APP_URL}>
          <Content state={state} dark />
        </VStack>
      </LiveActivityUIExpandedBottom>
    </LiveActivityUI>
  )
}

export const PickupLiveActivity = LiveActivity.register("PickupLiveActivity", builder)
