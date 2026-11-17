// 取件主页 —— 对齐真机：大标题 + 右上「+」/ 待取·累计取件 / 其他驿站卡片 / 所有取件码 / 右下身份码
import { Button, HStack, ScrollView, Spacer, Text, VStack, useState } from "scripting"
import { C, CAPSULE, CLOSED_TINT, GLASS, glassFill, RR } from "../theme"
import { BigTitle, FloatingActions, Icon, Screen, StatCard, type FloatingItem } from "./kit"
import { CompanyLogo, PickupRow, pickupCompanyLabel } from "./PickupRow"
import { BrandMark } from "./identity"
import { PlatformMark, AppBrandMark } from "./platformMark"
import { isAwaitingPickup, sourceOf, stationHaystack, cardTitleOf } from "../utils/model"
import { matchStationIn, deletePickup, pickedPackages, getIdentityCodes, getPickups, getSettings, getStationLayout, getStations, saveSettings, setPickupStatus, setStationLayout, type CourierStation, type IdentityCode, type Pickup, type StationLayout } from "../store"

const hoursAgo = (ts: number) => Math.max(0, Math.floor((Date.now() - ts) / 3600000))
/** 卡片上要显示的取件码：没有或用运单号充数时返回空（由界面显示占位） */
const shownCode = (p: Pickup) => {
  const c = (p.code ?? "").trim()
  const no = (p.mailNo ?? "").replace(/[\s-]/g, "").toLowerCase()
  if (!c) return ""
  if (no && c.replace(/[\s-]/g, "").toLowerCase() === no) return ""
  return c
}
const arrivalText = (ts?: number) => {
  if (!ts) return ""
  const h = hoursAgo(ts)
  if (h < 1) return "刚送到"
  return h > 99 ? `已到站 ${Math.floor(h / 24)} 天` : `已到站 ${h} 小时`
}

/** 用「驿站管理」里配的驿站去匹配取件码（关键词优先，其次名称、地址）；匹配不上落「其他驿站」 */
function stationOf(p: Pickup, stations: CourierStation[]): string {
  // 与入库、卡片同一套文本（含收货地址），否则分组和右上角会对不上
  const hit = matchStationIn(stations, stationHaystack(p))
  return hit ? hit.name : "其他驿站"
}

/** 两列一排，避免一个驿站占满整行 */
function pairRows<T>(arr: T[]): T[][] {
  const rows: T[][] = []
  for (let i = 0; i < arr.length; i += 2) rows.push(arr.slice(i, i + 2))
  return rows
}

