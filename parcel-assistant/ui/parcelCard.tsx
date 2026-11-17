/**
 * 包裹卡片的唯一实现 —— 主列表、取件页、设置页预览、桌面小组件全部渲染这一份。
 *
 * 为什么合并：以前 App 用 ui/PickupRow.tsx、桌面组件自己在 widget.tsx 里写了一套
 * OldRow（字号、配色、文案、平台小标位置都不一样），改一处另一处不会跟着变，
 * 结果就是「主脚本加了来源 App 图标，组件里没有」这类不同步。现在：
 *   卡片长什么样 = cardModelOf（纯数据）+ ParcelCardRow（纯视图），
 *   两个参数：size（app / small / medium / large）和 trailing（右侧那块，App 是地址+时间，组件是可点的圈）。
 *
 * 约束：这个文件不能 import store / 任何带 Storage 或网络的东西，
 * 否则整包会被拖进桌面组件的扩展进程（组件只允许读共享目录里的文件）。
 * 图标一律「共享目录优先、工程资源兜底」，组件里前者有、后者没有。
 */
import { HStack, Image, Text, VStack, ZStack, Script } from "scripting"
import { C, CLOSED_TINT, RR, companyName } from "../theme"
import { AppBrandMark, PlatformMark } from "./platformMark"
import { cardTitleOf, dateText, isAwaitingPickup, pickupTimeOf, sourceOf, stationHaystack } from "../utils/model"
import { codeKey, extraCodes } from "../utils/codes"
import { matchStationIn } from "../utils/stationMatch"

/** app = 手机上的卡片；其余三个对应桌面组件尺寸 */
export type CardSize = "app" | "small" | "medium" | "large"

interface Metric {
  logo: number
  code: number
  /** 物流文案当主行时用小一号（长句，别把行撑爆） */
  codeAlt: number
  extra: number
  sub: number
  mark: number
  /** 右侧状态图标的字号 */
  status: number
  /** 右侧触控块的固定高度（组件里靠它对齐） */
  box: number
  gap: number
  inner: number
  /** 主行与副行的间距 */
  line: number
  card: boolean
}

const METRIC: Record<CardSize, Metric> = {
  app: { logo: 42, code: 19, codeAlt: 16, extra: 12, sub: 14, mark: 13, status: 13, box: 20, gap: 11, inner: 6, line: 3, card: true },
  small: { logo: 18, code: 12, codeAlt: 11, extra: 8, sub: 8, mark: 9, status: 11, box: 22, gap: 6, inner: 4, line: 1, card: false },
  medium: { logo: 20, code: 13, codeAlt: 12, extra: 9, sub: 9, mark: 10, status: 11, box: 24, gap: 6, inner: 4, line: 1, card: false },
  large: { logo: 22, code: 13, codeAlt: 12, extra: 9, sub: 10, mark: 11, status: 12, box: 26, gap: 7, inner: 4, line: 2, card: false },
}

/** 右上角那一列最多占多宽：地址不能把商品名挤没 */
const PLACE_MAX_WIDTH = 126

/* ---------------- 图标 ---------------- */

const AG = () => `${FileManager.appGroupDocumentsDirectory}/cc`

function fileImage(path: string): UIImage | null {
  if (!path) return null
  try { return FileManager.existsSync(path) ? UIImage.fromFile(path) : null } catch { return null }
}

function assetImage(rel: string): UIImage | null {
  try { return fileImage(`${Script.directory}/assets/${rel}`) } catch { return null }
}

// 全部取自 vCards 黄页图标；没收录的公司用文字兜底。
const COURIER_FILE: Record<number, string> = {
  1: "zto.png", 2: "sf_white.png", 3: "yto.png", 4: "yunda.png", 5: "sto.png",
  6: "jtexpress.png", 7: "china_post.png", 8: "jd.png", 9: "debang.png", 10: "hive.png",
  11: "cainiao.png", 12: "best.png", 16: "dhl.png", 17: "fedex.png", 18: "ups.png",
  19: "dada.png", 20: "shansong.png", 21: "sf_white.png",
}

// 透明底品牌图标用品牌色铺满圆角块，暗黑模式下不会露出灰底。
const TILE_COLOR: Record<string, any> = {
  "sf_white.png": "#111111",
  "sto.png": "#FF5D00",
  "hive.png": "#F5C400",
  "best.png": "#FFFFFF",
  "dhl.png": "#FFCC00",
  "ups.png": "#2E130B",
  "shansong.png": "#2F7BF6",
}

