// 全局轻提示：胶囊气泡从屏幕顶部短暂出现，3 秒自动消失。
// 文案由 ui/notify.ts 的 notify() 发出，这里只管画。
// 颜色随明暗模式切换；点击穿透，不影响下层界面。
import { HStack, Image, Text, VStack, useEffect, useState } from "scripting"
import { CAPSULE, alpha, dyn } from "../theme"
import { onToast, type ToastItem, type ToastLevel } from "./notify"

const ICON: Record<ToastLevel, string> = {
  info: "info.circle.fill",
  warn: "exclamationmark.triangle.fill",
  error: "xmark.octagon.fill",
}

/** 挂在根视图/sheet 最上层，全局只需要一个 */
export function ToastHost() {
  const [item, setItem] = useState<ToastItem | null>(null)
  useEffect(() => onToast(setItem), [])

  // 深色：深底浅字；浅色：白底深字。用动态颜色（dyn）而不是渲染时算一次，
  // 这样系统切换深浅色时气泡会自己跟着变。
  const colored = item?.level === "warn" || item?.level === "error"
  const bg: any = item?.level === "error"
    ? "#C7362F"
    : item?.level === "warn"
      ? "#B25000"
      : dyn(alpha("#FFFFFF", 0.97), alpha("#2C2C2E", 0.92))
  // 关键：只有彩色底（warn/error）才用白字；普通提示必须跟底色走，否则浅色下就是白底白字
  const fg: any = colored ? "#FFFFFF" : dyn("#1C1C1E", "#FFFFFF")
  const iconFg = fg

  if (!item) return null
  return (
    <VStack frame={{ maxWidth: "infinity", maxHeight: "infinity", alignment: "top" }}
      padding={{ horizontal: 24, top: 60 }}
      allowsHitTesting={false}>
      <HStack key={item.id} spacing={7}
        padding={{ horizontal: 14, vertical: 9 }}
        background={{ style: bg as any, shape: CAPSULE }}
        shadow={{ color: alpha("#000000", 0.22), radius: 12, y: 4 }}>
        <Image systemName={ICON[item.level]} font={13} foregroundStyle={iconFg as any} />
        <Text font={13} fontWeight="medium" foregroundStyle={fg as any} lineLimit={2}>{item.text}</Text>
      </HStack>
    </VStack>
  )
}