export function PickupTab({ revision, onAdd, onEdit, onIdentityCode, onManageIdentity, onAll, onExit, onChanged, onSimpleModeChanged, onStationTap }: {
  revision: number
  onAdd: () => void
  onEdit: (p: Pickup) => void
  onIdentityCode: (id: any) => void
  onManageIdentity: () => void
  onAll: () => void
  onExit: () => void
  onChanged: () => void
  onSimpleModeChanged?: () => void
  onStationTap?: (name: string) => void
}) {
  const [identityMenu, setIdentityMenu] = useState(false)
  const [statMode, setStatMode] = useState<"total" | "month">("total")
  const [stationLayout, setStationLayoutState] = useState<StationLayout>(getStationLayout)
  const toggleStationLayout = () => {
    const next: StationLayout = stationLayout === "grid" ? "list" : "grid"
    setStationLayoutState(next)
    setStationLayout(next)
  }
  const animate = (fn: () => void) => { try { void withAnimation(fn) } catch { fn() } }
  const enabledIdentities = getIdentityCodes().filter(c => c.enabled)
  const identityTap = () => {
    if (identityMenu) { setIdentityMenu(false); return }
    if (enabledIdentities.length === 1) onIdentityCode(enabledIdentities[0].id)
    else if (enabledIdentities.length === 0) onManageIdentity()
    else setIdentityMenu(true)
  }
  const all = getPickups().filter(p => (p.type ?? "delivery") === "delivery")
  // 待取 = 真的能去取的（有取件码/已到站）；配送中、运输中的不进这一页
  const pending = all.filter(p => p.status === 1 && isAwaitingPickup(p))
  const now = new Date()
  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1).getTime()
  // 已取：status 2 或用户点过已取；本月已取看 pickedAt，不是入库时间
  const pickedList = all.filter(p => p.status === 2 || p.pickedByUser)
  const thisMonth = pickedList.filter(p => Number(p.pickedAt ?? p.arrivedAt ?? p.createdAt ?? 0) >= monthStart).length

  // 按驿站分组：先匹配已配置的驿站，剩下的落「其他驿站」
  const stations = getStations()
  const groups = new Map<string, Pickup[]>()
  for (const p of pending) {
    const key = stationOf(p, stations)
    const arr = groups.get(key) ?? []
    arr.push(p)
    groups.set(key, arr)
  }
  const stationGroups = [...groups.entries()].sort((a, b) => (a[0] === "其他驿站" ? 1 : 0) - (b[0] === "其他驿站" ? 1 : 0))
  const simpleMode = getSettings().simpleMode

  // 三条身份码全部关闭时，首页不再显示身份码入口（仍可到设置里重新开启）。
  const identityItem: FloatingItem = {
    symbol: "person.text.rectangle", label: "身份码", action: identityTap, anchorPad: 44,
    popover: {
      isPresented: identityMenu, onChanged: setIdentityMenu,
      arrowEdge: "bottom", presentationCompactAdaptation: "popover",
      content: <IdentityPicker codes={enabledIdentities}
        onPick={(id) => { setIdentityMenu(false); onIdentityCode(id) }} />,
    },
  }
  // 首页不再显示 +：新增包裹走「包裹」页的悬浮按钮。仅保留身份码入口。
  // 悬浮按钮：正常模式只有身份码（新增走包裹 tab）；简洁模式保留 + 新增包裹。
  const actions: FloatingItem[] = simpleMode
    ? [...(enabledIdentities.length > 0 ? [identityItem] : []), { symbol: "plus", action: onAdd }]
    : enabledIdentities.length > 0 ? [identityItem] : []

  return (
    <Screen margin={20} exitAction={onExit} actions={<FloatingActions items={actions} />}>
      <ScrollView navigationTitle="" navigationBarTitleDisplayMode="inline" scrollIndicator="never"
        toolbarVisibility={{ visibility: "hidden", bars: ["navigationBar"] }}>
        <VStack alignment="leading" spacing={0} frame={{ maxWidth: "infinity", alignment: "leading" }}
          padding={{ top: 4, bottom: simpleMode ? 12 : 170 }}>

          <BigTitle title="取件" />

          <HStack spacing={12} frame={{ maxWidth: "infinity" }}>
            <StatCard icon="shippingbox.fill" label="待取" value={String(pending.length)} iconColor={C.orange} />
            <StatCard icon="shippingbox.fill"
              label={statMode === "total" ? "累计取件" : "本月取件"}
              value={String(statMode === "total" ? pickedPackages() : thisMonth)}
              iconColor={C.green} trailingIcon="arrow.left.arrow.right"
              onTap={() => setStatMode(m => (m === "total" ? "month" : "total"))} />
          </HStack>

          {stationGroups.map(([name, items]) => (
            <VStack key={name} spacing={0} frame={{ maxWidth: "infinity", alignment: "leading" }} padding={{ top: 26 }}>
              <HStack spacing={6} frame={{ maxWidth: "infinity" }} padding={{ bottom: 12 }}>
                <Text font={22} fontWeight="bold" foregroundStyle={C.text} lineLimit={1} minScaleFactor={0.7}
                  layoutPriority={1} contentShape="rect"
                  onTapGesture={() => { if (name !== "其他驿站") onStationTap?.(name) }}>{name}</Text>
                <Text font={16} foregroundStyle={C.tertiary} layoutPriority={1}>{`(${items.length})`}</Text>
                <Spacer />
                <VStack frame={{ width: 32, height: 32, alignment: "center" }} contentShape="rect"
                  onTapGesture={() => animate(toggleStationLayout)}>
                  <Icon name={stationLayout === "grid" ? "list.bullet" : "square.grid.2x2"}
                    size={17} color={C.tertiary} />
                </VStack>
              </HStack>
              {stationLayout === "grid" ? pairRows(items).map((pair, i) => (
                <HStack key={i} spacing={10} alignment="top" frame={{ maxWidth: "infinity", alignment: "top" }}
                  padding={{ bottom: 10 }}>
                  {pair.map(p => <StationCard key={p.uuid} item={p} onTap={() => onEdit(p)}
                    onCheck={() => animate(() => { setPickupStatus(p.uuid, 2); onChanged() })} />)}
                  {pair.length === 1 ? <VStack frame={{ maxWidth: "infinity" }} /> : null}
                </HStack>
              )) : items.map(p => (
                <StationLongCard key={p.uuid} item={p} onTap={() => onEdit(p)}
                  onCheck={() => animate(() => { setPickupStatus(p.uuid, 2); onChanged() })} />
              ))}
            </VStack>
          ))}

          {/* 首页不再重复包裹列表：完整列表在「包裹」tab；简洁模式保留预览入口。 */}
          {simpleMode ? (
            <VStack spacing={0} frame={{ maxWidth: "infinity", alignment: "leading" }} padding={{ top: 26 }}>
              <HStack spacing={6} frame={{ maxWidth: "infinity" }} padding={{ bottom: 12 }}
                onTapGesture={onAll} contentShape="rect">
                <Text font={22} fontWeight="bold" foregroundStyle={C.text}>所有包裹</Text>
                <Icon name="chevron.right" size={15} color={C.text} />
                <HStack frame={{ maxWidth: "infinity" }} />
              </HStack>
              {all.slice(0, 6).map(p => (
                <PickupRow key={p.uuid} item={p} onTap={() => onEdit(p)}
                  swipe={[
                    {
                      title: p.status === 1 ? "已取" : "待取",
                      tint: p.status === 1 ? C.accent : C.orange,
                      action: () => animate(() => { setPickupStatus(p.uuid, p.status === 1 ? 2 : 1); onChanged() }),
                    },
                    { title: "删除", destructive: true, action: () => animate(() => { deletePickup(p.uuid); onChanged() }) },
                  ]} />
              ))}
            </VStack>
          ) : null}
          {simpleMode ? (
            <VStack frame={{ maxWidth: "infinity" }} padding={{ top: 20, bottom: 8 }}>
              <VStack frame={{ height: 46 }} padding={{ horizontal: 22 }}
                background={{ style: glassFill(), shape: CAPSULE }} glassEffect={GLASS.floating}
                onTapGesture={() => { saveSettings({ simpleMode: false }); (onSimpleModeChanged ?? onChanged)() }} contentShape="rect">
                <Text font={15} fontWeight="semibold" foregroundStyle={C.text}>退出简洁模式</Text>
              </VStack>
            </VStack>
          ) : null}
        </VStack>
      </ScrollView>
    </Screen>
  )
}

