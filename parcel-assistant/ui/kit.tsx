// 组件层 —— 尺寸取自真机截图：页面边距 16、卡片圆角 22、图标块 32、TabBar 高 64
// 颜色一律走 C.*（自适应深浅色）；材质叠 iOS 26 液态玻璃（无 tint，本机可渲染）
import {
  Button, Form, HStack, Image, NavigationStack, ScrollView, Section as NativeSection,
  Spacer, Text, Toggle, Toolbar, ToolbarItem, VStack, ZStack, createContext, useContext, type Color,
} from "scripting"
import { C, RR, CAPSULE, alpha, GLASS, glassFill, dyn, glassCard, glassLogo, isDark, schemeOverride } from "../theme"

export const M = 16          // 页面左右边距
export const RADIUS = 22     // 卡片圆角

export function Icon({ name, size = 16, color, box }: { name: string; size?: number; color?: Color; box?: number }) {
  return (
    <VStack frame={{ width: box ?? size, height: box ?? size }}>
      <Image systemName={name} font={size} foregroundStyle={color} />
    </VStack>
  )
}

/** 彩色图标块（统计卡左侧的小方块） */
export function IconTile({ name, size = 32, bg, fg, radius = 10 }: {
  name: string; size?: number; bg: Color; fg: Color; radius?: number
}) {
  return (
    <VStack frame={{ width: size, height: size }} background={{ style: bg, shape: RR(radius) }}>
      <Icon name={name} size={Math.round(size * 0.52)} color={fg} />
    </VStack>
  )
}

/** 头像渲染：相册图片 / 系统卡通表情 / 默认头像（灰色的空头像） */
export type AvatarData = { avatarMode?: string; avatarEmoji?: string; avatarPhoto?: string }

export function AvatarView({ a, size = 46 }: { a: AvatarData; size?: number }) {
  const r = size / 2
  if (a.avatarMode === "photo" && a.avatarPhoto) {
    // Image filePath 在部分环境下静默不渲染（路径带双斜杠/沙盒外），统一用 UIImage 读
    let img: UIImage | null = null
    try { img = FileManager.existsSync(a.avatarPhoto) ? UIImage.fromFile(a.avatarPhoto) : null } catch { img = null }
    if (img) {
      return (
        <Image image={img} resizable antialiased interpolation="high"
          frame={{ width: size, height: size }} clipShape={RR(r)} />
      )
    }
  }
  if (a.avatarMode === "emoji" && a.avatarEmoji) {
    return (
      <VStack frame={{ width: size, height: size }} background={{ style: C.track, shape: RR(r) }}>
        <Text font={Math.round(size * 0.8)}>{a.avatarEmoji}</Text>
      </VStack>
    )
  }
  // 没选头像时就是默认的灰色空头像，不用昵称首字母
  return <IconTile name="person.crop.circle.fill" size={size} radius={r} bg={C.track} fg={C.secondary} />
}

/** 全局圆形按钮（退出 X / 悬浮 +、身份码）：液态玻璃 + 半透底。
 *  这是修复前那一版效果（浅色白圆、深色深玻璃），已验证观感正确，不要再改。 */
export function RoundButton({ size = 42, icon, iconSize = 17, label, onTap, withShadow = false }: {
  size?: number; icon: string; iconSize?: number; label?: string; onTap?: () => void; withShadow?: boolean
}) {
  const dark = isDark()
  const fg = dyn("#1C1C1E" as Color, "#FFFFFF" as Color)
  const sh = withShadow ? { color: "rgba(0,0,0,0.15)" as Color, radius: 12, x: 0, y: 4 } : undefined
  return (
    <VStack frame={{ width: size, height: size }}
      background={{ style: glassFill(), shape: "circle" }}
      glassEffect={size > 48 ? GLASS.floating : GLASS.topButton}
      shadow={sh as any}
      onTapGesture={onTap} contentShape="rect">
      <VStack spacing={label ? 1 : 0}>
        <Image systemName={icon} font={iconSize} fontWeight="semibold" foregroundStyle={fg} />
        {label ? <Text font={9} fontWeight="medium" foregroundStyle={fg}>{label}</Text> : null}
      </VStack>
    </VStack>
  )
}