/** 编号缺失（平台新接入的公司）时按名称猜图标 */
function inferCourier(hint: string): string | undefined {
  const t = hint ?? ""
  if (/菜鸟|驿站/.test(t)) return "cainiao.png"
  if (/丰巢|快递柜/.test(t)) return "hive.png"
  if (/京东/.test(t)) return "jd.png"
  if (/顺丰/.test(t)) return "sf_white.png"
  if (/中通/.test(t)) return "zto.png"
  if (/圆通/.test(t)) return "yto.png"
  if (/韵达/.test(t)) return "yunda.png"
  if (/申通/.test(t)) return "sto.png"
  if (/极兔/.test(t)) return "jtexpress.png"
  if (/德邦/.test(t)) return "debang.png"
  if (/百世/.test(t)) return "best.png"
  if (/邮政|EMS/i.test(t)) return "china_post.png"
  if (/DHL/i.test(t)) return "dhl.png"
  if (/FedEx/i.test(t)) return "fedex.png"
  if (/UPS/.test(t)) return "ups.png"
  return undefined
}

function inferName(hint: string): string | undefined {
  const t = hint ?? ""
  if (/菜鸟/.test(t)) return "菜鸟驿站"
  if (/丰巢|快递柜/.test(t)) return "丰巢"
  if (/京东/.test(t)) return "京东物流"
  if (/顺丰/.test(t)) return "顺丰速运"
  if (/中通/.test(t)) return "中通快递"
  if (/圆通/.test(t)) return "圆通速递"
  if (/韵达/.test(t)) return "韵达快递"
  if (/申通/.test(t)) return "申通快递"
  if (/极兔/.test(t)) return "极兔速递"
  if (/德邦/.test(t)) return "德邦快递"
  return undefined
}

/** 卡片第二行/图标兜底用的公司名（编号→中文名，猜不出就给「其他快递」） */
export function pickupCompanyLabel(code: number, hint: string): string {
  return code === 0 ? (inferName(hint) ?? companyName(code)) : companyName(code)
}

/** 快递 logo：App 里读 512px 的 vcards，桌面组件里读共享目录的 64px 小图。 */
export function courierLogoImage(slug: string): UIImage | null {
  return assetImage(`vcards/${slug}`) ?? fileImage(`${AG()}/logos64/${slug}`)
}

export function CompanyLogo({ code, hint = "", size = 46 }: { code: number; hint?: string; size?: number }) {
  const radius = Math.round(size * 0.26)
  const slug = COURIER_FILE[code] ?? inferCourier(hint)
  const img = slug ? courierLogoImage(slug) : null
  if (slug && img) {
    const tile = TILE_COLOR[slug]
    const sf = slug === "sf_white.png"
    return (
      <ZStack frame={{ width: size, height: size }}
        background={tile ? { style: tile, shape: RR(radius) } : undefined}
        clipShape={RR(radius)}>
        <Image image={img} resizable antialiased interpolation="high"
          frame={{ width: sf ? size * 0.74 : size, height: sf ? size * 0.74 : size }} />
      </ZStack>
    )
  }
  if (code === 0) return (
    <ZStack frame={{ width: size, height: size }} background={{ style: "#F0A23A" as any, shape: RR(radius) }}
      clipShape={RR(radius)}>
      <Image systemName="truck.box.fill" font={Math.round(size * 0.52)} foregroundStyle={C.white} />
    </ZStack>
  )
  return (
    <ZStack frame={{ width: size, height: size }} background={{ style: C.track, shape: RR(radius) }}>
      <Text font={Math.round(size * 0.4)} fontWeight="bold" foregroundStyle={C.secondary}>
        {companyName(code).slice(0, 1)}
      </Text>
    </ZStack>
  )
}

/* ---------------- 卡片数据 ---------------- */

export interface CardModel {
  uuid: string
  companyCode: number
  companyHint: string
  source?: string
  srcApp?: { id?: string; name?: string }
  /** 主行：已关闭状态字 / 取件码 / 物流文案 / 「在途」「暂无取件码」 */
  mainCode: string
  /** 主码旁边并列的其它码 */
  extra: string[]
  /** 副行：商品名（没有就回落平台名/快递公司） */
  subTitle: string
  /** 右侧驿站/地址（App 卡片显示；组件留了开关） */
  place: string
  timeLabel: string
  timeText: string
  useEta: boolean
  statusIcon: string
  statusColor: any
  codeColor: any
  done: boolean
  closed: boolean
  awaiting: boolean
  delivering: boolean
  /** 主行是物流文案（没有取件码的在途件），字用小一号 */
  showLogistics: boolean
}