/** 身份码选择气泡：品牌圆标 + 名称 */
export function IdentityPicker({ codes, onPick }: { codes: IdentityCode[]; onPick: (id: any) => void }) {
  return (
    <VStack alignment="leading" spacing={0} padding={6} frame={{ width: 196 }}>
      {codes.map(c => (
        <Button key={c.id} action={() => onPick(c.id)} buttonStyle="plain"
          frame={{ maxWidth: "infinity", alignment: "leading" }} contentShape="rect">
          <HStack spacing={12} padding={{ horizontal: 8, vertical: 9 }}
            frame={{ maxWidth: "infinity", alignment: "leading" }}>
            <BrandMark id={c.id} size={28} />
            <Text font={17} foregroundStyle={C.text}>{c.name}</Text>
          </HStack>
        </Button>
      ))}
    </VStack>
  )
}

/** 驿站卡片：两列紧凑布局，只保留 logo / 状态 / 取件码 / 快递公司 */
function StationCard({ item, onTap, onCheck }: { item: Pickup; onTap: () => void; onCheck: () => void }) {
  const hint = `${item.address} ${item.courierStationName} ${item.smsContent}`
  const label = pickupCompanyLabel(item.companyName, hint)
  const pending = item.status === 1
  // 平台已退款/退货/取消：取件码位置直接显示状态字，右侧徒标改成「已关闭」
  const closed = (item.closed ?? "").trim()
  const codeText = closed || shownCode(item)
  const stateText = closed ? "已关闭" : pending ? "待取" : "已取"
  return (
    <VStack spacing={7} alignment="leading" frame={{ maxWidth: "infinity", alignment: "leading" }}
      padding={{ horizontal: 12, vertical: 11 }}
      background={{ style: C.card, shape: RR(20) }}
      onTapGesture={onTap} contentShape="rect">
      <HStack spacing={6} frame={{ maxWidth: "infinity" }}>
        <CompanyLogo code={item.companyName} hint={hint} size={32} />
        <HStack frame={{ maxWidth: "infinity" }} />
        <HStack spacing={4}>
          <VStack frame={{ width: 7, height: 7 }}
            background={{ style: pending ? C.green : C.tertiary, shape: RR(4) }} />
          <Text font={13} foregroundStyle={pending ? C.text : C.secondary}>{stateText}</Text>
        </HStack>
        <VStack frame={{ width: 26, height: 26, alignment: "center" }} contentShape="rect" onTapGesture={onCheck}>
          <VStack frame={{ width: 18, height: 18, alignment: "center" }}
            background={{ style: C.separator, shape: RR(9) }}>
            <VStack frame={{ width: 14, height: 14 }} background={{ style: C.card, shape: RR(7) }} />
          </VStack>
        </VStack>
      </HStack>
      <Text font={closed ? 17 : codeText ? 20 : 15} fontWeight="bold" lineLimit={1} minScaleFactor={0.65}
        foregroundStyle={closed ? CLOSED_TINT : codeText ? C.text : C.tertiary}>
        {codeText || "暂无取件码"}
      </Text>
      <HStack spacing={6} frame={{ maxWidth: "infinity" }}>
        <AppBrandMark app={item.srcApp} size={12} />
        <PlatformMark source={sourceOf(item)} size={12} />
        <Text font={12} foregroundStyle={C.secondary} lineLimit={1}
          frame={{ maxWidth: "infinity", alignment: "leading" }}>{cardTitleOf(item, label)}</Text>
        {pending ? (
          <Text font={11} lineLimit={1} minScaleFactor={0.7} layoutPriority={1}
            foregroundStyle={hoursAgo(item.createdAt) >= 24 ? C.orange : C.secondary}>
            {arrivalText(item.arrivedAt ?? item.createdAt)}
          </Text>
        ) : null}
      </HStack>
    </VStack>
  )
}

