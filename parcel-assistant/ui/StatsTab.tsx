// 统计页 —— 对齐真机截图：左侧(累计快件/周均取件/最常取件青柠卡) + 右侧(夜空本月卡/累计取餐/累计观影)
import { HStack, ScrollView, Spacer, Text, VStack, ZStack, useState } from "scripting"
import { C, GRAD, RR, alpha, glassCard, isDark, companyName } from "../theme"
import { BigTitle, Icon, IconTile, MiniStat, Screen, RADIUS, M } from "./kit"
import { getPickups, getStats, importedPackages, pickedPackages } from "../store"
import { CompanyLogo } from "./PickupRow"
import { isAwaitingPickup } from "../utils/model"

const pad2 = (n: number) => String(n).padStart(2, "0")

export function StatsTab({ revision, scheme, onExit, onAll }: { revision: number; scheme?: "dark" | "light"; onExit: () => void; onAll: () => void }) {
  const dark = scheme ? scheme === "dark" : isDark()
  const all = getPickups()
  const list = all.filter(p => (p.type ?? "delivery") === "delivery")
  const pickedCount = pickedPackages()
  const pickedList = list.filter(p => p.status === 2 || p.pickedByUser)
  // 与取件页、灵动岛同一口径：只有真到站的才算待取，在途不算
  const pendingCount = String(list.filter(p => isAwaitingPickup(p)).length)
  const thisMonth = list.filter(p => {
    const d = new Date(p.pickedAt ?? p.arrivedAt ?? p.createdAt), n = new Date()
    return d.getFullYear() === n.getFullYear() && d.getMonth() === n.getMonth()
  }).length
  const s = getStats()

  // 月均取件：总数 / 有记录的月份数（真实口径，不再叫「周均」）
  const monthKeys = new Set(pickedList.map(p => {
    const d = new Date(p.pickedAt ?? p.arrivedAt ?? p.createdAt)
    return `${d.getFullYear()}-${d.getMonth()}`
  }))
  const weekly = (pickedList.length / Math.max(1, monthKeys.size)).toFixed(1)

  // 按月分桶（区分年份），按时间倒序：本月在最左，往右越来越早
  const nowD = new Date()
  const ymOf = (d: Date) => d.getFullYear() * 12 + d.getMonth()
  const bucket = new Map<number, { ym: number; label: string; count: number }>()
  for (const p of pickedList) {
    const d = new Date(p.pickedAt ?? p.arrivedAt ?? p.createdAt)
    const ym = ymOf(d)
    const cur = bucket.get(ym) ?? { ym, label: `${d.getMonth() + 1}月`, count: 0 }
    cur.count += 1
    bucket.set(ym, cur)
  }
  // 本月即使 0 件也保留一列，避免「刚取件却看不到本月」
  const thisYm = ymOf(nowD)
  if (!bucket.has(thisYm)) bucket.set(thisYm, { ym: thisYm, label: `${nowD.getMonth() + 1}月`, count: 0 })
  const monthsAll = [...bucket.values()].sort((a, b) => b.ym - a.ym)
  const maxCount = monthsAll.reduce((a, m) => Math.max(a, m.count), 0)
  // 峰值月：取件最多；并列取较近的月份
  const peakYm = [...monthsAll].sort((a, b) => b.count - a.count || b.ym - a.ym)[0].ym
  const barHeight = (n: number) => (n === 0 ? 8 : Math.max(18, Math.round(80 * n / Math.max(1, maxCount))))
  // 柱子宽 34 + 间距 6；不足一屏(140)时靠右对齐，超出时靠左滚动
  const barAlign = monthsAll.length * 40 <= 140 ? "bottomTrailing" : "bottomLeading"

  // 各公司平均短信到达时间（用 codeTime 的小时数近似）
  const hourBy = new Map<number, { sum: number; n: number }>()
  for (const p of list) {
    const m = (p.codeTime || "").match(/(\d{1,2}):(\d{2})/)
    if (!m) continue
    const cur = hourBy.get(p.companyName) ?? { sum: 0, n: 0 }
    cur.sum += Number(m[1]); cur.n += 1
    hourBy.set(p.companyName, cur)
  }
  const smsRows = [...hourBy.entries()]
    .map(([code, v]) => ({ code, name: companyName(code), hour: Math.round(v.sum / v.n) }))
    .sort((a, b) => a.hour - b.hour)
    .slice(0, 3)

  const top3 = s.byCompany.slice(0, 3)

  return (
    <Screen margin={20} exitAction={onExit}>
      <ScrollView navigationTitle="" navigationBarTitleDisplayMode="inline" scrollIndicator="never"
        toolbarVisibility={{ visibility: "hidden", bars: ["navigationBar"] }}>
        <VStack alignment="leading" spacing={0} frame={{ maxWidth: "infinity", alignment: "leading" }}
          padding={{ top: 4, bottom: 40 }}>

          <BigTitle title="统计" />

          {/* 拼图区 */}
          <HStack spacing={16} alignment="top" frame={{ maxWidth: "infinity" }}>
            {/* 左列 */}
            <VStack spacing={12} frame={{ maxWidth: "infinity" }}>
              <MiniStat icon="shippingbox.fill" tileBg={C.tileBox} iconColor={C.iconBox}
                value={String(importedPackages())} label="累计快件" height={84} />
              <MiniStat icon="calendar" tileBg={C.tileCal} iconColor={C.iconCal}
                value={weekly} label="月均取件" height={84} />
              <LimeRankCard rows={top3} height={177} onTap={onAll} dark={dark} />
            </VStack>
            {/* 右列 */}
            <VStack spacing={12} frame={{ maxWidth: "infinity" }}>
              <NightCard value={String(thisMonth)} height={177} dark={dark} />
              <MiniStat icon="checkmark.circle.fill" tileBg={C.tileCal} iconColor={C.iconCal}
                value={String(pickedCount)} label="累计已取" height={84} />
              <MiniStat icon="clock.arrow.circlepath" tileBg={C.tileFilm} iconColor={C.iconFilm}
                value={pendingCount} label="当前待取" height={84} />
            </VStack>
          </HStack>

          {/* 取件趋势 */}
          <VStack spacing={0} frame={{ maxWidth: "infinity", alignment: "leading" }} padding={{ top: 10 }}>
            <Card2>
              {/* 高度固定：右侧柱子区域占满整张卡片，左侧标题在上、文案在下 */}
              <HStack spacing={12} frame={{ maxWidth: "infinity", height: 120, alignment: "bottom" }}>
                <VStack alignment="leading" spacing={0} frame={{ maxWidth: "infinity", maxHeight: "infinity", alignment: "topLeading" }}>
                  <HStack spacing={8}>
                    <IconTile name="shippingbox" size={30} bg={C.tileBox} fg={C.iconBox} radius={9} />
                    <Text font={16} foregroundStyle={C.secondary}>取件趋势</Text>
                  </HStack>
                  <Spacer />
                  <VStack alignment="leading" spacing={2} frame={{ maxWidth: "infinity", alignment: "leading" }}>
                    <Text font={22} fontWeight="bold" foregroundStyle={C.text} lineLimit={1}>
                      {`${monthsAll.find(m => m.ym === peakYm)!.label}，我的取件`}
                    </Text>
                    <Text font={22} fontWeight="bold" foregroundStyle={C.text} lineLimit={1}>
                      {`数量达到顶峰，`}
                    </Text>
                    <HStack spacing={2}>
                      <Text font={22} fontWeight="bold" foregroundStyle={C.text}>{"高达 "}</Text>
                      <Text font={22} fontWeight="bold" foregroundStyle={C.orange}>{`${monthsAll.find(m => m.ym === peakYm)!.count}件`}</Text>
                      <Text font={22} fontWeight="bold" foregroundStyle={C.orange}>{" ✨"}</Text>
                    </HStack>
                  </VStack>
                </VStack>
                {/* 右侧：横向滚动，默认露出 3 根 + 第 4 根一半 */}
                <ScrollView axes="horizontal" frame={{ width: 140, height: 120 }}>
                  <HStack spacing={6} alignment="bottom" frame={{ minWidth: 140, minHeight: 120, alignment: barAlign as any }}>
                    {monthsAll.map(m => (
                      <VStack key={m.ym} spacing={5} alignment="center">
                        <Text font={13} fontWeight="semibold"
                          foregroundStyle={m.count === 0 ? C.tertiary : C.text}>{`${m.count}件`}</Text>
                        <VStack frame={{ width: 34, height: barHeight(m.count) }}
                          background={{ style: m.count === 0 ? C.barTrack : C.orange, shape: RR(10) }}
                          opacity={m.ym === peakYm || m.count === 0 ? 1 : 0.45}
                          shadow={m.ym === peakYm ? { color: alpha("#E8A050", 0.45), radius: 10, x: 0, y: 0 } : undefined} />
                        <Text font={11} fontWeight={m.ym === peakYm ? "semibold" : "regular"}
                          foregroundStyle={m.ym === peakYm ? C.text : C.tertiary}>{m.label}</Text>
                      </VStack>
                    ))}
                  </HStack>
                </ScrollView>
              </HStack>
            </Card2>
          </VStack>

          {/* 平均到站时间（原来叫「平均入库时间」，不是电商仓的入库，是快递到站） */}
          <VStack spacing={0} frame={{ maxWidth: "infinity", alignment: "leading" }} padding={{ top: 10 }}>
            <Card2>
              <HStack spacing={8}>
                <IconTile name="clock" size={30} bg={C.tileFilm} fg={C.iconFilm} radius={9} />
                <Text font={16} foregroundStyle={C.secondary}>平均到站时间</Text>
              </HStack>
              {smsRows.length === 0 ? (
                <Text font={14} foregroundStyle={C.tertiary}>暂无记录</Text>
              ) : smsRows.map(r => (
                <SmsRow key={r.code} code={r.code} name={r.name} hour={r.hour} />
              ))}
              <HStack spacing={0} frame={{ maxWidth: "infinity" }} padding={{ leading: 56, top: 4 }}>
                <Text font={14} foregroundStyle={C.tertiary}>08:00</Text>
                <Spacer />
                <Text font={14} foregroundStyle={C.tertiary}>15:00</Text>
                <Spacer />
                <Text font={14} foregroundStyle={C.tertiary}>22:00</Text>
              </HStack>
            </Card2>
          </VStack>
        </VStack>
      </ScrollView>
    </Screen>
  )
}