/** 大标题（左上）+ 右上圆形按钮：overlay 固定坐标，保证四页按钮完全同一位置 */
export function BigTitle({ title, symbol = "xmark", action, button = true }: {
  title: string; symbol?: string; action?: () => void; button?: boolean
}) {
  return (
    <HStack frame={{ maxWidth: "infinity", alignment: "leading" }} padding={{ top: 8, bottom: 16 }}>
      <Text font={34} fontWeight="bold" foregroundStyle={C.text}>{title}</Text>
      <Spacer />
      {button && action ? (
        <RoundButton icon={symbol ?? "xmark"} onTap={action} />
      ) : null}
    </HStack>
  )
}

/** 通用卡片 */
export function Card({ children, radius = RADIUS, pad = 16, spacing = 10, bg, onTap, glass = true }: {
  children: any; radius?: number; pad?: any; spacing?: number; bg?: any; onTap?: () => void; glass?: boolean
}) {
  return (
    <VStack spacing={0} alignment="leading" frame={{ maxWidth: "infinity", alignment: "leading" }}
      background={bg ?? { style: C.card, shape: RR(radius) }}
      onTapGesture={onTap} contentShape="rect">
      <VStack spacing={spacing} alignment="leading" frame={{ maxWidth: "infinity", alignment: "leading" }}
        padding={pad} glassEffect={glass ? glassCard(radius) : undefined}>
        {children}
      </VStack>
    </VStack>
  )
}

/** 取件/提醒页的统计条卡：上行「图标 标签」，下行大数字 */
export function StatCard({ icon, label, value, iconColor, trailing, trailingIcon, onTap }: {
  icon: string; label: string; value: string; iconColor: Color
  trailing?: string; trailingIcon?: string; onTap?: () => void
}) {
  return (
    <VStack spacing={0} frame={{ maxWidth: "infinity", height: 78, alignment: "leading" }}
      background={{ style: C.card, shape: RR(RADIUS) }}
      onTapGesture={onTap} contentShape="rect">
      <VStack spacing={8} alignment="leading" frame={{ maxWidth: "infinity", maxHeight: "infinity", alignment: "leading" }}
        padding={{ horizontal: 16, vertical: 12 }} glassEffect={glassCard(RADIUS)}>
        <HStack spacing={7}>
          <Icon name={icon} size={15} color={iconColor} />
          <Text font={14} foregroundStyle={C.secondary}>{label}</Text>
          {trailingIcon ? <Icon name={trailingIcon} size={13} color={C.secondary} /> : null}
          {!trailingIcon && trailing ? <Text font={14} foregroundStyle={C.secondary}>{trailing}</Text> : null}
        </HStack>
        <Text font={28} fontWeight="bold" foregroundStyle={C.text} contentTransition="numericText"
          animation={{ animation: Animation.snappy({ duration: 0.32 }), value }}>
          {value}
        </Text>
      </VStack>
    </VStack>
  )
}

/** 统计页的小卡：左图标块 + 右「数字 标签」 */
export function MiniStat({ icon, tileBg, iconColor, value, label, height }: {
  icon: string; tileBg: Color; iconColor: Color; value: string; label: string; height?: number
}) {
  return (
    <VStack spacing={0} frame={{ maxWidth: "infinity", height, alignment: "leading" }}
      background={{ style: C.card, shape: RR(RADIUS) }}>
      <HStack spacing={12} frame={{ maxWidth: "infinity", maxHeight: "infinity", alignment: "leading" }}
        padding={{ horizontal: 14, vertical: 12 }} glassEffect={glassCard(RADIUS)}>
        <IconTile name={icon} bg={tileBg} fg={iconColor} />
        <VStack alignment="leading" spacing={1} frame={{ maxWidth: "infinity", alignment: "leading" }}>
          <Text font={28} fontWeight="bold" foregroundStyle={C.text}>{value}</Text>
          <Text font={13} foregroundStyle={C.secondary} lineLimit={1}>{label}</Text>
        </VStack>
      </HStack>
    </VStack>
  )
}



