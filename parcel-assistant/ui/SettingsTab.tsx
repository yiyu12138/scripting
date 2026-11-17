// 设置页 —— 自定义卡片，尺寸/间距/图标对齐真机；页面底色由 Screen 铺满。
import { Button, Divider, HStack, ScrollView, Text, VStack, useState } from "scripting"
import { C, CAPSULE, RR } from "../theme"
import { BigTitle, Icon, IconTile, AvatarView, Screen } from "./kit"
import { getSettings } from "../store"
import { PLATFORMS, hasAuth } from "../platforms"
import { readFullSyncAt } from "../utils/platformSync"
import { cacheInfo, clearCache, sizeText } from "../utils/cache"
import { notify } from "./notify"

function hmText(t: number): string {
  const d = new Date(t)
  const p = (n: number) => String(n).padStart(2, "0")
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
}

const PURPLE = "#7B61FF" as any
const ORANGE = "#F0A03C" as any
const BLUE = "#2F7BF6" as any
const CYAN = "#35C7E8" as any
const RED = "#F0554F" as any
const GREEN = "#34A853" as any
const MAGENTA = "#C135E0" as any
const GRAY = "#8E8E93" as any
const GAP = 26

export function SettingsTab({ revision, onOpen, onExit }: {
  revision: number; onOpen: (p: string) => void; onExit: () => void
}) {
  const s = getSettings()
  // 头部昵称/第二条跟账户页保持一致：昵称只认本机设置，第二条是授权 + 上次同步
  const nickname = s.nickName?.trim() || "包裹助手"
  const authCount = PLATFORMS.filter(p => hasAuth(p.id)).length
  const lastSync = readFullSyncAt()
  const sub = `${authCount > 0 ? `${authCount} 个平台已授权` : "尚未授权平台"} · ${lastSync > 0 ? `上次同步 ${hmText(lastSync)}` : "尚未同步"}`
  // 缓存体积在渲染时算一次；清完用 tick 强制重算
  const [, setCacheTick] = useState(0)
  const cache = cacheInfo()
  const doClearCache = async () => {
    const parts: string[] = []
    if (cache.packages > 0) parts.push(`${cache.packages} 个已取超过 30 天的包裹`)
    if (cache.intents > 0) parts.push(`${cache.intents} 条旧识别记录`)
    if (cache.files > 0) parts.push("诊断日志与图标副本")
    const ok = await Dialog.confirm({
      title: "清除缓存",
      message: parts.length
        ? `将清理 ${parts.join("、")}，约 ${sizeText(cache.bytes)}。统计里的累计数会按剩下包裹重算；在途、待取的包裹、设置与授权不受影响。`
        : "现在没有可清理的内容。",
      confirmLabel: "清理",
      cancelLabel: "取消",
    }).catch(() => false)
    if (!ok) return
    const freed = clearCache()
    setCacheTick(n => n + 1)
    const done: string[] = []
    if (freed.packages > 0) done.push(`${freed.packages} 个历史包裹`)
    if (freed.intents > 0) done.push(`${freed.intents} 条识别记录`)
    if (freed.files > 0) done.push("日志与图标副本")
    notify(done.length ? `已清理 ${done.join("、")}，约 ${sizeText(freed.bytes)}` : "没有可清理的内容")
  }

  return (
    <Screen margin={20} exitAction={onExit}>
      <ScrollView navigationTitle="" navigationBarTitleDisplayMode="inline" scrollIndicator="never"
        toolbarVisibility={{ visibility: "hidden", bars: ["navigationBar"] }}>
        <VStack alignment="leading" spacing={0} frame={{ maxWidth: "infinity", alignment: "leading" }}
          padding={{ top: 4, bottom: 40 }}>

          <BigTitle title="设置" />

          <Card>
            <VStack frame={{ maxWidth: "infinity", alignment: "leading" }} background={{ style: C.card, shape: RR(0) }}
              onTapGesture={() => onOpen("profile")} contentShape="rect">
              <HStack spacing={12} padding={{ horizontal: 16, vertical: 14 }} frame={{ maxWidth: "infinity", alignment: "leading" }}>
                <AvatarView a={s} size={56} />
                <VStack alignment="leading" spacing={2} frame={{ maxWidth: "infinity", alignment: "leading" }}>
                  <Text font={17} fontWeight="medium" foregroundStyle={C.text}>{nickname}</Text>
                  <Text font={12} foregroundStyle={C.secondary}>{sub}</Text>
                </VStack>
                <Icon name="chevron.right" size={13} color={C.tertiary} />
              </HStack>
            </VStack>
          </Card>

          <Card top={GAP}>
            <NavRow icon="checkmark.shield.fill" color={ORANGE} title="账号授权" onTap={() => onOpen("authorize")} />
          </Card>

          <Card top={GAP}>
            <NavRow icon="bolt.fill" color={ORANGE} title="快捷指令与自动化" onTap={() => onOpen("shortcuts")} />
            <Sep />
            <NavRow icon="building.2.fill" color={CYAN} title="驿站管理" onTap={() => onOpen("station")} />
            <Sep />
            <NavRow icon="qrcode" color={BLUE} title="身份码" onTap={() => onOpen("identity")} />
            <Sep />
            <NavRow icon="bell.fill" color={BLUE} title="取件提醒" onTap={() => onOpen("reminderHub")} />
          </Card>

          <Card top={GAP}>
            <NavRow icon="circle.lefthalf.filled" color={MAGENTA} title="外观与显示" onTap={() => onOpen("appearance")} />
            <Sep />
            <NavRow icon="widget.small" color={CYAN} title="小组件" onTap={() => onOpen("widget")} />
            <Sep />
            <NavRow icon="rectangle.portrait" color={BLUE} title="实时活动（灵动岛）" onTap={() => onOpen("live")}
              child={<LiveIslandGlyph />} />
            <Sep />
            <NavRow icon="arrow.triangle.2.circlepath" color={RED} title="刷新频率" onTap={() => onOpen("refreshRate")} />
          </Card>

          <Card top={GAP}>
            <NavRow icon="questionmark.circle.fill" color={BLUE} title="常见问题" onTap={() => onOpen("faq")} />
            <Sep />
            <NavRow icon="trash.fill" color={GRAY} title="清除缓存"
              value={cache.bytes > 0 ? sizeText(cache.bytes) : "已清空"} onTap={() => void doClearCache()} />
          </Card>

          <VStack spacing={4} frame={{ maxWidth: "infinity" }} padding={{ top: 28 }}>
            <Text font={12} foregroundStyle={C.tertiary}>包裹助手 · 版本 1.2.0</Text>
          </VStack>
        </VStack>
      </ScrollView>
    </Screen>
  )
}