/** 通栏白卡 */
export function Card2({ children }: { children: any }) {
  return (
    <VStack spacing={0} frame={{ maxWidth: "infinity", alignment: "leading" }}
      background={{ style: C.card, shape: RR(RADIUS) }}>
      <VStack spacing={14} alignment="leading" frame={{ maxWidth: "infinity", alignment: "leading" }}
        padding={{ horizontal: 16, vertical: 16 }} glassEffect={glassCard(RADIUS)}>
        {children}
      </VStack>
    </VStack>
  )
}

/** 本月取件卡：深色=夜空(月亮+星星)，浅色=白昼(太阳+云朵)；点爪印彩蛋切换动物 */
const PAW_ANIMALS: [string, string][] = [
  ["cat.fill", "猫咪"],
  ["dog.fill", "狗狗"],
  ["hare.fill", "兔子"],
  ["bird.fill", "小鸟"],
  ["fish.fill", "小鱼"],
  ["tortoise.fill", "乌龟"],
  ["ladybug.fill", "瓢虫"],
  ["ant.fill", "蚂蚁"],
]
let pawAnimalIndex = 0 // 模块级记忆，切 tab 不重置

/** 本地渐变：颜色写死按 dark 分支，不依赖调色板（避免切配色后渐变停在旧值） */
function grad2(c1: string, c2: string): any {
  return {
    colors: [c1 as any, c2 as any],
    startPoint: { x: 0.5, y: 0 },
    endPoint: { x: 0.5, y: 1 },
  }
}