/** 页面容器：底色 + 顶部渐变 + 边距内容区；actions = 右下浮钮；exitAction = 右上固定坐标退出按钮 */
export function Screen({ children, gradient, actions, overlay, bottomPad = 20, margin = M, exitAction, exitTrailing, exitTop }: {
  children: any; gradient?: any; actions?: any; overlay?: any; bottomPad?: number; margin?: number; exitAction?: () => void
  exitTrailing?: number; exitTop?: number
}) {
  return (
    <ZStack alignment="top" frame={{ maxWidth: "infinity", maxHeight: "infinity" }}>
      <VStack frame={{ maxWidth: "infinity", maxHeight: "infinity" }} background={C.bg} ignoresSafeArea />
      {gradient ? (
        <VStack frame={{ maxWidth: "infinity", height: 760 }} background={gradient} ignoresSafeArea={{ edges: "top" }} />
      ) : null}
      <VStack alignment="leading" spacing={0}
        frame={{ maxWidth: "infinity", maxHeight: "infinity", alignment: "topLeading" }}
        padding={{ horizontal: margin }}>
        {children}
      </VStack>
      {exitAction ? (
        <VStack frame={{ maxWidth: "infinity", maxHeight: "infinity", alignment: "topTrailing" }}
          padding={{ trailing: exitTrailing ?? margin, top: exitTop ?? 4 }}>
          <RoundButton icon="xmark" onTap={exitAction} />
        </VStack>
      ) : null}
      {actions ? (
        <VStack frame={{ maxWidth: "infinity", maxHeight: "infinity", alignment: "bottomTrailing" }}
          padding={{ trailing: margin, bottom: bottomPad }}>
          {actions}
        </VStack>
      ) : null}
      {overlay || null}
    </ZStack>
  )
}


/** 右下浮钮组 */
export type FloatingItem = { symbol: string; label?: string; action: () => void; popover?: any; anchorPad?: number }
export function FloatingActions({ items }: { items: FloatingItem[] }) {
  return (
    <VStack spacing={10} alignment="trailing">
      {items.map((it, i) => (
        <HStack key={i} spacing={0} popover={it.popover}>
          {it.anchorPad ? <VStack frame={{ width: it.anchorPad, height: 58 }} /> : null}
          <RoundButton size={58} icon={it.symbol} iconSize={it.label ? 19 : 22}
              label={it.label} onTap={it.action} withShadow />
        </HStack>
      ))}
    </VStack>
  )
}


// ============ 二级页统一版式 ============

/** 已经被父级 NavigationStack 推入时不再套一层导航栈 */
const InStack = createContext<boolean>()
export function StackScope({ children }: { children: any }) {
  return <InStack.Provider value={true}>{children}</InStack.Provider>
}

/** 二级页容器：原生 NavigationStack + Form，标题/关闭/保存全走系统 */
export function SubPage({ title, onClose, children, footer, save, trailing, large, standalone, closeLabel }: {
  title: string
  onClose: () => void
  children: any
  footer?: any
  save?: { title?: string; disabled?: boolean; action: () => void }
  trailing?: any
  large?: boolean
  /** 在 sheet/fullScreenCover 里用时强制自带导航栈（否则会继承父级上下文而没有导航栏） */
  standalone?: boolean
  /** 左上角按钮文案，默认「取消」（从列表页进来的子页用「返回」更顺） */
  closeLabel?: string
}) {
  let inStack = false
  try { inStack = useContext(InStack) === true } catch {}
  if (standalone) inStack = false
  const bar = (
    <Toolbar>
      {inStack ? null : (
        <ToolbarItem placement="cancellationAction">
          <Button title={closeLabel ?? "取消"} action={onClose} />
        </ToolbarItem>
      )}
      {save ? (
        <ToolbarItem placement="confirmationAction">
          <Button title={save.title ?? "保存"} disabled={save.disabled} action={save.action} />
        </ToolbarItem>
      ) : trailing ? (
        <ToolbarItem placement="confirmationAction">{trailing}</ToolbarItem>
      ) : null}
    </Toolbar>
  )
  const form = (
    <Form
      navigationTitle={title}
      navigationBarTitleDisplayMode={large ? "large" : "inline"}
      scrollIndicator="never"
      listSectionSpacing={8}
      preferredColorScheme={schemeOverride()}
      toolbar={bar}>
      {children}
      {footer ? <Section footer={footer} /> : null}
    </Form>
  )
  const wrapped = (
    <NavigationStack preferredColorScheme={schemeOverride()}>{form}</NavigationStack>
  )
  return inStack ? form : wrapped
}