/**
 * 卡片要显示什么，全部在这里算。
 * stations 传进来就用它匹配驿站（App 有列表，组件只能拿到空数组 → 直接显示平台给的驿站名/地址）。
 */
export function cardModelOf(item: any, stations?: any[]): CardModel {
  const code = Number(item?.companyName ?? item?.company ?? 0) || 0
  const hint = `${item?.address ?? ""} ${item?.courierStationName ?? ""} ${item?.smsContent ?? ""} ${item?.trackCompany ?? ""}`
  const latestText = `${item?.trackLatest ?? ""}`.trim() || `${item?.notes ?? ""}`.trim()
  const awaiting = isAwaitingPickup(item)
  const done = Number(item?.status ?? 1) >= 2 || !!item?.pickedByUser
  const closedLabel = `${item?.closed ?? ""}`.trim()
  const delivering = /派送|派件|配送/.test(latestText)
  const preparing = /待发货|未发货|等待发货|备货|待成团|拼单中|待出库/.test(latestText)

  // 没有真取件码时不要拿运单号冒充（中通这类代收点件常常只有运单号）
  const realCode = (() => {
    const c = `${item?.code ?? ""}`.trim()
    const no = `${item?.mailNo ?? ""}`.trim()
    if (!c) return ""
    if (no && codeKey(c) === codeKey(no)) return ""
    return c
  })()
  const transitRow = !done && !awaiting
  const showLogistics = !realCode && transitRow && !!latestText
  const statusWord = done ? "已取件" : awaiting ? "暂无取件码" : "在途"
  const mainCode = closedLabel || realCode || (showLogistics ? latestText : statusWord)

  // 状态图标：已关单=红叉（不论本地状态）、未发货=包裹盒、在途=卡车（蓝）、
  // 配送中=骑手（橙）、已到站待取=圈、已取=勾
  const statusIcon = closedLabel ? "xmark.circle.fill"
    : done ? "checkmark.circle.fill"
      : preparing ? "shippingbox"
        : transitRow ? (delivering ? "scooter" : "truck.box")
          : "checkmark.circle.fill"
  const statusColor = closedLabel ? CLOSED_TINT
    : done ? C.tertiary
      : preparing ? C.tertiary
        : transitRow ? (delivering ? "#FF9500" : "#2D7BFF")
          : C.green
  const codeColor = closedLabel
    ? CLOSED_TINT
    : showLogistics ? (delivering ? "#FF9500" : "#2D7BFF")
      : (done ? C.tertiary : C.text)

  // 右上角：驿站管理里匹配到的名字 > 平台给的驿站名 > 平台给的完整地址
  const matched = matchStationIn(stations ?? [], stationHaystack(item))
  const place = (matched?.name || item?.courierStationName || item?.address || "").replace(/\s+/g, " ").trim()

  // 时间按状态区分语义：在途=更新（有预估则显示预计）、待取=到站、已取=取件、关闭=关闭
  const tinfo = pickupTimeOf(item)
  const etaAt = Number(item?.etaAt) || 0
  const dayStart = new Date(new Date().getFullYear(), new Date().getMonth(), new Date().getDate()).getTime()
  const useEta = tinfo.label === "更新" && etaAt >= dayStart
  const timeLabel = useEta ? "预计" : tinfo.label
  const timeText = dateText(useEta ? etaAt : tinfo.at)

  const label = pickupCompanyLabel(code, hint)
  return {
    uuid: String(item?.uuid ?? item?.orderId ?? ""),
    companyCode: code,
    companyHint: hint,
    source: sourceOf(item),
    srcApp: item?.srcApp,
    mainCode,
    extra: extraCodes(item?.codes, item?.code ?? item?.mailNo ?? "").filter(c => !item?.mailNo || codeKey(c) !== codeKey(item.mailNo)),
    subTitle: cardTitleOf(item, label),
    place,
    timeLabel,
    timeText,
    useEta,
    statusIcon,
    statusColor,
    codeColor,
    done,
    closed: !!closedLabel,
    awaiting,
    delivering,
    showLogistics,
  }
}

/* ---------------- 片段 ---------------- */

const SUB = () => C.secondary
const FAINT = () => C.tertiary

/** 右侧状态图标（组件在途行、没有点圈能力的位置用） */
export function StatusIcon({ m, size = "app" }: { m: CardModel; size?: CardSize }) {
  const s = METRIC[size]
  return (
    <Image systemName={m.statusIcon} font={s.status}
      foregroundStyle={m.statusColor}
      frame={{ width: s.box, height: s.box }} />
  )
}

