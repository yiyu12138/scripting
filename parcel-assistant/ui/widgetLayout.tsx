/**
 * 小组件版式（唯一实现）：桌面组件和设置页预览都渲染这一份。
 * 这里不读存储、不联网，只吃数据；尺寸/头像/行数规则都在这里。
 */
import { Button, HStack, Image, Link, Script, Spacer, Text, VStack } from "scripting"
import { ParcelCardRow, StatusIcon, cardModelOf, type CardSize } from "./parcelCard"
import { WidgetMarkPickedIntent } from "../app_intents"

declare const UIImage: any

export const TXT_C: any = { light: "#111111", dark: "#FFFFFF" }
export const SUB_C: any = { light: "rgba(0,0,0,0.55)", dark: "rgba(255,255,255,0.62)" }
export const FAINT: any = { light: "rgba(0,0,0,0.38)", dark: "rgba(255,255,255,0.45)" }

/** 默认头像：灰色圆底人形（与 App 内一致），没有自定义头像时也画出来 */
export function WidgetAvatar({ emoji, photoFile, size }: { emoji: string; photoFile: string; size: number }) {
  if (photoFile) {
    try {
      if (FileManager.existsSync(photoFile)) {
        const img = UIImage.fromFile(photoFile)
        if (img) {
          return <Image image={img} resizable antialiased interpolation="high"
            frame={{ width: size, height: size }}
            clipShape={{ type: "rect", cornerRadius: size / 2 } as any} />
        }
      }
    } catch { }
  }
  if (emoji) {
    return (
      <VStack frame={{ width: size, height: size }} background="rgba(120,120,128,0.12)"
        clipShape={{ type: "rect", cornerRadius: size / 2 } as any}>
        <Text font={Math.round(size * 0.72)}>{emoji}</Text>
      </VStack>
    )
  }
  return (
    <VStack frame={{ width: size, height: size }}
      background="rgba(120,120,128,0.16)" clipShape={{ type: "rect", cornerRadius: size / 2 } as any}>
      <Image systemName="person.crop.circle.fill" font={Math.round(size * 0.92)}
        foregroundStyle="rgba(120,120,128,0.75)" />
    </VStack>
  )
}

function WidgetRow({ p, size, awaiting, interactive }: { p: any; size: CardSize; awaiting: boolean; interactive: boolean }) {
  const height = size === "large" ? 30 : size === "medium" ? 29 : 27
  const body = (
    <ParcelCardRow
      item={p}
      size={size}
      height={height}
      showPlace={false}
      trailing={!interactive
        ? (awaiting
          ? <Image systemName="circle" font={size === "large" ? 19 : 17}
            foregroundStyle="rgba(120,120,128,0.55)" frame={{ width: 27, height: 27 }} />
          : <StatusIcon m={cardModelOf(p)} size={size} />)
        : (awaiting
          ? <Button intent={WidgetMarkPickedIntent({ uuid: p.uuid })} buttonStyle="plain">
            <Image systemName="circle" font={size === "large" ? 19 : 17}
              foregroundStyle="rgba(120,120,128,0.55)" frame={{ width: 27, height: 27 }} />
          </Button>
          : <StatusIcon m={cardModelOf(p)} size={size} />)}
    />
  )
  if (!interactive) return body
  return <Link url={Script.createRunURLScheme(Script.name, { uuid: p.uuid })}>{body}</Link>
}

function Empty({ size }: { size: CardSize }) {
  return (
    <VStack spacing={5} frame={{ maxWidth: "infinity", maxHeight: "infinity" }}>
      <Image systemName="shippingbox" font={size === "small" ? 20 : 24} foregroundStyle="rgba(120,120,128,0.6)" />
      <Text font={11} foregroundStyle={SUB_C} widgetAccentable>暂无包裹</Text>
    </VStack>
  )
}

export function syncLabel(ts: number): string {
  if (!ts) return "尚未同步"
  const d = new Date(ts)
  const now = new Date()
  const t = `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`
  const sameDay = d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth() && d.getDate() === now.getDate()
  return sameDay ? `${t} 同步` : `${d.getMonth() + 1}月${d.getDate()}日 ${t} 同步`
}

