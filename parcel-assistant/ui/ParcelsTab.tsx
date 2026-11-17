// 包裹页 —— 原「所有取件码」搬入 tab：搜索 + 全部/待取/已取筛选 + 列表；右上/悬浮 + 新增包裹。
import { Button, Capsule, HStack, Picker, ScrollView, Text, TextField, VStack, ZStack, useState } from "scripting"
import { C, CAPSULE, alpha } from "../theme"
import { FloatingActions, Icon, BigTitle, Screen } from "./kit"
import { PickupRow } from "./PickupRow"
import { deletePickup, getPickups, setPickupStatus, type Pickup } from "../store"
import { companyName } from "../theme"
import { isAwaitingPickup, isTransitPkg, sourceOf, stationHaystack, cardTitleOf } from "../utils/model"
import { brandOf } from "../utils/appBrand"

export function ParcelsTab({ revision, onAdd, onEdit, onExit, onChanged }: {
  revision: number
  onAdd: () => void
  onEdit: (p: Pickup) => void
  onExit: () => void
  onChanged: () => void
}) {
  void revision
  // 筛选记忆：跨启动保存在 Storage
  type Filter = "all" | "transit" | "pending" | "done"
  const savedFilter = (Storage.get<string>("cc.parcelsFilter") as Filter) || "all"
  const [filter, setFilter] = useState<Filter>(savedFilter)
  const applyFilter = (f: Filter) => { setFilter(f); try { Storage.set("cc.parcelsFilter", f) } catch { } }
  const [query, setQuery] = useState("")
  const [searchOpen, setSearchOpen] = useState(false)
  const showSearch = searchOpen || !!query
  const animate = (fn: () => void) => fn()
  const all = getPickups().filter(p => (p.type ?? "delivery") === "delivery")
  // 口径只有一套（utils/model）：待取 = 真到站，在途 = 除待取外的未取件。
  // 以前这里另写了一个文案正则，结果同一包裹在取件页和在途页各算一遍。
  const q = query.trim().toLowerCase()
  const matches = (p: Pickup) => {
    if (!q) return true
    const app = p.srcApp
    const hay = [p.code, ...(p.codes ?? []), p.mailNo, companyName(p.companyName), p.trackCompany,
      p.address, p.courierStationName, stationHaystack(p), p.smsContent, cardTitleOf(p, ""), p.itemTitle,
      p.userTitle, p.notes, p.receiverAddress, p.receiverCity, sourceOf(p),
      app?.name, app?.id, brandOf(app)?.name].filter(Boolean).join(" ")
    return hay.toLowerCase().includes(q)
  }
  const found = all.filter(matches)
  const counts = {
    all: found.length,
    transit: found.filter(p => isTransitPkg(p)).length,
    pending: found.filter(p => isAwaitingPickup(p)).length,
    done: found.filter(p => p.status === 2 || p.pickedByUser).length,
  }
  const list = found.filter(p => {
    if (filter === "transit" && !isTransitPkg(p)) return false
    if (filter === "pending" && !isAwaitingPickup(p)) return false
    if (filter === "done" && p.status !== 2 && !p.pickedByUser) return false
    return true
  }).sort((a, b) => (a.status === 2 ? 1 : 0) - (b.status === 2 ? 1 : 0) || b.createdAt - a.createdAt)

  // 系统原生分段控件（iOS 26 液态玻璃 + 选中块滑动）。
  // 数字会跳的根因：原生分段宽度是按每段文字宽度分配，数字一变就重新量一遍。
  // 解法：每段标签用固定宽度的 HStack 包住（实测宽度定住后 9↔10 两神数据布局完全一致），
  // 这样段宽稳定、仍用原生控件。
  const SEGS: { key: Filter; label: string; count: number }[] = [
    { key: "all", label: "全部", count: counts.all },
    { key: "transit", label: "在途", count: counts.transit },
    { key: "pending", label: "待取", count: counts.pending },
    { key: "done", label: "已取", count: counts.done },
  ]
  const filterBar = (
    // 宽度跟着内容区走（maxWidth: infinity），不再拿屏宽算死：
    //   · 以前写死「屏宽 - 40」，一旦哪一行比内容区宽，卡片会比筛选栏长出一截；
    //   · 现在父容器宽度固定，分段控件不会再因为数字位数变化而横跳。
    <VStack alignment="leading" frame={{ maxWidth: "infinity", alignment: "leading" }} padding={{ top: 10 }}>
      <Picker title="筛选" value={filter as string} onChanged={(v: string) => applyFilter(v as Filter)}
        pickerStyle="segmented">
        {SEGS.map(s => (
          <Text key={s.key} tag={s.key} font={14} monospacedDigit
            contentTransition="numericText"
            animation={{ animation: Animation.snappy({ duration: 0.32 }), value: s.count }}
          >{`${s.label} ${s.count}`}</Text>
        ))}
      </Picker>
    </VStack>
  )

  const searchBar = (
    <HStack spacing={8} frame={{ maxWidth: "infinity" }}
      padding={{ horizontal: 16, vertical: 13 }}
      background={{ style: C.searchField, shape: CAPSULE }}>
      <Icon name="magnifyingglass" size={18} color={C.text} />
      <TextField title="搜索 App、商品、单号或驿站" value={query}
        onChanged={(v: string) => { setQuery(v); if (v) setSearchOpen(true) }} />
      <Button action={() => { setQuery(""); setSearchOpen(false) }}>
        <Icon name="xmark.circle.fill" size={16} color={C.tertiary} />
      </Button>
    </HStack>
  )

  return (
    <Screen margin={20} exitAction={onExit} actions={<FloatingActions items={[{ symbol: "plus", action: onAdd }]} />}>
      <ScrollView navigationTitle="" navigationBarTitleDisplayMode="inline" scrollIndicator="never"
        toolbarVisibility={{ visibility: "hidden", bars: ["navigationBar"] }}
        scrollDismissesKeyboard="interactively"
        onScrollPhaseChange={(_old, phase, context) => {
          // 只在顶部继续下拉、且松手后展开；普通纵向滚动和卡片横滑不拦截。
          if (phase !== "tracking" && phase !== "interacting") {
            const g: any = context.geometry
            const top = Number(g.contentOffset?.y ?? 0) + Number(g.contentInsets?.top ?? 0)
            if (top < -64) setSearchOpen(true)
          }
        }}>
        <VStack alignment="leading" spacing={0} frame={{ maxWidth: "infinity", alignment: "leading" }}
          padding={{ top: 4 }}>
          <BigTitle title="包裹" />
          <Text font={15} foregroundStyle={C.secondary}>{`${counts.pending} 件待取 · ${counts.all} 个包裹`}</Text>
        {showSearch ? <VStack padding={{ top: 12 }}>{searchBar}</VStack> : null}
        {filterBar}
        <VStack spacing={8} frame={{ maxWidth: "infinity", alignment: "leading" }} padding={{ top: 16, bottom: 170 }}>
          {list.length === 0 ? (
            <VStack spacing={10} frame={{ maxWidth: "infinity" }} padding={{ vertical: 60 }}>
              <Icon name="shippingbox" size={44} color={C.tertiary} />
              <Text font={17} foregroundStyle={C.secondary}>{q ? "没有匹配的包裹" : "暂无包裹"}</Text>
              {!q ? <Text font={13} foregroundStyle={C.tertiary} multilineTextAlignment="center">授权电商平台后会自动同步，也可以搜索运单号添加</Text> : null}
              {!q ? <HStack padding={{ top: 8 }}>
                <Button title="搜索添加" buttonStyle="bordered" action={onAdd} />
              </HStack> : null}
            </VStack>
          ) : list.map(p => (
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
        </VStack>
      </ScrollView>
    </Screen>
  )
}