function NightCard({ value, height, dark }: { value: string; height: number; dark: boolean }) {
  const [animal, setAnimal] = useState(pawAnimalIndex)
  const nextAnimal = () => {
    pawAnimalIndex = (pawAnimalIndex + 1) % PAW_ANIMALS.length
    setAnimal(pawAnimalIndex)
  }
  return (
    <VStack spacing={0} frame={{ maxWidth: "infinity", height }}
      background={dark ? grad2("#3E3570", "#27624A") : grad2("#5B8DEF", "#57B66D")} clipShape={RR(RADIUS)}>
      <ZStack alignment="topLeading" frame={{ maxWidth: "infinity", maxHeight: "infinity" }}>
        <VStack alignment="leading" spacing={0} frame={{ maxWidth: "infinity", maxHeight: "infinity", alignment: "topLeading" }}
          padding={{ horizontal: 14, vertical: 14 }}>
          {dark ? (
            <Icon name="moon.fill" size={30} color={"#FFD84D" as any} />
          ) : (
            <Icon name="sun.max.fill" size={30} color={"#FFB03A" as any} />
          )}
          {dark ? (
            <HStack spacing={16} frame={{ maxWidth: "infinity" }} padding={{ top: 26 }}>
              <Icon name="sparkle" size={6} color={alpha("#FFFFFF", 0.75)} />
              <Icon name="sparkle" size={4} color={alpha("#FFFFFF", 0.6)} />
              <Icon name="sparkle" size={5} color={alpha("#FFFFFF", 0.7)} />
            </HStack>
          ) : (
            <HStack spacing={16} frame={{ maxWidth: "infinity" }} padding={{ top: 26 }}>
              <Icon name="cloud.fill" size={16} color={alpha("#FFFFFF", 0.85)} />
              <Icon name="cloud.fill" size={11} color={alpha("#FFFFFF", 0.65)} />
            </HStack>
          )}
          <VStack alignment="leading" spacing={0} frame={{ maxWidth: "infinity", alignment: "leading" }}>
            <Text font={34} fontWeight="bold" foregroundStyle={C.white}>{value}</Text>
            <Text font={14} foregroundStyle={alpha("#FFFFFF", 0.95)}>本月取件</Text>
          </VStack>
        </VStack>
        {/* 彩蛋：点击右下角切换动物（轻微弹跳动画） */}
        <VStack frame={{ maxWidth: "infinity", maxHeight: "infinity", alignment: "bottomTrailing" }} padding={{ trailing: 6, bottom: 0 }}>
          <VStack frame={{ width: 86, height: 80 }} onTapGesture={nextAnimal} contentShape="rect">
            <Icon key={animal} name={PAW_ANIMALS[animal][0]} size={68}
              color={alpha("#FFFFFF", 0.92)}
              animation={{ animation: Animation.spring({ response: 0.3, dampingFraction: 0.5 }), value: animal }} />
          </VStack>
        </VStack>
      </ZStack>
    </VStack>
  )
}