/** 二级页容器：原生导航栏 + 可下拉搜索的 ScrollView（用于自定义卡片列表） */
export function SubPageScroll({ title, onClose, children, searchable, large }: {
  title: string
  onClose: () => void
  children: any
  searchable?: any
  large?: boolean
}) {
  let inStack = false
  try { inStack = useContext(InStack) === true } catch {}
  const page = (
    <ZStack
      frame={{ maxWidth: "infinity", maxHeight: "infinity" }}
      toolbarBackgroundVisibility={{ visibility: "hidden", bars: ["navigationBar"] }}
      preferredColorScheme={schemeOverride()}>
      {/* 底色单独铺一层并延伸进安全区，导航栏透明后与内容连成一片 */}
      <VStack frame={{ maxWidth: "infinity", maxHeight: "infinity" }} background={C.bg} ignoresSafeArea />
      <ScrollView
        navigationTitle={title}
        navigationBarTitleDisplayMode={large ? "large" : "inline"}
        scrollIndicator="never"
        searchable={searchable}
        toolbar={inStack ? undefined : (
          <Toolbar>
            <ToolbarItem placement="cancellationAction">
              <Button title="取消" action={onClose} />
            </ToolbarItem>
          </Toolbar>
        )}>
        {children}
      </ScrollView>
    </ZStack>
  )
  return inStack ? page : <NavigationStack preferredColorScheme={schemeOverride()}>{page}</NavigationStack>
}

/** 分组卡（白底圆角），行之间的分隔线自动画 */
export function Section({ children, title, footer }: { children?: any; title?: string; footer?: string }) {
  return (
    <NativeSection
      header={title ? <Text font={13} foregroundStyle={C.secondary}>{title}</Text> : undefined}
      footer={footer ? <Text font={12} foregroundStyle={C.tertiary}>{footer}</Text> : undefined}>
      {children}
    </NativeSection>
  )
}

/** Section 头：左标题 + 右侧小操作（如「收起」），比卡片底部按钮更难被键盘挡住、更好点 */
export function SectionHeader({ title, action, onAction }: {
  title: string; action?: string; onAction?: () => void
}) {
  return (
    <HStack frame={{ maxWidth: "infinity" }}>
      <Text font={13} foregroundStyle={C.secondary}>{title}</Text>
      <HStack frame={{ maxWidth: "infinity" }} />
      {action ? (
        <Button action={() => onAction?.()} buttonStyle="plain" controlSize="small">
          <Text font={13} foregroundStyle={C.accent}>{action}</Text>
        </Button>
      ) : null}
    </HStack>
  )
}

