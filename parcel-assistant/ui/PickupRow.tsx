// 取件码卡片 —— 渲染已经不在这里了：唯一实现在 ui/parcelCard.tsx，
// 手机列表 / 设置页预览 / 桌面小组件共用同一份，改一次三处同时生效。
// 这里只保留 App 专属的部分：点击进详情、左滑操作。
import { Button, VStack, useState } from "scripting"
import { getStations, type Pickup } from "../store"
import { ParcelCardRow } from "./parcelCard"

export { CompanyLogo, pickupCompanyLabel } from "./parcelCard"

export type SwipeAction = { title: string; tint?: any; destructive?: boolean; action: () => void }

export function PickupRow({ item, onTap, swipe }: { item: Pickup; onTap?: () => void; swipe?: SwipeAction[] }) {
  // ScrollView 里的 trailingSwipeActions 点了按钮不会自动收起，
  // 改 key 重建这一行可把滑动状态复位（List 里系统会自动收，这里需要手动）。
  const [swipeGen, setSwipeGen] = useState(0)
  const runSwipe = (s: SwipeAction) => {
    s.action()
    // 等动作带来的数据刷新落地后再重建，避免同一次渲染里被合并掉
    setTimeout(() => setSwipeGen(g => g + 1), 20)
  }
  return (
    <VStack spacing={0} frame={{ maxWidth: "infinity", alignment: "leading" }} padding={{ bottom: 8 }}>
      <VStack key={swipeGen} spacing={0} frame={{ maxWidth: "infinity", alignment: "leading" }}
        onTapGesture={onTap} contentShape="rect"
        trailingSwipeActions={swipe ? {
          allowsFullSwipe: false,
          actions: swipe.map((s, i) => (
            <Button key={i} title={s.title} tint={s.tint} role={s.destructive ? "destructive" : undefined}
              frame={{ maxWidth: 86, maxHeight: "infinity" }} action={() => runSwipe(s)} />
          )),
        } : undefined}>
        <ParcelCardRow item={item} size="app" stations={getStations()} />
      </VStack>
    </VStack>
  )
}