/** 长条驿站卡片：切到列表模式时显示地址与到站天数 */
function StationLongCard({ item, onTap, onCheck }: { item: Pickup; onTap: () => void; onCheck: () => void }) {
  const station = item.courierStationName || item.address || "其他驿站"
  const hint = `${item.address} ${item.courierStationName} ${item.smsContent}`
  const label = pickupCompanyLabel(item.companyName, hint)
  const pending = item.status === 1
  const closed = (item.closed ?? "").trim()
  const codeText = closed || shownCode(item)
  const stateText = closed ? "已关闭" : pending ? "待取" : "已取"
  const subtitle = cardTitleOf(item, label)
  return (
    <VStack spacing={0} frame={{ maxWidth: "infinity", alignment: "leading" }} padding={{ bottom: 10 }}
      onTapGesture={onTap} contentShape="rect">
      <HStack spacing={12} frame={{ maxWidth: "infinity" }} padding={{ horizontal: 12, vertical: 12 }}
        background={{ style: C.card, shape: RR(22) }}>
        <CompanyLogo code={item.companyName} hint={hint} size={48} />
        <VStack spacing={3} alignment="leading" frame={{ maxWidth: "infinity", alignment: "leading" }}>
          <Text font={closed ? 17 : codeText ? 20 : 15} fontWeight="bold" lineLimit={1} minScaleFactor={0.7}
            foregroundStyle={closed ? CLOSED_TINT : codeText ? C.text : C.tertiary}>
            {codeText || "暂无取件码"}
          </Text>
          <HStack spacing={5} frame={{ maxWidth: "infinity", alignment: "leading" }}>
            <AppBrandMark app={item.srcApp} size={12} />
            <PlatformMark source={sourceOf(item)} size={12} />
            <Text font={13} foregroundStyle={C.secondary} lineLimit={1}>{subtitle}</Text>
          </HStack>
          {pending ? (
            <Text font={13} lineLimit={1}
              foregroundStyle={hoursAgo(item.createdAt) >= 24 ? C.orange : C.secondary}>
              {arrivalText(item.arrivedAt ?? item.createdAt)}
            </Text>
          ) : null}
        </VStack>
        <HStack spacing={7}>
          <HStack spacing={4}>
            <VStack frame={{ width: 7, height: 7 }}
              background={{ style: pending ? C.green : C.tertiary, shape: RR(4) }} />
            <Text font={14} foregroundStyle={pending ? C.text : C.secondary}>{stateText}</Text>
          </HStack>
          <VStack frame={{ width: 28, height: 28, alignment: "center" }} contentShape="rect" onTapGesture={onCheck}>
            <VStack frame={{ width: 20, height: 20, alignment: "center" }} background={{ style: C.separator, shape: RR(10) }}>
              <VStack frame={{ width: 16, height: 16 }} background={{ style: C.card, shape: RR(8) }} />
            </VStack>
          </VStack>
        </HStack>
      </HStack>
    </VStack>
  )
}