/** 标准行：图标块 + 标题 + 右侧值 + chevron */
export function Row({ icon, image, iconBg, iconColor, title, value, detail, tint, onTap, chevron = true }: {
  icon?: string; image?: UIImage; iconBg?: Color; iconColor?: Color; title: string; value?: string; detail?: string
  tint?: Color; onTap?: () => void; chevron?: boolean
}) {
  const content = (
    <HStack spacing={12} frame={{ maxWidth: "infinity", alignment: "leading" }} padding={{ vertical: 7 }}>
      {image ? (
        <Image image={image} resizable antialiased frame={{ width: 33, height: 33 }} clipShape={RR(10)} />
      ) : icon ? <IconTile name={icon} size={33} radius={10} bg={iconBg ?? C.track} fg={iconColor ?? C.text} /> : null}
      <VStack alignment="leading" spacing={2} frame={{ maxWidth: "infinity", alignment: "leading" }}>
        <Text font={17} foregroundStyle={tint ?? C.text}>{title}</Text>
        {detail ? <Text font={13} foregroundStyle={C.secondary}>{detail}</Text> : null}
      </VStack>
      {value ? <Text font={15} foregroundStyle={C.secondary}>{value}</Text> : null}
      {chevron ? <Icon name="chevron.right" size={13} color={C.tertiary} /> : null}
    </HStack>
  )
  if (!onTap) return content
  // Form 的 Section 行里 onTapGesture 只覆盖有内容的区域（点空白无效），
  // 包一层 Button 才是整行热区——这是项目里列表行通用的写法。
  return (
    <Button action={onTap} buttonStyle="plain" frame={{ maxWidth: "infinity", alignment: "leading" }} contentShape="rect">
      {content}
    </Button>
  )
}

/** 表单行：图标 + 字段 */
export function Field({ icon, children }: { icon: string; children: any }) {
  return (
    <HStack spacing={10} frame={{ maxWidth: "infinity" }} padding={{ vertical: 4 }}>
      <Icon name={icon} size={15} color={C.tertiary} />
      <VStack frame={{ maxWidth: "infinity", alignment: "leading" }}>{children}</VStack>
    </HStack>
  )
}




// ============ 内嵌小表单（详情页里的绑定/验证：两三个字段 + 一对按钮） ============

/** 组内一行：左侧标签（正文色）+ 输入 + 右侧附属控件，排法同丰巢登录页 */
export function InputLine({ label, width = 66, divider, children }: {
  label: string; width?: number; divider?: boolean; children: any
}) {
  return (
    <VStack spacing={0} frame={{ maxWidth: "infinity" }}>
      <HStack spacing={10} frame={{ maxWidth: "infinity" }} padding={{ vertical: 4 }}>
        <Text font={16} foregroundStyle={C.text} frame={{ width, alignment: "leading" }}>{label}</Text>
        {children}
      </HStack>
      {divider ? (
        <HStack frame={{ maxWidth: "infinity", height: 1 }}>
          <VStack frame={{ width: 76, height: 1 }} />
          <VStack frame={{ maxWidth: "infinity", height: 1 }} background={C.separator} />
        </HStack>
      ) : null}
    </VStack>
  )
}

/** 表单底部按钮对：左次要（浅底）/ 右主要（accent 实心），各占一半 */
export function FormActions({ cancel = "取消", confirm, disabled, busy, onCancel, onConfirm }: {
  cancel?: string; confirm: string; disabled?: boolean; busy?: boolean
  onCancel: () => void; onConfirm: () => void
}) {
  // Form 行内子视图不会自动拉伸到行宽，这里按屏宽算出可用宽度再平分
  const w = Math.max(160, Device.screen.width - 64)
  const half = (w - 10) / 2
  return (
    <HStack spacing={10} frame={{ width: w }}>
      <FormButton title={cancel} width={half} onTap={onCancel} />
      <FormButton title={confirm} width={half} primary disabled={disabled || busy} onTap={onConfirm} />
    </HStack>
  )
}

function FormButton({ title, width, primary, disabled, onTap }: {
  title: string; width: number; primary?: boolean; disabled?: boolean; onTap: () => void
}) {
  const bg = primary && !disabled
    ? { style: alpha("#6B5BD2", 1), shape: RR(14) }
    : { style: alpha("#808080", 0.18), shape: RR(14) }
  const fg = primary && !disabled ? "rgba(255,255,255,1)" : (primary ? C.tertiary : C.text)
  // 用原生 Button 包内容：Form 行里纯 onTapGesture 有时接不到点击（键盘弹出时尤其）
  return (
    <Button action={onTap} buttonStyle="plain" disabled={disabled}>
      <VStack frame={{ width, height: 44 }} background={bg as any}>
        <Text font={16} fontWeight="semibold" foregroundStyle={fg}>{title}</Text>
      </VStack>
    </Button>
  )
}
