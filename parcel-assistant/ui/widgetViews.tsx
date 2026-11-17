// 设置页的小组件预览：只吃 widgetData.buildWidgetVM() 的数据，
// 版式统一走 ui/widgetLayout.tsx，和桌面组件是同一份代码，不再各画一套。
import { VStack } from "scripting"
import { C } from "../theme"
import type { WidgetPack, WidgetVM } from "../widgetData"
import { WidgetBody as SharedBody } from "./widgetLayout"

export type WidgetFamilyKey = "small" | "medium" | "large"

/** 把预览模型转成卡片要的 Pickup 形状（与桌面组件传给 ParcelCardRow 的字段一致） */
function toItem(p: WidgetPack): any {
  return {
    uuid: p.uuid,
    code: p.code,
    companyName: p.companyName,
    trackCompany: p.company,
    courierStationName: p.station,
    itemTitle: p.itemTitle,
    trackLatest: p.latest,
    trackUpdatedAt: p.updatedAt,
    mailNo: p.mailNo,
    eta: p.eta,
    codes: p.codes,
    source: p.source,
    status: 1,
  }
}

export function WidgetBody({ vm, size }: { vm: WidgetVM; size: WidgetFamilyKey }) {
  const pending = vm.pending.map(toItem)
  const transit = vm.transit.map(toItem)
  return (
    <VStack alignment="leading" spacing={0}
      frame={{ maxWidth: "infinity", maxHeight: "infinity", alignment: "topLeading" }}
      widgetBackground={C.card as any}>
      <SharedBody
        pending={pending}
        transit={transit}
        lastSync={vm.lastSync}
        avatarEmoji={vm.avatar.mode === "emoji" ? (vm.avatar.emoji ?? "") : ""}
        avatarFile={vm.avatar.mode === "photo" ? (vm.avatar.photo ?? "") : ""}
        size={size as any}
        interactive={false}
        pendingTotal={vm.pendingTotal}
        transitTotal={vm.transitTotal}
      />
    </VStack>
  )
}