/** App 卡片右侧：驿站/地址 + 状态图标和时间 */
export function PlaceBlock({ m, size = "app" }: { m: CardModel; size?: CardSize }) {
  const s = METRIC[size]
  const color = m.done ? FAINT() : SUB()
  return (
    <VStack alignment="trailing" spacing={size === "app" ? 6 : 2}
      frame={{ maxWidth: PLACE_MAX_WIDTH, alignment: "trailing" }}>
      {m.place
        ? <Text font={s.sub} foregroundStyle={color} lineLimit={1}
          truncationMode={/驿站|快递柜|代收|自提|服务点|店|柜/.test(m.place) ? "tail" : "head"}
          frame={{ maxWidth: PLACE_MAX_WIDTH, alignment: "trailing" }}>{m.place}</Text>
        : null}
      <HStack spacing={4}>
        <StatusIcon m={m} size={size} />
        <Text font={s.sub} lineLimit={1} foregroundStyle={m.useEta ? SUB() : m.statusColor}>
          {m.timeText ? `${m.timeLabel} ${m.timeText}` : m.timeLabel}
        </Text>
      </HStack>
    </VStack>
  )
}

/* ---------------- 整行 ---------------- */

export interface ParcelCardRowProps {
  item: any
  size?: CardSize
  /** 驿站列表：App 传 getStations()，组件不传（拿不到，回落到平台给的驿站名） */
  stations?: any[]
  /** 右侧那块：App 传 <PlaceBlock/>，组件传可点的圈 / 状态图标 */
  trailing?: any
  /** 只包住「图标+文字」这块（组件里要做成 Link，圈要能单独点） */
  leftWrap?: (node: any) => any
  /** 显示右侧驿站/地址列（默认 true；组件默认关，行更宽松） */
  showPlace?: boolean
  /** 固定行高（组件用它保证 4/8 行不溢出） */
  height?: number
}

export function ParcelCardRow({
  item, size = "app", stations, trailing, leftWrap, showPlace = true, height,
}: ParcelCardRowProps) {
  const m = cardModelOf(item, stations)
  const s = METRIC[size]
  const subColor = m.done ? FAINT() : SUB()
  const font = m.showLogistics ? s.codeAlt : s.code

  const left = (
    <HStack spacing={s.gap} alignment="center" frame={{ maxWidth: "infinity", alignment: "leading" }}>
      <CompanyLogo code={m.companyCode} hint={m.companyHint} size={s.logo} />
      <VStack alignment="leading" spacing={s.line} frame={{ maxWidth: "infinity", alignment: "leading" }}>
        <HStack spacing={s.inner} frame={{ maxWidth: "infinity", alignment: "leading" }}>
          <Text font={font} fontWeight="bold" foregroundStyle={m.codeColor} lineLimit={1}
            truncationMode="tail" allowsTightening={size === "app"}
            minScaleFactor={size === "app" ? 0.8 : undefined}>{m.mainCode}</Text>
          {m.extra.length > 0
            ? <Text font={s.extra} fontWeight="semibold" foregroundStyle={subColor} lineLimit={1}
              truncationMode="tail">{m.extra.join(" · ")}</Text>
            : null}
        </HStack>
        <HStack spacing={size === "app" ? 5 : 3} frame={{ maxWidth: "infinity", alignment: "leading" }}>
          <AppBrandMark app={m.srcApp} size={s.mark} />
          <PlatformMark source={m.source} size={s.mark} />
          <Text font={s.sub} foregroundStyle={subColor} lineLimit={1} truncationMode="tail">{m.subTitle}</Text>
        </HStack>
      </VStack>
    </HStack>
  )

  const inner = (
    <HStack spacing={s.gap} alignment="center"
      frame={{ maxWidth: "infinity", height }}>
      {leftWrap ? leftWrap(left) : left}
      {showPlace ? <PlaceBlock m={m} size={size} /> : null}
      {trailing}
    </HStack>
  )

  if (!s.card) return inner
  return (
    <VStack spacing={0} frame={{ maxWidth: "infinity", alignment: "leading" }}
      background={{ style: C.card, shape: RR(20) }}>
      <HStack spacing={0} frame={{ maxWidth: "infinity" }} padding={{ horizontal: 13, vertical: 10 }}>
        {inner}
      </HStack>
    </VStack>
  )
}
