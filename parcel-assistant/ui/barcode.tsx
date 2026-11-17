// 条形码视图：Code128-B 编码，白底黑条，两侧留静区。
// 驿站高拍仪扫的就是它，所以固定黑白、不做主题色；二维码只作为备选展示。
import { HStack, VStack } from "scripting"
import { barRuns, code128B } from "../utils/code128"

export function Barcode({ value, width = 300, height = 76 }: { value: string; width?: number; height?: number }) {
  let runs: { black: boolean; width: number }[] = []
  try {
    runs = barRuns(code128B(value))
  } catch {
    return null
  }
  if (runs.length === 0) return null
  const total = runs.reduce((s, r) => s + r.width, 0)
  const unit = width / total
  return (
    <HStack spacing={0} frame={{ width, height }} background="#FFFFFF">
      {runs.map((r, i) => (
        <VStack key={`${i}-${r.width}`} frame={{ width: r.width * unit, height }} background={r.black ? "#000000" : "#FFFFFF"} />
      ))}
    </HStack>
  )
}