/** 最常取件：青柠底 + 排名行 */
function LimeRankCard({ rows, height, onTap, dark }: { rows: { name: string; count: number }[]; height: number; onTap?: () => void; dark: boolean }) {
  const main = (dark ? "#E8F5C8" : "#2C3A12") as any
  const sub = (dark ? "#A9BA86" : "#5C6B3A") as any
  return (
    <VStack spacing={0} frame={{ maxWidth: "infinity", height }}
      background={dark ? grad2("#333F1B", "#283314") : grad2("#E4FFB4", "#D6F79A")} clipShape={RR(RADIUS)}
      onTapGesture={onTap} contentShape="rect">
      <VStack spacing={10} alignment="leading" frame={{ maxWidth: "infinity", maxHeight: "infinity", alignment: "topLeading" }}
        padding={{ horizontal: 14, vertical: 14 }}>
        <HStack spacing={6} frame={{ maxWidth: "infinity" }}>
          <Icon name="person.3.fill" size={13} color={main} />
          <Text font={14} fontWeight="semibold" foregroundStyle={main}>最常取件</Text>
          <Spacer />
          <Icon name="chevron.right" size={13} color={main} />
        </HStack>
        {rows.length === 0 ? (
          <Text font={13} foregroundStyle={sub}>暂无记录</Text>
        ) : rows.map((r, i) => (
          <HStack key={r.name} spacing={8} frame={{ maxWidth: "infinity" }}>
            <Text font={13} fontWeight="bold" foregroundStyle={sub}>{i + 1}</Text>
            <Text font={14} fontWeight="medium" foregroundStyle={main} lineLimit={1}
              frame={{ maxWidth: "infinity", alignment: "leading" }}>{r.name}</Text>
            <Text font={13} foregroundStyle={sub}>{`×${r.count}`}</Text>
          </HStack>
        ))}
      </VStack>
    </VStack>
  )
}

/** 短信时间行：40pt 品牌 logo + 17pt 名称 + 20pt 彩色时间 + 连续滑轨 */
export function SmsRow({ code, name, hour }: { code: number; name: string; hour: number }) {
  const tint = code === 1 ? C.orange : C.blue
  const pct = Math.min(1, Math.max(0, (hour - 8) / 14))
  // 轨道宽度必须等于卡片内实际可用宽：屏宽 - 页面边距(20×2) - 卡片内边距(16×2) - logo(44) - 间隔(12)。
  // 曾写成 screen.width-120，多出 8pt 把整页 ZStack 撑宽，导致退出按钮比其他页右移 4pt。
  const trackW = Math.max(120, Device.screen.width - 128)
  const knob = 16
  const dotX = trackW * pct - knob / 2
  const glow = code === 1 ? "#E8A050" : "#2F7BF6"
  return (
    <HStack spacing={12} alignment="top" frame={{ maxWidth: "infinity" }} padding={{ top: 6, bottom: 2 }}>
      <CompanyLogo code={code} hint={name} size={44} />
      <VStack spacing={4} frame={{ width: trackW, alignment: "leading" }}>
        <HStack spacing={8} frame={{ maxWidth: "infinity" }}>
          <Text font={20} fontWeight="semibold" foregroundStyle={C.text}
            frame={{ maxWidth: "infinity", alignment: "leading" }}>{name}</Text>
          <Text font={20} fontWeight="bold" foregroundStyle={tint}>{`${pad2(hour)}:00`}</Text>
        </HStack>
        <ZStack alignment="leading" frame={{ width: trackW, height: 18 }}>
          <VStack frame={{ width: trackW, height: 4 }} background={{ style: C.track, shape: RR(2) }} />
          <VStack frame={{ width: Math.max(0, trackW * pct), height: 4 }} background={{ style: tint, shape: RR(2) }} />
          <ZStack frame={{ width: knob, height: knob }} background={{ style: tint, shape: RR(8) }}
            offset={{ x: dotX, y: 0 }}
            shadow={{ color: alpha(glow, 0.6), radius: 8, x: 0, y: 0 }}>
            <VStack frame={{ width: 6, height: 6 }} background={{ style: C.white, shape: RR(3) }} />
          </ZStack>
        </ZStack>
      </VStack>
    </HStack>
  )
}