export function WidgetBody({ pending, transit, lastSync, avatarEmoji, avatarFile, size, interactive = true, pendingTotal, transitTotal }: {
  pending: any[]
  transit: any[]
  lastSync: number
  avatarEmoji: string
  avatarFile: string
  size: CardSize
  /** 预览里关掉点击/按钮，避免误触 */
  interactive?: boolean
  /** 列表被截断时用真实总数（预览用） */
  pendingTotal?: number
  transitTotal?: number
}) {
  const big = size === "large"
  const mid = size === "medium"
  const pad = size === "small" ? 10 : size === "medium" ? 13 : 14
  const pTotal = pendingTotal ?? pending.length
  const tTotal = transitTotal ?? transit.length
  // 大号能放下更多行；中号 4 行；小号 4 行。到站单全部优先，在途补空位。
  const slots = size === "large" ? 10 : 4
  const transitSlots = transit.length > 0 && pending.length < slots
    ? Math.min(transit.length, slots - pending.length)
    : 0
  const pendingSlots = Math.max(1, Math.min(slots - transitSlots, Math.max(pending.length, 1)))
  const rows: Array<{ p: any; awaiting: boolean }> = pending.slice(0, pendingSlots).map(p => ({ p, awaiting: true }))
  if (transit.length > 0) rows.push(...transit.slice(0, slots - rows.length).map(p => ({ p, awaiting: false })))
  const more = Math.max(0, pTotal - rows.filter(r => r.awaiting).length)

  return (
    <VStack alignment="leading" spacing={0} padding={pad}
      widgetURL={interactive ? Script.createRunURLScheme(Script.name) : undefined}
      frame={{ maxWidth: "infinity", maxHeight: "infinity", alignment: "topLeading" }}>
      {mid
        ? <VStack spacing={0} frame={{ maxWidth: "infinity", maxHeight: "infinity" }}>
          <HStack spacing={6} frame={{ maxWidth: "infinity" }}>
            <VStack alignment="center" spacing={8} frame={{ width: 58, maxHeight: "infinity", alignment: "top" }} padding={{ top: 2 }}>
              {/* 头像居中靠上，再放大一号；数字单独放下面放大 */}
              <WidgetAvatar emoji={avatarEmoji} photoFile={avatarFile} size={36} />
              <Text font={12} fontWeight="semibold" foregroundStyle={TXT_C}>待取件</Text>
              <Text font={34} fontWeight="bold" foregroundStyle={TXT_C} lineLimit={1}>{pTotal}</Text>
              {tTotal > 0
                ? <Text font={9} foregroundStyle="#2D7BFF" lineLimit={1}>在途 {tTotal}</Text>
                : null}
            </VStack>
            <VStack alignment="leading" spacing={3} frame={{ maxWidth: "infinity", maxHeight: "infinity", alignment: "top" }}>
              {rows.length === 0 ? <Empty size={size} /> : rows.map(r => (
                <WidgetRow key={r.p.uuid} p={r.p} size={size} awaiting={r.awaiting} interactive={interactive} />
              ))}
            </VStack>
          </HStack>
          <Spacer minLength={0} />
          <HStack spacing={6} frame={{ maxWidth: "infinity" }}>
            <Image systemName="arrow.triangle.2.circlepath" font={9} foregroundStyle={FAINT} />
            <Text font={9} foregroundStyle={FAINT} lineLimit={1}>{syncLabel(lastSync)}</Text>
            <Spacer />
            {more > 0 ? <Text font={9} foregroundStyle={FAINT}>还有 {more} 件</Text> : null}
          </HStack>
        </VStack>
        : <>
          <HStack spacing={5} frame={{ maxWidth: "infinity" }}>
            <Text font={size === "small" ? 12 : 15} fontWeight="semibold" foregroundStyle={TXT_C}>待取</Text>
            <Text font={13} fontWeight="bold" foregroundStyle={TXT_C}>{pTotal}</Text>
            <Text font={9} foregroundStyle={SUB_C}>件</Text>
            {tTotal > 0
              ? <Text font={9} foregroundStyle="#2D7BFF" lineLimit={1}>· 在途 {tTotal}</Text>
              : null}
            <Spacer />
            <WidgetAvatar emoji={avatarEmoji} photoFile={avatarFile} size={size === "small" ? 24 : 30} />
          </HStack>
          {big
            ? <HStack spacing={0} padding={{ top: 4, bottom: 3 }} frame={{ maxWidth: "infinity" }}>
              <VStack frame={{ maxWidth: "infinity", height: 1 }} background={{ style: "rgba(120,120,128,0.22)", shape: { type: "rect", cornerRadius: 0.5 } }} />
            </HStack>
            : null}
          <VStack alignment="leading" spacing={big ? 2 : 1}
            padding={{ top: size === "small" ? 2 : 0 }}
            frame={{ maxWidth: "infinity", maxHeight: "infinity", alignment: "top" }}>
            {rows.length === 0 ? <Empty size={size} /> : rows.map(r => (
              <WidgetRow key={r.p.uuid} p={r.p} size={size} awaiting={r.awaiting} interactive={interactive} />
            ))}
          </VStack>
          <Spacer minLength={0} />
          <HStack spacing={6} frame={{ maxWidth: "infinity" }}>
            <Image systemName="arrow.triangle.2.circlepath" font={9} foregroundStyle={FAINT} />
            <Text font={9} foregroundStyle={FAINT} lineLimit={1}>{syncLabel(lastSync)}</Text>
            <Spacer />
            {more > 0
              ? <Text font={9} foregroundStyle={FAINT} lineLimit={1}>还有 {more} 件</Text>
              : null}
          </HStack>
        </>}
    </VStack>
  )
}