function Card({ children, top = 0 }: { children: any; top?: number }) {
  return (
    <VStack frame={{ maxWidth: "infinity", alignment: "leading" }} padding={{ top }}>
      <VStack spacing={0} frame={{ maxWidth: "infinity", alignment: "leading" }}
        background={{ style: C.card, shape: RR(22) }} clipShape={RR(22)}>
        {children}
      </VStack>
    </VStack>
  )
}

function Sep() {
  return (
    <VStack spacing={0} frame={{ maxWidth: "infinity" }} padding={{ leading: 58 }}>
      <Divider />
    </VStack>
  )
}

function NavRow({ icon, color, title, value, onTap, child }: {
  icon: string; color: any; title: string; value?: string; onTap: () => void; child?: any
}) {
  return (
    <VStack frame={{ maxWidth: "infinity", alignment: "leading" }} background={{ style: C.card, shape: RR(0) }}
      onTapGesture={onTap} contentShape="rect">
      <HStack spacing={12} frame={{ maxWidth: "infinity", height: 48, alignment: "leading" }} padding={{ horizontal: 16 }}>
        {child ? (
          <VStack frame={{ width: 30, height: 30 }} background={{ style: color, shape: RR(9) }}>{child}</VStack>
        ) : (
          <IconTile name={icon} bg={color} fg={C.white} size={30} radius={9} />
        )}
        <Text font={15} foregroundStyle={C.text} frame={{ maxWidth: "infinity", alignment: "leading" }}>{title}</Text>
        {value ? <Text font={14} foregroundStyle={C.secondary}>{value}</Text> : null}
        <Icon name="chevron.right" size={12} color={C.tertiary} />
      </HStack>
    </VStack>
  )
}

function LiveIslandGlyph() {
  return <Icon name="iphone.gen3" size={17} color={C.white} />
}
