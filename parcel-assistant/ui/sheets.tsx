// 二级页面：原生 Form/List。设置类页面 push（保留 Tab 与返回），新增类用 sheet。
import {
  Button, Capsule, DatePicker, DragGesture, GeometryReader, MagnifyGesture, HStack, Image, LabeledContent, List, Navigation, NavigationLink, NavigationStack, Picker,
  Slider, Spacer, Stepper, Text, TextField, Toggle, Toolbar, ToolbarItem, VStack, ScrollView, ZStack, useEffect, useState,
} from "scripting"
import { Notification, LiveActivity, Widget, RoundedRectangle, Script } from "scripting"
import { C, CAPSULE, RR, alpha, companyName, schemeOverride } from "../theme"
import { Field, Icon, IconTile, Row, Section, SubPage, SubPageScroll, AvatarView } from "./kit"
import { CompanyLogo, PickupRow } from "./PickupRow"
import { IdentityCodeSheet, IdentityEntrySettings } from "./identity"
import { QrLoginPage } from "./qrLogin"
import { PddMobileSection, loadPddMobiles } from "./pddMobiles"
import { TrackDetailPage, TrackSearchSheet } from "./trackSearch"
import { KdniaoLoginPage } from "./kdLogin"
import { clearCredential, clearToken, loadCredential, loadUser, refreshUser } from "../kdniao"
import { authorize, clearAuth, hasAuth, markPlatform, needsReauth, platformEnabled, PLATFORMS, syncPlatformParcels, type PlatformId } from "../platforms"
import { readFullSyncAt, platformLastSyncedAt, platformLastError, miPhones } from "../utils/platformSync"
import { notify } from "./notify"
import { FengchaoLoginPage } from "./fengchaoLogin"
import { MiLoginPage } from "./miLogin"
import { resolveMiLoginUrl } from "./miLoginHelper"
import { miHasLogin, miMintToken, miReadUser, miSaveSession } from "../utils/mi"
import { PlatformDetailPage } from "./platformDetail"
import { ToastHost } from "./toast"
import { assetImage } from "./assets"
import { brandOf } from "../utils/appBrand"
import { WidgetBody, type WidgetFamilyKey } from "./widgetViews"
import { buildWidgetVM, widgetSeenAt } from "../widgetData"
import { reschedulePickupReminders } from "../utils/reminders"
import { resetLiveExpiry } from "./live"
import { consumeIntentInbox, loadIntentInbox, markIntentApplied, pushIntentItem, removeIntentItem, undoIntentLink } from "../utils/intentInbox"
import { mergeCodes } from "../utils/codes"
import { parseDeliveryText, summarizeParsed } from "../utils/smsParse"
import { isAwaitingPickup, isTransitPkg } from "../utils/model"
import { locationMode, locationModeText, syncLocationReminders, type LocMode } from "../utils/geo"
import {
  addBind, addLocation, addStation, cleanStations, deleteLocation, deletePickup, deleteStation, getBinds,
  getLocations, getPickups, getSettings, getStations, removeBind, saveSettings,
  setPickupStatus, updateLocation, updateStation, updatePickup,
  type BindUser, type CourierStation, type Pickup,
} from "../store"

type Closer = () => void
type Opener = (kind: string, props?: any) => void

function InfoPage({ title, rows, close }: { title: string; rows: [string, string, string][]; close: Closer }) {
  return (
    <SubPage title={title} onClose={close}>
      <Section>
        {rows.map(([icon, t, d]) => (
          <Row key={t} icon={icon} title={t} detail={d} chevron={false} />
        ))}
      </Section>
    </SubPage>
  )
}

/** 常见问题：按主题分组，每条形如「问题 + 一两句实话」。 */
export function FaqPage({ close }: { close: Closer }) {
  const groups: { title: string; items: [string, string][] }[] = [
    {
      title: "取件码",
      items: [
        ["取件码是从哪来的？", "三处：平台授权同步（淘宝、菜鸟、京东、拼多多、丰巢、小米快递），各走自己的订单与物流接口；短信或截图识别，本机 OCR 加规则解析；搜索运单号查询，先走菜鸟，没结果才用快递鸟兜底。"],
        ["为什么有的包裹没有取件码？", "部分快递由驿站或代收点代签，平台只回运单号不返码。到站后可以在包裹列表右上角点 ＋ 、用运单号再查一次，或者直接到驿站报手机尾号取。"],
        ["「在途」和「暂无取件码」有什么区别？", "在途 = 还没到站；暂无取件码 = 已经到站，但这单没有可用的取件码。"],
        ["一个包裹有好几个取件码？", "卡片主码右边会把另一个一并列出，取件时不会丢信息。"],
        ["包裹多了怎么找？", "在包裹页顶部向下拉一下出搜索框，可搜商品名、运单号、取件码、驿站和来源 App；搜索结果还能用下面的筛选栏再筛。"],
      ],
    },
    {
      title: "同步与授权",
      items: [
        ["某个平台同步失败怎么办？", "打开「设置 → 账号授权 → 该平台」，失败原因写在那一页：未登录、需要在页面里验证、请求过多被限制、未绑定取件手机号，和别处看到的是同一句话。"],
        ["为什么淘宝、京东、拼多多要在 App 里才能同步？", "它们靠内嵌网页拿订单与物流，必须有界面。桌面组件也会按「全量轮转」逐个平台查新订单，但每次唤醒只能跑一小段（预算 3 秒、一次最多两个平台）；App 打开时会一次翻完，更快。"],
        ["多久同步一次？", "间隔在「设置 → 刷新频率」里改：前台刷新、组件刷新、全量发现新订单、失败冷却四项。手动下拉随时可以拉。"],
        ["已签收或已退款的包裹为什么不见了？", "已签收超过 7 天的不再导入；退款、取消、退货是终态，卡片上会直接写「已退款」。"],
        ["淘宝和菜鸟要分别授权吗？", "共用一次淘宝登录：解除其中一个，那一项就显示未授权、不再读它的数据；两个都解除才清掉登录，下次要重新登。"],
      ],
    },
    {
      title: "提醒",
      items: [
        ["没收到到站提醒？", "依次检查：Scripting 的通知权限、「取件提醒」里的免打扰时段、这个包裹是否已经提醒过一次。到站时间取的是物流轨迹里的节点时间，不是下单时间。"],
        ["会重复提醒吗？", "不会。同一个包裹的到站提醒只弹一次；删掉包裹会连同它的排期与到站记录一起清掉。"],
      ],
    },
    {
      title: "小组件与灵动岛",
      items: [
        ["桌面小组件显示什么？", "待取件数量和最近到站的取件码。点一下直接打开包裹助手。"],
        ["在小组件里点「已取」算数吗？", "算。下次打开 App 会自动同步回来，不需要再点一次。"],
        ["灵动岛和实时活动怎么用？", "只统计待取件。点锁屏卡片或展开的实时活动，会直接打开包裹助手。"],
      ],
    },
    {
      title: "快捷指令",
      items: [
        ["怎么把截图交给包裹助手？", "三种：控制中心点一下（会自动收起控制中心再截屏）、在别的 App 里把图片分享给这个快捷指令、短信自动化。"],
        ["会打扰我吗？", "成功不打扰：只写进「识别记录」，下次打开 App 自动落库。只有识别失败、或取件码对不上需要你选包裹时才发通知。"],
        ["卡片上的平台名和图标是哪来的？", "快捷指令会带上「当前 App」的标识：认得出就显示那个平台的图标和名字，认不出就退回快递公司名。搜索运单号添加的包裹没有平台，只显示快递公司名。"],
      ],
    },
    {
      title: "数据与隐私",
      items: [
        ["数据存在哪？会传出去吗？", "只存在本机（App Group），不上传任何服务器。联网只做三件事：查物流时把运单号发给菜鸟、各平台自己的接口或快递鸟；手动查单需要自动判断快递公司时问一下快递100；同步平台订单时用你自己的授权。"],
        ["清除缓存会删掉包裹吗？", "会删已取超过 30 天的历史包裹（连同轨迹与提醒），统计里的累计数重置为剩下包裹的数量，本机留着的身份码缓存也会清掉。在途、待取、设置和授权都不动。"],
        ["卸载 Scripting 或删掉脚本会怎样？", "本机数据会跟着一起没有，无法恢复。重要包裹请提前截图留底。"],
      ],
    },
  ]
  return (
    <SubPage title="常见问题" onClose={close}>
      {groups.map(g => (
        <Section key={g.title} title={g.title}>
          {g.items.map(([q, a]) => (
            <VStack key={q} alignment="leading" spacing={5}
              padding={{ horizontal: 16, vertical: 12 }} frame={{ maxWidth: "infinity", alignment: "leading" }}>
              <Text font={15} fontWeight="semibold" foregroundStyle={C.text}>{q}</Text>
              <Text font={13} foregroundStyle={C.secondary}>{a}</Text>
            </VStack>
          ))}
        </Section>
      ))}
    </SubPage>
  )
}

// ---------------- 所有取件码 ----------------
function AllPickupsPage({ close, bump, openSheet, revision }: { close: Closer; bump: Closer; openSheet: Opener; revision: number }) {
  void revision
  const [rev, setRev] = useState(0)
  type Filter = "all" | "transit" | "pending" | "done"
  const savedFilter = (Storage.get<string>("cc.parcelsFilter") as Filter) || "all"
  const [filter, setFilter] = useState<Filter>(savedFilter)
  const applyFilter = (f: Filter) => { setFilter(f); try { Storage.set("cc.parcelsFilter", f) } catch { } }
  const [query, setQuery] = useState("")
  const animate = (fn: () => void) => { try { void withAnimation(fn) } catch { fn() } }
  const all = getPickups().filter(p => (p.type ?? "delivery") === "delivery")
  const counts = {
    all: all.length,
    transit: all.filter(p => isTransitPkg(p)).length,
    pending: all.filter(p => isAwaitingPickup(p)).length,
    done: all.filter(p => p.status === 2).length,
  }
  const q = query.trim().toLowerCase()
  const list = all.filter(p => {
    if (filter === "transit" && !isTransitPkg(p)) return false
    if (filter === "pending" && !isAwaitingPickup(p)) return false
    if (filter === "done" && p.status !== 2) return false
    if (!q) return true
    const hay = `${p.code} ${companyName(p.companyName)} ${p.address} ${p.courierStationName} ${p.smsContent} ${p.itemTitle ?? ""}`
    return hay.toLowerCase().includes(q)
  }).sort((a, b) => (a.status === 2 ? 1 : 0) - (b.status === 2 ? 1 : 0) || b.createdAt - a.createdAt)

  // 系统分段控件（Picker segmented）：可点击、液态玻璃滑动药丸，选中项自动带滑块动画
  const FilterBar = () => (
    <Picker title="筛选" value={filter} onChanged={(v: string) => applyFilter(v as Filter)} pickerStyle="segmented"
      frame={{ maxWidth: "infinity", height: 48 }}>
      <Text tag="all" font={17}>全部 {counts.all}</Text>
      <Text tag="transit" font={17}>在途 {counts.transit}</Text>
      <Text tag="pending" font={17}>待取 {counts.pending}</Text>
      <Text tag="done" font={17}>已取 {counts.done}</Text>
    </Picker>
  )

  return (
    <SubPageScroll title="所有包裹" onClose={close}
      searchable={{
        placement: "navigationBarDrawerAutomaticDisplay",
        prompt: "搜索取件码、快递公司或地址",
        value: query,
        onChanged: setQuery,
      }}>
      <VStack alignment="leading" spacing={0} frame={{ maxWidth: "infinity", alignment: "leading" }}
        padding={{ horizontal: 16, top: 8, bottom: 40 }}>
        <FilterBar />

        <VStack spacing={8} frame={{ maxWidth: "infinity", alignment: "leading" }} padding={{ top: 16 }}>
          {list.length === 0 ? (
            <VStack spacing={10} frame={{ maxWidth: "infinity" }} padding={{ vertical: 60 }}>
              <Icon name="magnifyingglass" size={36} color={C.tertiary} />
              <Text font={17} foregroundStyle={C.secondary}>{q ? "没有匹配的取件码" : "暂无取件码"}</Text>
            </VStack>
          ) : list.map(p => (
            // 三级页：真 push（与账号授权页同构）。用 openSheet 会把详情当弹窗，
            // 返回是「关弹窗」而不是回列表，层级对不上。
            <NavigationLink key={p.uuid} destination={<TrackDetailPage pkg={p} close={() => {}} />}>
              <PickupRow item={p}
                swipe={[
                  {
                    title: p.status === 1 ? "已取" : "待取",
                    tint: p.status === 1 ? C.accent : C.orange,
                    action: () => animate(() => { setPickupStatus(p.uuid, p.status === 1 ? 2 : 1); bump(); setRev(rev + 1) }),
                  },
                  { title: "删除", destructive: true, action: () => animate(() => { deletePickup(p.uuid); bump(); setRev(rev + 1) }) },
                ]} />
            </NavigationLink>
          ))}
        </VStack>
      </VStack>
    </SubPageScroll>
  )
}

// ---------------- 账户 ----------------
/** 头像可选的系统卡通表情（直接用 Apple emoji 渲染，观感与系统头像一致） */
const AVATAR_EMOJIS = [
  // 动物优先
  "🐱", "🐶", "🐼", "🦊",
  "🐷", "🐙", "🦄", "🐸",
  "🐲",
  // 再是人像
  "🧑‍💻", "👩‍🦰", "🧔", "👵",
  "👶", "🧑‍🎤", "🧕",
  // 其他
  "👻", "🤖",
]

const AVATAR_CELL = 46
/** 拖拽起点（同时只会开一个裁剪页，放模块级避开闭包陈旧值） */
let cropBase = { x: 0, y: 0 }
/** 当前渲染用的几何，保存时复用（避免把 geometry 带出渲染闭包） */
let cropGeo = { s: 1, iw: 0, ih: 0, ox: 0, oy: 0, cs: 250 }

/** 头像裁剪：和「添加」页同一套二级页（Form + 导航栏 取消/保存），弹卡片呈现。 */
export function AvatarCropSheet({ img, onCancel, onDone }: { img: any; onCancel: () => void; onDone: (cropped: any) => void }) {
  const [zoom, setZoom] = useState(1)
  const [off, setOff] = useState({ x: 0, y: 0 })
  const [dragging, setDragging] = useState(false)

  const W = Device.screen.width - 40
  const CS = Math.min(200, Math.round(W * 0.55))
  const canvasH = 360

  // 1× 时整张图按 fit 铺进画布（能看到剩余部分），但保证至少盖满圆圈
  const baseS = Math.max(
    Math.min(W / img.width, canvasH / img.height),
    Math.max(CS / img.width, CS / img.height),
  )
  const s = baseS * zoom
  const iw = img.width * s
  const ih = img.height * s
  const maxX = Math.max(0, (iw - CS) / 2)
  const maxY = Math.max(0, (ih - CS) / 2)
  const offX = Math.max(-maxX, Math.min(maxX, off.x))
  const offY = Math.max(-maxY, Math.min(maxY, off.y))

  const dragGesture = DragGesture()
    .onChanged((v: any) => {
      if (!dragging) { cropBase = { x: offX, y: offY }; setDragging(true) }
      setOff({ x: cropBase.x + v.translation.width, y: cropBase.y + v.translation.height })
    })
    .onEnded(() => {
      setDragging(false)
      setOff({ x: Math.max(-maxX, Math.min(maxX, off.x)), y: Math.max(-maxY, Math.min(maxY, off.y)) })
    })

  function finish() {
    const size = CS / s
    const cropped = img.croppedTo({
      x: (iw / 2 - offX - CS / 2) / s,
      y: (ih / 2 - offY - CS / 2) / s,
      width: size, height: size,
    })
    if (cropped) onDone(cropped)
  }

  return (
    <SubPage title="编辑头像" onClose={onCancel} standalone save={{ title: "保存", action: finish }}>
      <Section>
        {/* 行背景直接铺黑（缩进到卡片边缘），内层固定尺寸裁切 */}
        <ZStack frame={{ width: W, height: canvasH }} clipShape={RR(0)}
          gesture={dragGesture} contentShape="rect"
          listRowInsets={{ top: 0, leading: 0, bottom: 0, trailing: 0 }}
          listRowBackground={<VStack frame={{ maxWidth: "infinity", maxHeight: "infinity" }} background={"#000000" as any} />}>
          <Image image={img} resizable antialiased interpolation="high"
            frame={{ width: iw, height: ih }} offset={{ x: offX, y: offY }} opacity={0.35} />
          <VStack frame={{ width: CS, height: CS }} clipShape={RR(CS / 2)}>
            <Image image={img} resizable antialiased interpolation="high"
              frame={{ width: iw, height: ih }} offset={{ x: offX, y: offY }} />
          </VStack>
        </ZStack>
      </Section>
      <Section title="调整" footer="圆内拖动也可以移动位置">
        <HStack spacing={12} padding={{ vertical: 8 }} frame={{ maxWidth: "infinity" }}>
          <Text font={14} foregroundStyle={C.text} frame={{ width: 34 }}>缩放</Text>
          <Slider min={1} max={3} step={0.05} value={zoom} onChanged={setZoom} />
        </HStack>
        <HStack spacing={12} padding={{ vertical: 8 }} frame={{ maxWidth: "infinity" }}>
          <Text font={14} foregroundStyle={C.text} frame={{ width: 34 }}>左右</Text>
          <Slider min={-Math.max(1, maxX)} max={Math.max(1, maxX)} step={1}
            value={offX} onChanged={x => setOff({ x, y: offY })} />
        </HStack>
        <HStack spacing={12} padding={{ vertical: 8 }} frame={{ maxWidth: "infinity" }}>
          <Text font={14} foregroundStyle={C.text} frame={{ width: 34 }}>上下</Text>
          <Slider min={-Math.max(1, maxY)} max={Math.max(1, maxY)} step={1}
            value={offY} onChanged={y => setOff({ x: offX, y })} />
        </HStack>
      </Section>
    </SubPage>
  )
}

function AvatarCell({ on, onTap, children }: { on: boolean; onTap: () => void; children?: any }) {
  return (
    <VStack frame={{ width: AVATAR_CELL, height: AVATAR_CELL }} contentShape="rect" onTapGesture={onTap}
      background={{ style: on ? C.accent : (C.track as any), shape: RR(AVATAR_CELL / 2) }}
      clipShape={RR(AVATAR_CELL / 2)}>
      {children}
    </VStack>
  )
}

function NicknamePage({ close, bump }: { close: Closer; bump: Closer }) {
  const s = getSettings()
  const [name, setName] = useState(s.nickName || "")
  return (
    <SubPage title="昵称" onClose={close}
      save={{
        title: "保存",
        disabled: name.trim().length === 0,
        action: () => { saveSettings({ nickName: name.trim().slice(0, 16) }); bump(); close() },
      }}>
      <Section footer="只在本机账户页显示，不会上传到任何平台。">
        <TextField title="昵称" value={name} onChanged={(v: string) => setName(v.slice(0, 16))} />
      </Section>
    </SubPage>
  )
}

function ProfilePage({ close, bump, open, revision }: { close: Closer; bump: Closer; open: Opener; revision: number }) {
  const s = getSettings()
  const [mode, setMode] = useState<"none" | "emoji" | "photo">(s.avatarMode ?? "none")
  const [emoji, setEmoji] = useState(s.avatarEmoji ?? "")
  const [photo, setPhoto] = useState(s.avatarPhoto ?? "")
  const [picking, setPicking] = useState(false)
  const [hint, setHint] = useState("")
  /** 快递鸟凭证直接每渲染时读钥匙串：用 state 缓存会出现「已登录仍显示未授权」（组件未重新挂载就不刷新） */
  const [tick, setTick] = useState(0)
  const cred = loadCredential()
  const [kdMsg, setKdMsg] = useState("")

  // 昵称只认本机设置：以前默认拿快递鸟账号昵称，现在查单不再只靠快递鸟，账号头不该再绑定某一个平台
  const displayName = s.nickName?.trim() || "包裹助手"
  /** 授权概况：账号页只做入口，详情都在「账号授权」页 */
  const authSummary = () => {
    const n = PLATFORMS.filter(p => hasAuth(p.id)).length
    return n > 0 ? `${n} 个平台已授权` : "尚未授权平台"
  }
  /** 上次同步：全量同步时间戳，没有就写尚未同步 */
  const syncSummary = () => {
    const at = readFullSyncAt()
    return at > 0 ? `上次同步 ${hmText(at)}` : "尚未同步"
  }
  /** 待裁剪的原图（非空时全屏打开裁剪页） */
  const [draft, setDraft] = useState<any>(null)

  async function pickPhoto() {
    setHint("")
    try {
      const res = await Photos.pick({ limit: 1, mode: "default" })
      const img = res && res.length > 0 ? await res[0].uiImage() : null
      if (!img) return
      // 先缩到 1400px：原图太大时拖动每帧都要重解码，会明显卡顿
      const small = img.preparingThumbnail({ width: 1400, height: 1400 }) ?? img
      // 先进裁剪页，用户自己拖选显示区域
      setDraft(small)
    } catch {
      setHint("相册没能打开，请检查相册权限。")
    }
  }

  async function saveCropped(cropped: any) {
    const thumb = cropped.preparingThumbnail({ width: 400, height: 400 }) ?? cropped
    const data = thumb.toPNGData()
    if (!data) { setHint("图片读取失败，请重新选择。"); setDraft(null); return }
    const path = `${FileManager.documentsDirectory}/avatar-${Date.now()}.png`
    await FileManager.writeAsData(path, data)
    // 换新头像时清掉旧文件，避免目录里堆图
    if (photo && photo !== path) { try { await FileManager.remove(photo) } catch {} }
    setPhoto(path); setMode("photo"); setDraft(null)
    saveSettings({ avatarMode: "photo", avatarEmoji: emoji, avatarPhoto: path })
    bump()
  }

  const preview = { avatarMode: mode, avatarEmoji: emoji, avatarPhoto: photo }
  /** 选完立即落盘，页面不再需要保存按钮 */
  function apply(m: "none" | "emoji" | "photo", em: string, ph: string) {
    setMode(m); setEmoji(em); setPhoto(ph)
    saveSettings({ avatarMode: m, avatarEmoji: em, avatarPhoto: ph })
    bump()
  }
  const cells: any[] = [
    <AvatarCell key="none" on={mode === "none"}
      onTap={() => apply("none", emoji, photo)}>
      <Icon name="person.crop.circle.fill" size={28} color={mode === "none" ? C.secondary : C.tertiary} />
    </AvatarCell>,
    <AvatarCell key="photo" on={mode === "photo"} onTap={() => void pickPhoto()}>
      {photo && mode === "photo" ? (
        <Image filePath={photo} resizable antialiased interpolation="high"
          frame={{ width: AVATAR_CELL, height: AVATAR_CELL }} clipShape={RR(AVATAR_CELL / 2)} />
      ) : (
        <Icon name="photo.badge.plus" size={24} color={C.secondary} />
      )}
    </AvatarCell>,
    ...AVATAR_EMOJIS.map(em => (
      <AvatarCell key={em} on={mode === "emoji" && emoji === em}
        onTap={() => apply("emoji", em, photo)}>
        <Text font={Math.round(AVATAR_CELL * 0.5)}>{em}</Text>
      </AvatarCell>
    )),
  ]
  return (
    <VStack frame={{ maxWidth: "infinity", maxHeight: "infinity" }}
      sheet={{
        isPresented: draft != null,
        onChanged: (v: boolean) => { if (!v) setDraft(null) },
        content: <AvatarCropSheet img={draft} onCancel={() => setDraft(null)}
          onDone={(cropped: any) => void saveCropped(cropped)} />,
      }}>
    <SubPage title="账户" onClose={() => { setPicking(false); close() }}>
      <Section>
        <HStack spacing={14} padding={{ vertical: 4 }} frame={{ maxWidth: "infinity", alignment: "leading" }}>
          <VStack frame={{ width: 56, height: 56 }} contentShape="rect" onTapGesture={() => setPicking(v => !v)}>
            <AvatarView a={preview} size={56} />
          </VStack>
          <VStack alignment="leading" spacing={2} frame={{ maxWidth: "infinity", alignment: "leading" }}>
            <Text font={17} fontWeight="semibold" foregroundStyle={C.text}>{displayName}</Text>
            <Text font={13} foregroundStyle={C.secondary}>
              {picking ? "点一个表情，或从相册选图片" : `${authSummary()} · ${syncSummary()}`}
            </Text>
          </VStack>
        </HStack>
      </Section>
      {picking ? (
        <Section title="选择头像" footer={hint || "第一个是无头像，第二个从相册选图。"}>
          <ScrollView axes="horizontal" scrollIndicator="never">
            <HStack spacing={10} padding={{ vertical: 6, horizontal: 2 }}>
              {cells}
            </HStack>
          </ScrollView>
        </Section>
      ) : null}
      <Section title="授权与身份" footer="包裹从已授权平台读取；身份码需先在账号授权里登录对应平台。">
        {/* 与账号授权页同构：NavigationLink 真正 push，系统管返回手势；不用 sheet 式 open() */}
        <NavigationLink destination={<NicknamePage close={close} bump={bump} />}>
          <Row icon="pencil" title="昵称" value={s.nickName || "未设置"} chevron={false} />
        </NavigationLink>
        <NavigationLink destination={<AuthorizePage close={close} bump={bump} open={open} />}>
          <Row icon="checkmark.shield" title="账号授权" value={authSummary()} chevron={false} />
        </NavigationLink>
        <NavigationLink destination={<IdentityEntrySettings close={close} open={open} bump={bump} />}>
          <Row icon="qrcode" title="身份码" value="设置" chevron={false} />
        </NavigationLink>
      </Section>
    </SubPage>
    </VStack>
  )
}

// ---------------- 定时提醒 + 位置提醒（同一页） ----------------
export function ReminderSettingsPage({ close, bump, openSheet }: { close: Closer; bump: Closer; openSheet: Opener }) {
  const s = getSettings()
  const [on, setOn] = useState(s.reminderEnabled)
  const [after, setAfter] = useState(s.reminderAfterHours)
  const [times, setTimes] = useState(s.reminderMaxTimes)
  const [quietStart, setQuietStart] = useState(s.quietStart)
  const [quietEnd, setQuietEnd] = useState(s.quietEnd)
  const [authText, setAuthText] = useState("检查中…")
  const [locs, setLocs] = useState(getLocations())
  const [locMode, setLocMode] = useState<LocMode | "checking">("checking")

  // 地理围栏要求「始终」；不是这个等级就不让开开关，否则开关是开了但永远不会响
  useEffect(() => {
    let cancelled = false
    void (async () => {
      const m = await locationMode()
      if (!cancelled) setLocMode(m)
    })()
    return () => { cancelled = true }
  }, [])

  async function toggleLocation(id: string, v: boolean) {
    if (v) {
      const m = locMode === "checking" ? await locationMode() : locMode
      if (m !== locMode) setLocMode(m)
      if (m !== "always") {
        notify("位置提醒需要把定位权限设为「始终」", "warn")
        setLocs(getLocations())   // 回弹开关
        return
      }
    }
    updateLocation(id, { enabled: v })
    const ok = await syncLocationReminders()
    if (v && !ok) notify("这条位置没能排上，请检查定位权限", "warn")
    setLocs(getLocations())
    bump()
  }

  // 直接读取全局 authorization；它为 null 时用一次静默通知确认，避免把“未请求”误显示成“未决定”。
  useEffect(() => {
    let cancelled = false
    void (async () => {
      try {
        const raw = (globalThis as any).authorization
        if (typeof raw === "string" && raw !== "notDetermined") {
          if (!cancelled) setAuthText(raw === "allowed" ? "已允许" : raw === "denied" ? "已拒绝" : "受限")
          return
        }
        const ok = await Notification.schedule({
          title: "包裹助手", body: "", silent: true, threadIdentifier: "cc-auth-check",
          trigger: new TimeIntervalNotificationTrigger({ timeInterval: 60, repeats: false }),
        })
        if (!cancelled) setAuthText(ok ? "已允许" : "未允许")
        try {
          const pend = await Notification.getAllPendingsOfCurrentScript()
          const ids = pend.filter(r => r.content.threadIdentifier === "cc-auth-check").map(r => r.identifier)
          if (ids.length) await Notification.removePendings(ids)
        } catch {}
      } catch {
        if (!cancelled) setAuthText("未允许")
      }
    })()
    return () => { cancelled = true }
  }, [])

  async function apply(next: { on?: boolean; hours?: number; times?: number; qs?: number; qe?: number }) {
    const nextOn = next.on ?? on
    const hours = next.hours ?? after
    const t = next.times ?? times
    const qs = next.qs ?? quietStart
    const qe = next.qe ?? quietEnd
    setOn(nextOn); setAfter(hours); setTimes(t); setQuietStart(qs); setQuietEnd(qe)
    saveSettings({ reminderEnabled: nextOn, reminderAfterHours: hours, reminderMaxTimes: t, quietStart: qs, quietEnd: qe })
    bump()
    // 用户改设置要立刻重排，绕过 30 秒跨进程闸门（force）
    await reschedulePickupReminders(true)
  }

  return (
    <SubPage title="取件提醒" onClose={close}>
      <Section title="通知权限">
        <LabeledContent label={<Text>状态</Text>} value={authText} />
        {authText !== "已允许" && authText !== "检查中…" ? <Button title="打开系统设置" action={() => { void Safari.openURL("app-settings:") }} /> : null}
      </Section>

      <Section title="到站提醒" footer="包裹进待取时通知一次，需一次同步（打开 App 或小组件刷新）才会发出。">
        <Toggle title="包裹到站时提醒" value={s.trackNotify !== false}
          onChanged={(v) => { saveSettings({ trackNotify: v }); bump() }} />
      </Section>

      <Section title="同步通知" footer="平台同步失败/需要人机验证时发通知，点通知可打开 App 去手动过验证。">
        <Toggle title="同步失败/验证提醒" value={s.syncFailNotify !== false}
          onChanged={(v) => { saveSettings({ syncFailNotify: v }); bump() }} />
      </Section>

      <Section footer={on
        ? `到站满 ${after} 小时开始提醒，每天 1 次，最多 ${times} 次；${String(quietStart).padStart(2, "0")}–${String(quietEnd).padStart(2, "0")} 不发。由 iOS 定时投递，无需 App 运行。`
        : "由 iOS 定时投递，无需 App 运行。"}>
        <Toggle title="超时提醒" value={on} onChanged={(v) => void apply({ on: v })} />
      </Section>

      {/* 规则只在开启时出现：关着时没必要调 */}
      {on ? <>
        <Section title="提醒规则" footer="每天最多一次，超过次数后不再提醒；只给最近 8 个待取包裹排期（iOS 本地通知有总条数上限）。">
          <Stepper onIncrement={() => void apply({ hours: Math.min(72, after + 1) })} onDecrement={() => void apply({ hours: Math.max(1, after - 1) })}>
            <HStack frame={{ maxWidth: "infinity" }}><Text>待取满</Text><HStack frame={{ maxWidth: "infinity" }} /><Text foregroundStyle={C.secondary}>{`${after} 小时`}</Text></HStack>
          </Stepper>
          <Stepper onIncrement={() => void apply({ times: Math.min(5, times + 1) })} onDecrement={() => void apply({ times: Math.max(1, times - 1) })}>
            <HStack frame={{ maxWidth: "infinity" }}><Text>最多提醒</Text><HStack frame={{ maxWidth: "infinity" }} /><Text foregroundStyle={C.secondary}>{`${times} 次`}</Text></HStack>
          </Stepper>
        </Section>
        <Section title="安静时段（免打扰）" footer={`${String(quietStart).padStart(2, "0")}:00–${String(quietEnd).padStart(2, "0")}:00 不推送；跨零点也行（例如 22 → 8）。`}>
          <Stepper onIncrement={() => void apply({ qs: (quietStart + 1) % 24 })} onDecrement={() => void apply({ qs: (quietStart + 23) % 24 })}>
            <HStack frame={{ maxWidth: "infinity" }}><Text>开始</Text><HStack frame={{ maxWidth: "infinity" }} /><Text foregroundStyle={C.secondary}>{`${String(quietStart).padStart(2, "0")}:00`}</Text></HStack>
          </Stepper>
          <Stepper onIncrement={() => void apply({ qe: (quietEnd + 1) % 24 })} onDecrement={() => void apply({ qe: (quietEnd + 23) % 24 })}>
            <HStack frame={{ maxWidth: "infinity" }}><Text>结束</Text><HStack frame={{ maxWidth: "infinity" }} /><Text foregroundStyle={C.secondary}>{`${String(quietEnd).padStart(2, "0")}:00`}</Text></HStack>
          </Stepper>
        </Section>
      </> : null}

      {/* 位置提醒：跟定时提醒不是一套机制（系统地理围栏），所以放最后单独一节 */}
      <Section title="位置提醒" footer="进出指定区域时由系统投递，不需要 App 在后台运行。需要定位权限「始终」。">
        <LabeledContent label={<Text>定位权限</Text>} value={locMode === "checking" ? "检查中…" : locationModeText(locMode)} />
        {locMode !== "checking" && locMode !== "always" ? <Button title="去系统设置开启「始终」" action={() => { void Safari.openURL("app-settings:") }} /> : null}
        {locs.map(l => (
          <HStack key={l.id} spacing={12} padding={{ vertical: 4 }} frame={{ maxWidth: "infinity", alignment: "leading" }}>
            <NavigationLink destination={<LocationDetailPage id={l.id} close={close} bump={bump} />}>
              <HStack spacing={12} frame={{ maxWidth: "infinity", alignment: "leading" }}>
                <IconTile name={l.arriveAtArrival ? "arrow.down.circle.fill" : "arrow.up.circle.fill"} size={30} radius={15} bg={C.track} fg={C.secondary} />
                <VStack alignment="leading" spacing={2} frame={{ maxWidth: "infinity", alignment: "leading" }}>
                  <Text font={16} foregroundStyle={l.enabled ? C.text : C.tertiary}>{l.placeName}</Text>
                  <Text font={12} foregroundStyle={l.enabled ? C.secondary : C.tertiary}>{`${l.arriveAtArrival ? "到达时提醒" : "离开时提醒"} · 半径 ${l.radius}m`}</Text>
                </VStack>
              </HStack>
            </NavigationLink>
            <Toggle title="" value={l.enabled} onChanged={(v) => void toggleLocation(l.id, v)} />
          </HStack>
        ))}
        <Button action={() => openSheet("addLocation")} buttonStyle="plain" frame={{ maxWidth: "infinity", alignment: "leading" }} contentShape="rect">
          <HStack spacing={10} frame={{ maxWidth: "infinity", alignment: "leading" }}>
            <Icon name="plus.circle.fill" size={18} color={C.blue} />
            <Text font={16} foregroundStyle={C.blue}>添加位置提醒</Text>
          </HStack>
        </Button>
      </Section>
    </SubPage>
  )
}

// ---------------- 位置提醒详情 ----------------
function LocationDetailPage({ id, close, bump }: { id: string; close: Closer; bump: Closer }) {
  const dismiss = Navigation.useDismiss()
  const loc = getLocations().find(l => l.id === id)
  const [rev, setRev] = useState(0)
  const [locAuth, setLocAuth] = useState<LocMode | "checking">("checking")
  useEffect(() => { void (async () => setLocAuth(await locationMode()))() }, [])
  if (!loc) return <SubPage title="位置提醒" onClose={close}><Section><Row title="记录已删除" chevron={false} /></Section></SubPage>
  return (
    <SubPage title="位置提醒详情" onClose={close}>
      <Section>
        <LabeledContent label={<Text>位置</Text>} value={loc.placeName} />
        <LabeledContent label={<Text>触发方式</Text>} value={loc.arriveAtArrival ? "到达时提醒" : "离开时提醒"} />
        <LabeledContent label={<Text>触发半径</Text>} value={`${loc.radius} 米`} />
        <LabeledContent label={<Text>创建时间</Text>} value={new Date(loc.createdAt).toLocaleString()} />
        <Toggle title="启用" value={loc.enabled} onChanged={(v) => void (async () => {
          if (v) {
            const m = await locationMode()
            setLocAuth(m)
            if (m !== "always") { notify("位置提醒需要把定位权限设为「始终」", "warn"); setRev(rev + 1); return }
          }
          updateLocation(loc.id, { enabled: v })
          const ok = await syncLocationReminders()
          if (v && !ok) notify("这条位置没能排上，请检查定位权限", "warn")
          bump(); setRev(rev + 1)
        })()} />
      </Section>
      <Section title="权限" footer="位置权限需设为「始终」，否则进出该区域不会提醒。">
        <LabeledContent label={<Text>定位权限</Text>} value={locAuth === "checking" ? "检查中…" : locationModeText(locAuth)} />
        <Button title="去设置" action={() => { void Safari.openURL("app-settings:") }} />
      </Section>
      <Section>
        <Button title="删除位置提醒" role="destructive" frame={{ maxWidth: "infinity" }} action={() => {
          deleteLocation(loc.id)
          // 只重排地理围栏，不动到站/未取提醒
          void syncLocationReminders()
          bump(); dismiss()
        }} />
      </Section>
    </SubPage>
  )
}

// ---------------- 添加位置提醒（sheet） ----------------
function AddLocationPage({ close, bump }: { close: Closer; bump: Closer }) {
  const [place, setPlace] = useState("")
  const [arrive, setArrive] = useState(1)
  const [radius, setRadius] = useState(200)
  const [lat, setLat] = useState<number | null>(null)
  const [lng, setLng] = useState<number | null>(null)
  const [picking, setPicking] = useState(false)

  async function pick() {
    setPicking(true)
    try {
      const p = await Location.pickFromMap()
      if (p) {
        setLat(p.latitude); setLng(p.longitude)
        try {
          const marks = await Location.reverseGeocode({ latitude: p.latitude, longitude: p.longitude, locale: "zh_CN" })
          const m = marks?.[0]
          const name = m?.name || m?.thoroughfare || m?.subLocality || m?.locality
          if (name) setPlace(name)
        } catch {}
      }
    } catch {}
    setPicking(false)
  }

  async function save() {
    if (!place.trim() || lat == null || lng == null) return
    // 没有「始终」就不建成启用状态：地理围栏不会投递，开了等于骗自己
    const m = await locationMode()
    const usable = m === "always"
    addLocation({
      placeName: place.trim(), latitude: lat, longitude: lng, radius,
      arriveAtArrival: arrive === 1, enabled: usable,
    })
    // 交给系统的地理围栏：进/出区域时由 iOS 投递，不需要 App 在后台，也不耗电
    const ok = usable ? await syncLocationReminders() : false
    if (!usable) notify("已保存，但需要把定位权限设为「始终」才能生效", "warn")
    else if (!ok) notify("没能排上，请检查定位权限", "warn")
    bump(); close()
  }

  return (
    <SubPage title="添加位置提醒" onClose={close} save={{ title: "添加", disabled: !place.trim() || lat == null, action: () => void save() }}>
      <Section title="触发方式" footer="由系统在进出区域时投递，不需要 App 在后台运行，也不耗电。">
        <Picker title="触发方式" value={arrive} onChanged={setArrive} pickerStyle="menu">
          <Text tag={1}>到达时提醒</Text>
          <Text tag={0}>离开时提醒</Text>
        </Picker>
      </Section>
      <Section title="位置">
        <Button action={() => void pick()} buttonStyle="plain" frame={{ maxWidth: "infinity", alignment: "leading" }} contentShape="rect">
          <HStack spacing={10} frame={{ maxWidth: "infinity", alignment: "leading" }}>
            <Icon name="map.fill" size={16} color={C.blue} />
            <Text font={16} foregroundStyle={C.blue} frame={{ maxWidth: "infinity", alignment: "leading" }}>{picking ? "选择中…" : (place || "选择位置")}</Text>
            <Icon name="chevron.right" size={12} color={C.blue} />
          </HStack>
        </Button>
        <VStack spacing={8} frame={{ maxWidth: "infinity" }}>
          <HStack spacing={10}>
            <Text frame={{ maxWidth: "infinity" }}>触发半径</Text>
            <Text foregroundStyle={C.secondary}>{`${radius}米`}</Text>
          </HStack>
          <Slider min={100} max={2000} step={50} value={radius} onChanged={setRadius} />
        </VStack>
      </Section>
      <Section>
        <HStack spacing={10} padding={{ vertical: 4 }} frame={{ maxWidth: "infinity", alignment: "leading" }}>
          <Icon name="info.circle.fill" size={20} color={C.blue} />
          <Text font={15} foregroundStyle={C.text} frame={{ maxWidth: "infinity", alignment: "leading" }}>
            当您有待取件的快递时，到达或离开该位置将收到提醒通知
          </Text>
        </HStack>
      </Section>
    </SubPage>
  )
}

// ---------------- 账号授权 ----------------
function AuthorizePage({ close, bump, open }: { close: Closer; bump: Closer; open: Opener }) {
  const [busy, setBusy] = useState<PlatformId | null>(null)
  const [rev, setRev] = useState(0)
  const [syncing, setSyncing] = useState(false)
  const [kdTick, setKdTick] = useState(0)
  const [mobBusy, setMobBusy] = useState(false)
  const [kdMsg, setKdMsg] = useState("")
  // 同步状态只活在这一页：进页重置、离页清空，不在返回后残留
  const [syncText, setSyncText] = useState("")
  const [syncErr, setSyncErr] = useState("")
  useEffect(() => {
    setSyncText("")
    setSyncErr("")
    return () => { setSyncText(""); setSyncErr("") }
  }, [])

  async function runSync(only?: string[]) {
    if (syncing) return
    setSyncing(true)
    setSyncErr("")
    setSyncText("准备中…")
    try {
      // 手动同步给 120 秒预算：撞上排队页时不至于无限挂着（自动全量 60s / 组件 12s）
      // only：授权完某平台后只同步它，不连累其它平台
      await syncPlatformParcels((t) => setSyncText(t || "同步中…"), { force: true, deadline: Date.now() + 120_000, only })
      bump()
      setRev(r => r + 1)
    } catch (e: any) {
      // 错误写在行右侧，不再弹气泡（避免和行内文案重复）
      setSyncErr(String(e?.message ?? e).slice(0, 24))
    } finally {
      setSyncing(false)
      setSyncText("")
      setRev(r => r + 1)
    }
  }

  const lastSyncAt = readFullSyncAt()
  const idleText = lastSyncAt > 0 ? `${hmText(lastSyncAt)} 已同步` : "尚未同步"

  return (
    <SubPage title="账号授权" onClose={close}>
      <Section title="授权电商平台"
        footer="淘宝与菜鸟共用同一个淘宝登录态：单独解除只停对应数据并显示未授权，两路都解除才清登录；已有登录态时点授权只当开关，缺身份才弹登录。">
        {PLATFORMS.map(p => {
          const authed = hasAuth(p.id)
          const expired = needsReauth(p.id)
          return (
            // 真正的原生 push：系统管返回手势与层级，返回回授权页而不是退到一级页。
            // 按钮是行内快捷操作（解授权/快登），不触发 push。
            <NavigationLink key={p.id}
              destination={<PlatformDetailPage id={p.id} close={() => { }} bump={bump} open={open} />}>
              <HStack spacing={12} padding={{ vertical: 6 }} frame={{ maxWidth: "infinity", alignment: "leading" }}>
              <ZStack frame={{ width: 36, height: 36 }} clipShape={RR(18)}>
                <Image image={assetImage(p.icon)} resizable antialiased
                  interpolation="high" frame={{ width: 36, height: 36 }} />
              </ZStack>
              <VStack alignment="leading" spacing={2} frame={{ maxWidth: "infinity", alignment: "leading" }}>
                <Text font={16} fontWeight="medium" foregroundStyle={C.text}>{p.name}</Text>
                {/* 每平台各自的上次成功时间/失败原因合并到一行：同步了但个别平台失败时一眼能看到 */}
                <Text font={12} foregroundStyle={expired ? C.orange : authed ? C.accent : C.tertiary}>
                  {(() => {
                    // 失效优先：「已授权 · 上次同步 xx」这种文案会把「登录已失效」盖掉，
                    // 看起来就像一切正常
                    if (expired) {
                      const err = platformLastError(p.id)
                      return err ? `登录已失效：${err.msg.slice(0, 20)}` : "登录已失效，需重新授权"
                    }
                    if (!authed) return "未授权"
                    // 配置缺失不必等同步失败才报：这就是它在详情页里的失败原因
                    if (p.id === "mi" && miPhones().length === 0) return "已授权 · 未绑定取件手机号"
                    const err = platformLastError(p.id)
                    const last = platformLastSyncedAt(p.id)
                    const fresh = err && Date.now() - err.at < 3 * 3_600_000
                    if (fresh) return `已授权 · 同步失败：${err!.msg.slice(0, 30)}`
                    if (last > 0) return `已授权 · 上次同步 ${hmText(last)}`
                    return "已授权"
                  })()}
                </Text>
              </VStack>
              <Button title={expired ? "重新授权" : authed ? "解除授权" : "授权"}
                buttonStyle={authed && !expired ? "bordered" : "borderedProminent"}
                tint={authed && !expired ? C.red : C.accent}
                role={authed && !expired ? "destructive" : undefined}
                disabled={busy !== null}
                action={async () => {
                  if (authed && !expired) {
                    clearAuth(p.id)
                    notify(`${p.name}已解除授权`)
                    setRev(r => r + 1); bump()
                    return
                  }
                  setBusy(p.id)
                  try {
                    // 丰巢：原生手机号+验证码表单（RSA 签名的接口登录）
                    if (p.id === "fengchao") { open("fengchaoLogin"); setBusy(null); return }
                    // 小米：照其它平台一样，点授权直接弹 WebView 登录页，成功自动关
                    if (p.id === "mi") {
                      setBusy(null)
                      const controller = new WebViewController({ ephemeral: true, preferredContentMode: "desktop" })
                      let presented = true
                      try {
                        controller.present({ fullscreen: true, navigationTitle: "登录小米账号" })
                          .then(() => { presented = false })
                          .catch(() => { presented = false })
                        const { resolveMiLoginUrl } = await import("./miLoginHelper")
                        const url = await resolveMiLoginUrl()
                        try { await controller.loadURL(url) } catch { }
                        const deadline = Date.now() + 10 * 60 * 1000
                        let ok = false
                        while (presented && Date.now() < deadline) {
                          await new Promise<void>(r => (setTimeout as any)(r, 2000))
                          if (!presented) break
                          const cur = String((controller as any).url || "")
                          const done = cur.includes("fe/service/account")
                            || cur.includes("passInfo=login-end")
                            || cur.startsWith("https://api.assistant.miui.com/sts")
                          if (!done) continue
                          const cookies: any[] = await controller.getAllCookies().catch(() => [])
                          const pick = (name: string) => cookies.find((c: any) => c.name === name && !!c.value)?.value
                          let token = pick("assistant_serviceToken") ?? pick("serviceToken")
                          const cUserId = pick("cUserId") ?? ""
                          const passToken = pick("passToken")
                          const userId = pick("userId")
                          const deviceId = pick("deviceId")
                          if (token) {
                            miSaveSession(token, { cUserId, passToken: passToken ?? "", userId: userId ?? "", deviceId: deviceId ?? "" })
                            ok = true
                            break
                          }
                          if (passToken && userId && deviceId) {
                            miSaveSession("", { passToken, userId, deviceId })
                            try {
                              const mint = await miMintToken()
                              miSaveSession(mint.token, { ...miReadUser(), cUserId: mint.cUserId, passToken, userId, deviceId })
                              ok = true
                              break
                            } catch (e: any) {
                              notify(String(e?.message ?? e).slice(0, 40), "error")
                            }
                          }
                        }
                        if (presented) { try { controller.dismiss() } catch { } await new Promise<void>(r => (setTimeout as any)(r, 400)) }
                        if (ok && miHasLogin()) {
                          markPlatform("mi", true)
                          notify("小米账号登录成功")
                          setRev(r => r + 1); bump()
                          void runSync(["mi"])
                        } else if (!presented && !miHasLogin()) {
                          notify("小米登录未完成，请重试", "warn")
                        }
                      } finally {
                        try { controller.dispose() } catch { }
                      }
                      return
                    }
                    const err = await authorize(p.id)
                    if (err) notify(err, "warn")
                    else {
                      markPlatform(p.id, true)
                      notify(`${p.name}授权成功`)
                    }
                    setRev(r => r + 1); bump()
                    // 刚授权谁就只同步谁：全量同步会花几分钟且连累其它平台的限流冷却。
                    // 菜鸟有自己的接口（复用淘宝登录态），不需要改去跑淘宝订单。
                    void runSync([p.id])
                  } catch (e: any) {
                    notify(String(e?.message ?? e), "error")
                  } finally {
                    setBusy(null)
                  }
                }} />
              {/* NavigationLink 自带系统 chevron，不要再手画一个（否则双箭头） */}
            </HStack>
            </NavigationLink>
          )
        })}
      </Section>

      <Section title="同步" footer="打开 App 会按「刷新频率」里的间隔自动拉；手动同步无视间隔，用 120 秒预算把所有平台翻一遍（含京东）。">
        <Button buttonStyle="plain" disabled={syncing} frame={{ maxWidth: "infinity", alignment: "leading" }} contentShape="rect"
          action={() => void runSync()}>
          <HStack spacing={12} padding={{ vertical: 6 }} frame={{ maxWidth: "infinity", alignment: "leading" }}>
            <Icon name="arrow.triangle.2.circlepath" size={18} color={C.accent} />
            <Text font={16} foregroundStyle={C.text}>{syncing ? "正在同步…" : "立即同步包裹"}</Text>
            <VStack frame={{ maxWidth: "infinity" }} />
            <Text font={12} lineLimit={1} truncationMode="tail"
              foregroundStyle={syncErr ? C.red : C.tertiary}>
              {syncing ? (syncText || "同步中…") : (syncErr || idleText)}
            </Text>
          </HStack>
        </Button>
      </Section>
      <Section title="快递鸟（查单兜底）"
        footer="手动查单默认走菜鸟（免登录）；菜鸟没结果时才用快递鸟。凭证只存本机钥匙串。">
        {(() => {
          const cred = loadCredential()
          void kdTick
          return (
            <HStack key="kdniao" spacing={12} padding={{ vertical: 6 }} frame={{ maxWidth: "infinity", alignment: "leading" }}>
              <ZStack frame={{ width: 36, height: 36 }} clipShape={RR(18)}>
                <Image image={assetImage("identity/kdniao.png")} resizable antialiased
                  interpolation="high" frame={{ width: 36, height: 36 }} />
              </ZStack>
              <VStack alignment="leading" spacing={2} frame={{ maxWidth: "infinity", alignment: "leading" }}>
                <Text font={16} fontWeight="medium" foregroundStyle={C.text}>快递鸟</Text>
                <Text font={12} foregroundStyle={cred ? C.accent : C.tertiary}>
                  {kdMsg || (cred ? "已授权" : "未授权")}
                </Text>
              </VStack>
              <Button title={cred ? "解除授权" : "授权"}
                buttonStyle={cred ? "bordered" : "borderedProminent"}
                tint={cred ? C.red : C.accent}
                role={cred ? "destructive" : undefined}
                action={() => {
                  if (cred) {
                    clearCredential(); clearToken(); setKdMsg("已解除授权"); setKdTick(t => t + 1)
                  } else {
                    open("kdLogin")
                  }
                }} />
            </HStack>
          )
        })()}
      </Section>
    </SubPage>
  )
}
// ---------------- 驿站 ----------------
/** 取今天的某个时刻（用于时间滚轮的初始值） */
function atTime(h: number, m: number): number {
  const d = new Date()
  d.setHours(h, m, 0, 0)
  return d.getTime()
}
/** 时间戳 → HH:mm */
function hmText(t: number): string {
  const d = new Date(t)
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`
}
/** "08:00-22:00" → { open, close } 时间戳；缺省 08:00 / 22:00 */
function parseRange(s: string): { open: number; close: number } {
  const all = (s ?? "").match(/\d{1,2}:\d{2}/g) ?? []
  const toTs = (v: string | undefined, fallback: [number, number]) => {
    const m = (v ?? "").match(/(\d{1,2}):(\d{2})/)
    return m ? atTime(Number(m[1]), Number(m[2])) : atTime(fallback[0], fallback[1])
  }
  return { open: toTs(all[0], [8, 0]), close: toTs(all[1] ?? all[0], [22, 0]) }
}

function StationPage({ close, bump }: { close: Closer; bump: Closer }) {
  const [rev, setRev] = useState(0)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [name, setName] = useState("")
  const [kws, setKws] = useState("")
  const [addr, setAddr] = useState("")
  const [phone, setPhone] = useState("")
  const [hours, setHours] = useState("")
  const [confirmDel, setConfirmDel] = useState<string | null>(null)
  const [openAt, setOpenAt] = useState(() => atTime(8, 0))
  const [closeAt, setCloseAt] = useState(() => atTime(22, 0))
  const [hoursTouched, setHoursTouched] = useState(false)
  const [notes, setNotes] = useState("")
  const list = getStations()
  const act = (fn: () => void) => { fn(); bump(); setRev(rev + 1) }

  // 点卡片就地展开编辑（不再另开一个「编辑驿站」区）
  const fill = (s: CourierStation) => {
    setEditingId(s.courierStationUuid)
    setConfirmDel(null)
    setName(s.courierStationName)
    setKws((s.keywords ?? []).join("、"))
    setAddr(s.address)
    setPhone((s.phones ?? []).length > 0 ? (s.phones ?? []).join("、") : (s.phone || ""))
    setHours(s.businessHours || "")
    const r = parseRange(s.businessHours)
    setOpenAt(r.open)
    setCloseAt(r.close)
    setHoursTouched(false)
    setNotes(s.notes)
  }
  const reset = () => {
    setEditingId(null); setName(""); setKws(""); setAddr("")
    setPhone(""); setHours(""); setNotes("")
  }
  // 关键词/手机号支持逗号、分号、顿号、空格分隔
  const parseList = (v: string) => v.split(/[,，、;；\s]+/).map(x => x.trim()).filter(x => x.length > 0)
  const save = () => {
    if (!editingId || !name.trim()) return
    const cleanPhones = parseList(phone)
    act(() => updateStation(editingId, {
      courierStationName: name.trim(), keywords: parseList(kws),
      phones: cleanPhones, phone: cleanPhones[0] ?? "",
      address: addr.trim(), notes: notes.trim(),
      businessHours: hoursTouched ? `${hmText(openAt)}-${hmText(closeAt)}` : hours,
    }))
    reset()
  }
  // 加号：先落地一个默认驿站，再展开让用户直接填
  const addNew = () => {
    const created = addStation({ courierStationName: "新驿站", keywords: [], phones: [], phone: "", address: "", businessHours: "", notes: "" })
    bump()
    setRev(rev + 1)
    fill(created)
  }

  const rows: any[] = []
  // 表单行里 Button 会被当成「尾部附件」居中，改用手势文本才能均分整行
  const saveEnabled = name.trim().length > 0
  const vline = (k: string) => <VStack key={k} frame={{ width: 1, height: 18 }} background={{ style: C.separator, shape: RR(1) }} />
  // 表单行内可用宽：屏宽减表单/卡片内缩；两个操作均分，分割线才会画满整行
  const actW = Math.floor((Math.min(Device.screen.width, 430) - 74) / 2)
  // 左标签 + 右输入的编辑行（TextField 的 title 填上后会顶掉标题，只能自己排）
  const fieldRow = (key: string, label: string, value: string, set: (v: string) => void, hint: string, kb?: any) => (
    <HStack key={key} spacing={10} frame={{ maxWidth: "infinity" }} padding={{ vertical: 2 }}>
      <Text font={16} foregroundStyle={C.text}>{label}</Text>
      <Spacer />
      <TextField title="" prompt={hint} value={value} onChanged={set}
        multilineTextAlignment="trailing" keyboardType={kb}
        frame={{ maxWidth: 210 }} />
    </HStack>
  )
  for (const s of list) {
    const open = editingId === s.courierStationUuid
    const kwList = s.keywords ?? []
    rows.push(
      <Button key={s.courierStationUuid} buttonStyle="plain" frame={{ maxWidth: "infinity", alignment: "leading" }} contentShape="rect"
        action={() => (open ? reset() : fill(s))}
        trailingSwipeActions={{
          allowsFullSwipe: true,
          actions: [
            <Button key="del" title="删除" role="destructive" action={() => {
              act(() => deleteStation(s.courierStationUuid))
              if (editingId === s.courierStationUuid) reset()
            }} />,
          ],
        }}>
        <HStack spacing={12} padding={{ vertical: 4 }} frame={{ maxWidth: "infinity", alignment: "leading" }}>
          <Icon name="building.2.fill" size={20} color={C.blue} />
          <VStack alignment="leading" spacing={2} frame={{ maxWidth: "infinity", alignment: "leading" }}>
            <Text font={16} foregroundStyle={C.text} lineLimit={1}>{s.courierStationName || "未命名驿站"}</Text>
            <Text font={12} foregroundStyle={C.tertiary} lineLimit={1}>
              {kwList.length > 0
                ? kwList.join("、")
                : (s.address || (s.phones ?? [])[0] || "未设置关键词")}
            </Text>
          </VStack>
          <Icon name={open ? "chevron.up" : "chevron.down"} size={13} color={C.tertiary} />
        </HStack>
      </Button>
    )
    if (open) {
      // 编辑区：基本信息 → 其他 → 操作行（删除/保存同一行）
      rows.push(
        fieldRow(`${s.courierStationUuid}-name`, "名称", name, setName, "驿站名称"),
        fieldRow(`${s.courierStationUuid}-kw`, "关键词", kws, setKws, "多个用顿号分隔"),
      )
      // 把解析结果回显，用户能直接看到会被哪几个词命中
      if (parseList(kws).length > 0) {
        rows.push(
          <Text key={`${s.courierStationUuid}-kwout`} font={12} foregroundStyle={C.tertiary} lineLimit={2} padding={{ vertical: 2 }}>
            {`将匹配：${parseList(kws).join(" · ")}`}
          </Text>
        )
      }
      rows.push(
        fieldRow(`${s.courierStationUuid}-addr`, "地址", addr, setAddr, "选填"),
        fieldRow(`${s.courierStationUuid}-phone`, "手机号", phone, setPhone, "多个用顿号分隔", "numbersAndPunctuation"),
        <HStack key={`${s.courierStationUuid}-hours`} spacing={6} frame={{ maxWidth: "infinity" }} padding={{ vertical: 2 }}>
          <Text font={16} foregroundStyle={C.text}>{"营业时间"}</Text>
          <Spacer />
          <DatePicker title="" value={openAt} displayedComponents={["hourAndMinute"]}
            datePickerStyle="compact" labelsHidden
            onChanged={(v: number) => { setOpenAt(v); setHoursTouched(true) }} />
          <Text font={15} foregroundStyle={C.secondary}>{"–"}</Text>
          <DatePicker title="" value={closeAt} displayedComponents={["hourAndMinute"]}
            datePickerStyle="compact" labelsHidden
            onChanged={(v: number) => { setCloseAt(v); setHoursTouched(true) }} />
        </HStack>,
        fieldRow(`${s.courierStationUuid}-notes`, "备注", notes, setNotes, "选填"),
        <HStack key={`${s.courierStationUuid}-ops`} spacing={0} frame={{ maxWidth: "infinity" }} padding={{ vertical: 2 }}
          listRowSeparator={{ visibility: "hidden", edges: "bottom" }}>
          <Text font={16} fontWeight="semibold" foregroundStyle={C.red} frame={{ width: actW }} multilineTextAlignment="center"
            contentShape="rect"
            onTapGesture={() => {
              if (confirmDel === s.courierStationUuid) { act(() => deleteStation(s.courierStationUuid)); reset() }
              else setConfirmDel(s.courierStationUuid)
            }}>{confirmDel === s.courierStationUuid ? "确认删除" : "删除"}</Text>
          {vline(`${s.courierStationUuid}-v2`)}
          <Text font={16} fontWeight="semibold" foregroundStyle={saveEnabled ? C.accent : C.tertiary}
            frame={{ width: actW }} multilineTextAlignment="center" contentShape="rect"
            onTapGesture={() => { if (saveEnabled) save() }}>{"保存"}</Text>
        </HStack>,
      )
    }
  }

  return (
    <SubPage title="驿站管理" onClose={close} large
      trailing={<Button action={addNew}><Image systemName="plus" font={16} fontWeight="semibold" foregroundStyle={C.text} /></Button>}>
      {list.length > 0 ? (
        <Section title="已添加" footer="点开驿站即可就地修改。关键词命中短信或地址就归到这个驿站，优先级高于名称和地址；多个用顿号隔开。">
          {rows}
        </Section>
      ) : (
        <Section footer="右上角加号创建驿站后，可以按驿站分组管理取件码。">
          <VStack spacing={10} padding={{ vertical: 16 }} frame={{ maxWidth: "infinity" }}>
            <Icon name="building.2.fill" size={56} color={C.tertiary} />
            <Text font={18} fontWeight="bold">还没有驿站</Text>
            <Text font={13} foregroundStyle={C.tertiary} multilineTextAlignment="center">创建驿站后，可以按照驿站分组管理取件码，让取件更有条理。</Text>
          </VStack>
        </Section>
      )}
    </SubPage>
  )
}

/** 首页驿站标题点开后的驿站详情：只读展示 + 去管理页修改 */
function StationDetailPage({ name, close, open, bump }: { name: string; close: Closer; open: Opener; bump: Closer }) {
  const s = getStations().find(x => x.courierStationName === name)
  const phones = (s?.phones ?? []).filter(Boolean)
  if (!s) {
    return (
      <SubPage title={name || "驿站详情"} onClose={close}>
        <Section><Row title="这个驿站已被删除" chevron={false} /></Section>
      </SubPage>
    )
  }
  return (
    <SubPage title={s.courierStationName} onClose={close}>
      <Section title="联系方式">
        {phones.length > 0 ? phones.map((p, i) => (
          <Row key={`${p}-${i}`} icon="phone.fill" iconColor={C.green} title={p} value="拨打"
            detail={phones.length > 1 ? `手机号 ${i + 1}` : undefined}
            onTap={() => { void Safari.openURL(`tel://${p.replace(/[^\d+]/g, "")}`) }} />
        )) : <Row title="未填写手机号" chevron={false} />}
      </Section>
      <Section title="驿站信息">
        {s.address ? <Row icon="mappin.circle.fill" iconColor={C.blue} title="地址" detail={s.address} value="导航"
          onTap={() => { void Safari.openURL(`http://maps.apple.com/?q=${encodeURIComponent(s.address)}`) }} /> : null}
        {s.businessHours ? <Row icon="clock.fill" iconColor={C.orange} title="营业时间" detail={s.businessHours} chevron={false} /> : null}
        {(s.keywords ?? []).length > 0
          ? <Row icon="tag.fill" iconColor={C.accent} title="关键词" detail={(s.keywords ?? []).join("、")} chevron={false} />
          : null}
        {s.notes ? <Row icon="note.text" iconColor={C.tertiary} title="备注" detail={s.notes} chevron={false} /> : null}
        {!s.address && !s.businessHours && (s.keywords ?? []).length === 0 && !s.notes
          ? <Row title="还没有填写地址、营业时间等信息" chevron={false} />
          : null}
      </Section>
      <Section>
        <NavigationLink destination={<StationPage close={close} bump={bump} />}>
          <Row icon="building.2.fill" title="在驿站管理中修改" chevron={false} />
        </NavigationLink>
      </Section>
    </SubPage>
  )
}

// ---------------- 外观 ----------------
function AppearancePage({ close, bump }: { close: Closer; bump: Closer }) {
  const s = getSettings()
  const [mode, setMode] = useState(s.appearanceMode)
  const [homeColor, setHomeColor] = useState(s.homeColor)
  return (
    <SubPage title="外观与显示" onClose={close}>
      <Section>
        <Picker label={<Text>外观模式</Text>} value={mode} onChanged={(v: string) => { setMode(v as any); saveSettings({ appearanceMode: v as any }); bump() }} pickerStyle="menu" tint={C.secondary}>
          <Text tag="system">跟随系统</Text>
          <Text tag="light">浅色</Text>
          <Text tag="dark">深色</Text>
        </Picker>
        <Picker label={<Text>主题颜色</Text>} value={homeColor} onChanged={(v: string) => { setHomeColor(v); (globalThis as any).__ccThemeColor = v; saveSettings({ homeColor: v }); bump() }} pickerStyle="menu" tint={C.secondary}>
          <Text tag="品牌橙">品牌橙</Text>
          <Text tag="星辉紫">星辉紫</Text>
          <Text tag="天空蓝">天空蓝</Text>
          <Text tag="青柠绿">青柠绿</Text>
        </Picker>
      </Section>
      <Section>
        <Toggle title="简洁模式" value={s.simpleMode} onChanged={(v) => { saveSettings({ simpleMode: v }); bump() }} />
      </Section>
      <Section footer="简洁模式会隐藏底部标签栏，仅保留取件页面。" />
    </SubPage>
  )
}

// ---------------- 刷新频率 ----------------
function RefreshRatePage({ close, bump }: { close: Closer; bump: Closer }) {
  const s = getSettings()
  const [appMin, setAppMin] = useState(s.refreshAppMin)
  const [widgetMin, setWidgetMin] = useState(s.refreshWidgetMin)
  const [existingMin, setExistingMin] = useState(s.refreshExistingMin)
  const [rotateMin, setRotateMin] = useState(s.fullRotateMin)
  const [fullHours, setFullHours] = useState(s.fullSyncHours)
  const [coolMin, setCoolMin] = useState(s.failCoolMin)

  const stepRow = (label: string, text: string, onInc: () => void, onDec: () => void) => (
    <Stepper onIncrement={onInc} onDecrement={onDec}>
      <HStack frame={{ maxWidth: "infinity" }}>
        <Text>{label}</Text><HStack frame={{ maxWidth: "infinity" }} />
        <Text foregroundStyle={C.secondary}>{text}</Text>
      </HStack>
    </Stepper>
  )

  return (
    <SubPage title="刷新频率" onClose={close}>
      <Section title="App 前台" footer="打开 App 时，两次联网至少隔这么久；在页面之间来回切换不会重复拉。">
        {stepRow("刷新间隔", `${appMin} 分钟`,
          () => { const v = Math.min(120, appMin + 5); setAppMin(v); saveSettings({ refreshAppMin: v }); bump() },
          () => { const v = Math.max(5, appMin - 5); setAppMin(v); saveSettings({ refreshAppMin: v }); bump() })} 
      </Section>
      <Section title="小组件" footer="倍数关系：数据刷新 ≥ 2×重建，全量轮转 ≥ 3×重建且大于数据刷新；一次重建只做一件联网的事。">
        {stepRow("重建间隔", `${widgetMin} 分钟`,
          () => {
            const v = Math.min(180, widgetMin + 5)
            // 倍数约束：数据刷新 ≥ 2×，全量轮转 ≥ 3×（且严格大于数据刷新）
            const e = Math.max(existingMin, v * 2)
            const r = Math.max(rotateMin, Math.max(v * 3, e + 5))
            setWidgetMin(v); setExistingMin(e); setRotateMin(r)
            saveSettings({ refreshWidgetMin: v, refreshExistingMin: e, fullRotateMin: r }); bump()
          },
          () => { const v = Math.max(5, widgetMin - 5); setWidgetMin(v); saveSettings({ refreshWidgetMin: v }); bump() })}
        {stepRow("数据刷新", `${existingMin} 分钟`,
          () => {
            const v = Math.min(120, existingMin + 5)
            const r = Math.max(rotateMin, v + 5)
            setExistingMin(v); setRotateMin(r)
            saveSettings({ refreshExistingMin: v, fullRotateMin: r }); bump()
          },
          () => { const v = Math.max(widgetMin * 2, existingMin - 5); setExistingMin(v); saveSettings({ refreshExistingMin: v }); bump() })}
        {stepRow("全量轮转", `${rotateMin} 分钟`,
          () => { const v = Math.min(240, rotateMin + 5); setRotateMin(v); saveSettings({ fullRotateMin: v }); bump() },
          () => { const v = Math.max(existingMin + 5, widgetMin * 3, rotateMin - 5); setRotateMin(v); saveSettings({ fullRotateMin: v }); bump() })} 
      </Section>
      <Section title="全量同步" footer="每个平台最多每隔这么久查一次新订单；App 与组件共用同一个“该平台刚查过”的时间戳，组件按「全量轮转」逐个平台查，不会重复请求。全部平台失败时按「冷却时间」重试，不会白等一个周期。">
        {stepRow("新订单", `${fullHours} 小时`,
          () => { const v = Math.min(12, fullHours + 1); setFullHours(v); saveSettings({ fullSyncHours: v }); bump() },
          () => { const v = Math.max(1, fullHours - 1); setFullHours(v); saveSettings({ fullSyncHours: v }); bump() })} 
      </Section>
      <Section title="失败重试" footer="同步失败或撞上风控后，等这么久再试，避免越试越被限流。">
        {stepRow("冷却时间", `${coolMin} 分钟`,
          () => { const v = Math.min(120, coolMin + 5); setCoolMin(v); saveSettings({ failCoolMin: v }); bump() },
          () => { const v = Math.max(5, coolMin - 5); setCoolMin(v); saveSettings({ failCoolMin: v }); bump() })} 
      </Section>
    </SubPage>
  )
}

// ---------------- 小组件 ----------------

export function WidgetPage({ close, bump }: { close: Closer; bump: Closer }) {
  const [rev, setRev] = useState(0)
  const [family, setFamily] = useState<string>("small")
  const s = getSettings()
  // 预览固定快照：进入页面时读一次，不再随数据/设置变化实时重算。
  // 排除“预览实时刷新与桌面组件互相干扰”的假设（2026-11-13 排障）。
  const [vm] = useState(() => buildWidgetVM())
  void rev
  void bump
  const box = family === "small" ? { w: 158, h: 158 }
    : family === "medium" ? { w: 338, h: 158 } : { w: 338, h: 354 }

  return (
    <SubPage title="小组件" onClose={close}>
      <Section title="预览" footer="桌面右滑到底 → 编辑 → 添加小组件 → 包裹助手。刷新时自动拉最新物流并重跑驿站匹配。">
        <Picker label={<Text>尺寸</Text>} value={family}
          onChanged={(v: string) => setFamily(v)} pickerStyle="segmented" tint={C.secondary}>
          <Text tag="small">小号</Text>
          <Text tag="medium">中号</Text>
          <Text tag="large">大号</Text>
        </Picker>
        <VStack padding={{ vertical: 12 }} frame={{ maxWidth: "infinity", alignment: "center" }}>
          <VStack frame={{ width: box.w, height: box.h }}
            background={{ style: C.card, shape: RR(24) }}
            overlay={<RoundedRectangle cornerRadius={24} style="continuous"
              stroke={{ shapeStyle: C.separator, strokeStyle: { lineWidth: 1 } }} />}
            clipShape={RR(24)}>
            <WidgetBody vm={vm} size={family as WidgetFamilyKey} />
          </VStack>
        </VStack>
      </Section>

      <Section title="显示" footer="待取件：第一行取件码，第二行商品名。在途：第一行商品名，第二行物流动态。">
        <Toggle title="包含在途包裹" systemImage="truck.box" value={s.widgetShowTransit !== false}
          onChanged={(v) => { saveSettings({ widgetShowTransit: v }); setRev(r => r + 1) }} />
      </Section>

      <Section title="后台刷新" footer="包裹助手没有后台进程，物流更新靠小组件刷新顺带拉取（间隔在「刷新频率」里改）。没加小组件就不会发生。">
        <Toggle title="通过小组件后台刷新物流" systemImage="arrow.triangle.2.circlepath"
          value={widgetSeenAt() > 0 && s.bgRefresh !== false}
          onChanged={async (v) => {
            // 没有小组件就没有后台刷新这个能力：先查标记，没有就不允许打开
            if (v && widgetSeenAt() === 0) {
              // 可能刚加上还没渲染过，先催一次，再给用户看提醒
              try { Widget.reloadAll() } catch { }
              await Dialog.alert({
                title: "还没添加小组件",
                message: "包裹助手没有后台进程，物流更新全靠桌面小组件触发。\n\n请先在桌面添加包裹助手小组件（长按桌面 → 左上角 ＋ → 搜索包裹助手），添加后它会自己刷新一次，然后回来打开这个开关。",
                buttonLabel: "知道了",
              })
              if (widgetSeenAt() === 0) return
            }
            saveSettings({ bgRefresh: v })
            setRev(r => r + 1)
          }} />
        <Row icon={widgetSeenAt() > 0 ? "checkmark.seal" : "exclamationmark.triangle"}
          title="小组件状态"
          detail={widgetSeenAt() > 0 ? "已添加" : "未添加"}
          tint={widgetSeenAt() > 0 ? C.green : C.orange}
          chevron={false} />
      </Section>

      <Section footer="小组件和取件页共用同一份数据：这边点圈已取件，取件页同步变成已取；取件页点取件，小组件这条也会立刻消失。">
        <Row icon="checkmark.circle" title="点右侧圆圈标记已取件" chevron={false} />
        <Row icon="barcode" title="有取件码时显示取件码" detail="没取件码落运单号" chevron={false} />
      </Section>
    </SubPage>
  )
}

// ---------------- 实时活动 ----------------
function LivePage({ close, bump }: { close: Closer; bump: Closer }) {
  const s = getSettings()
  const [enabled, setEnabled] = useState<boolean | null>(null)
  const [style, setStyle] = useState(s.liveStyle)
  useEffect(() => { void LiveActivity.areActivitiesEnabled().then(setEnabled).catch(() => setEnabled(false)) }, [])
  const styles = ["液态玻璃", "纯白色", "纯黑色"]
  const expiries = LIVE_EXPIRY_OPTIONS
  const expiry = (v: string) => expiries.includes(v) ? v : "24小时"
  return (
    <SubPage title="实时活动" onClose={close}>
      <Section>
        <VStack spacing={10} padding={{ vertical: 16 }} frame={{ maxWidth: "infinity" }}>
          <Icon name={enabled === false ? "xmark.circle.fill" : "checkmark.circle.fill"} size={46} color={enabled === false ? C.red : C.green} />
          <Text font={18} fontWeight="bold" foregroundStyle={C.text}>{enabled === false ? "实时活动未授权" : "实时活动已授权"}</Text>
          <Text font={14} foregroundStyle={C.secondary} multilineTextAlignment="center">包裹助手可以在灵动岛和锁屏显示取件码</Text>
        </VStack>
      </Section>
      <Section title="显示" footer="关闭后会立即结束锁屏和灵动岛上的取件码。">
        <Toggle title="在灵动岛和锁屏显示待取件" value={s.liveActivityEnabled}
          onChanged={(v) => { saveSettings({ liveActivityEnabled: v }); resetLiveExpiry(); bump() }} />
      </Section>
      <Section title="锁屏样式" footer="切换后下一条活动立即生效">
        <Picker label={<Text>样式</Text>} value={style} onChanged={(v: string) => { setStyle(v); saveSettings({ liveStyle: v as any }); bump() }} pickerStyle="menu" tint={C.secondary}>
          {styles.map(x => <Text key={x} tag={x}>{x}</Text>)}
        </Picker>
      </Section>
      <Section title="预览" footer="单条显示完整卡片，多条会压缩成取件码列表。锁屏/灵动岛上的内容随每次同步更新（打开 App 或小组件刷新）。">
        <VStack alignment="leading" spacing={10} padding={{ vertical: 6 }} frame={{ maxWidth: "infinity", alignment: "leading" }}>
          <Text font={12} foregroundStyle={C.secondary}>当前样式：{style}</Text>
          <LivePreviewBlock style={style} />
        </VStack>
      </Section>
      <Section title="显示时长" footer="到时不自己消失；下次唤醒（打开 App 或组件刷新）时收起。收起后包裹没变化就不再显示。">
        <Picker label={<HStack spacing={10}><Icon name="shippingbox" size={16} color={C.orange} /><Text>取件码</Text></HStack>}
          value={expiry(s.liveExpiryCourier)} onChanged={(v: string) => { saveSettings({ liveExpiryCourier: v as any }); resetLiveExpiry(); bump() }} pickerStyle="menu" tint={C.secondary}>
          {expiries.map(x => <Text key={x} tag={x}>{x}</Text>)}
        </Picker>
      </Section>
    </SubPage>
  )
}

/** 模拟锁屏 + 待取卡片（设置页预览与截图验收共用）。实时活动只显示待取，不涉及在途。 */
export function LivePreviewBlock({ style }: { style: string }) {
  return (
    <VStack spacing={10} padding={14} frame={{ maxWidth: "infinity", alignment: "leading" }}
      background={{ colors: ["#2C3552", "#4B3B59", "#191B23"], startPoint: { x: 0, y: 0 }, endPoint: { x: 1, y: 1 } } as any}
      clipShape={RR(22)}>
      <Text font={10} foregroundStyle="rgba(255,255,255,0.55)">锁屏 / 灵动岛预览</Text>
      <LivePreviewCard style={style} />
    </VStack>
  )
}

function LivePreviewCard({ style }: { style: string }) {
  const white = style === "纯白色"
  const black = style === "纯黑色"
  const fg = (white ? "#111111" : "#FFFFFF") as any
  const dim = (white ? "rgba(0,0,0,0.55)" : "rgba(255,255,255,0.72)") as any
  const line = (white ? "rgba(0,0,0,0.16)" : "rgba(255,255,255,0.3)") as any
  // 液态玻璃：真机上是系统材质，这里用半透明白叠在模拟壁纸上。
  // 注意不能用 #RRGGBBAA 八位 hex——该格式在这里不渲染（实测空白），只能用 rgba。
  const glass: any = {
    colors: ["rgba(255,255,255,0.26)", "rgba(255,255,255,0.07)"],
    startPoint: { x: 0.1, y: 0 }, endPoint: { x: 0.9, y: 1 },
  }
  const bg: any = white ? "#FFFFFF" : black ? "#000000" : glass
  return (
    <VStack alignment="leading" spacing={7} padding={{ horizontal: 16, vertical: 14 }}
      frame={{ maxWidth: "infinity", alignment: "leading" }}
      background={bg} clipShape={RR(20)}>
      <HStack spacing={10} frame={{ maxWidth: "infinity", alignment: "leading" }}>
        <CompanyLogo code={8} size={40} />
        <VStack alignment="leading" spacing={1} frame={{ maxWidth: "infinity", alignment: "leading" }}>
          <Text font={15} fontWeight="semibold" foregroundStyle={fg} lineLimit={1}>
            京东快递（示例驿站）· 3 号柜
          </Text>
          <Text font={12} foregroundStyle={dim} lineLimit={1}>
            京东物流
          </Text>
        </VStack>
      </HStack>
      <HStack spacing={4} frame={{ maxWidth: "infinity" }}>
        {Array.from({ length: 32 }, (_, i) => <VStack key={i} frame={{ width: 4, height: 1 }} background={line} />)}
      </HStack>
      <Text font={28} fontWeight="bold" foregroundStyle={fg} lineLimit={1}>8-2-3605</Text>
    </VStack>
  )
}

// ---------------- 快捷指令 ----------------
/** 短信自动化里可以填的触发词。取件短信里至少会命中一个。 */
const KWS = ["包裹", "快递", "取件码"]

export function ShortcutsPage({ close, bump, linkIntentId }: { close: Closer; bump: Closer; linkIntentId?: string }) {
  const [draft, setDraft] = useState("")
  const [out, setOut] = useState("")
  const [, setRev] = useState(0)
  const records = loadIntentInbox().slice(0, 10)

  const copyKw = () => {
    try { void Pasteboard.setString(KWS.join("、")); notify("已复制") } catch { notify("复制失败", "error") }
  }

  // 只有「通知直达」（linkIntentId）才整页显示关联页：那条入口没有上一页可 push。
  // 从记录行点进来的一律走 NavigationLink push（见下方列表），否则返回会直接退到「设置」。
  const [linking, setLinking] = useState<any | null>(() => {
    if (!linkIntentId) return null
    const r = loadIntentInbox().find(x => x.id === linkIntentId)
    return r && r.status !== "applied" ? r : null
  })

  const dropRecord = (id: string) => {
    removeIntentItem(id)
    setRev(x => x + 1)
  }

  if (linking) {
    // 通知直达：这里就是这一页的入口，关闭即回到记录列表
    return <LinkIntentPage item={linking} close={() => setLinking(null)}
      onDone={() => { setLinking(null); setRev(x => x + 1); bump() }} />
  }

  const hm = (t: number) => {
    const d = new Date(t)
    const p = (n: number) => String(n).padStart(2, "0")
    return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
  }

  const importShortcut = async (file: string) => {
    const p = `${Script.directory}/assets/shortcuts/${file}`
    if (!FileManager.existsSync(p)) { notify("文件缺失，请重新安装", "error"); return }
    try { await ShareSheet.present([p]) } catch { notify("无法打开分享面板", "error") }
  }

  const test = () => {
    const src = draft.trim()
    if (!src) { notify("请粘贴短信或截图文字", "warn"); return }
    const parsed = parseDeliveryText(src)
    pushIntentItem("text", parsed)
    const r = consumeIntentInbox()
    try { cleanStations() } catch { }
    setOut(`${summarizeParsed(parsed)}\n${r.applied > 0 ? "已写入包裹列表" : "没找到能对应的包裹"}`)
    setRev(x => x + 1)
    bump()
  }

  return (
    <SubPage title="快捷指令与自动化" onClose={close}>
      <Section title="能力" footer="识别在本机完成，不联网。">
        <Row icon="camera.viewfinder" title="截屏识别" detail="不需要截屏，快捷指令自己截" chevron={false} />
        <Row icon="text.bubble.fill" title="短信识别" detail="需先在「快捷指令」里建信息自动化" chevron={false} />
        <Row icon="square.and.arrow.down" title="分享图片" detail="分享面板把截图直接传给包裹助手" chevron={false} />
      </Section>

      <Section title="导入快捷指令" footer="导入即可用：短信自动收录，截屏自动识别，不打开 App。">
        {/* 导入是动作不是说明：用系统按钮，别写成一行灰字让人以为只是介绍 */}
        <Button title="点击导入「包裹助手·智能识别」" systemImage="square.and.arrow.down"
          action={() => void importShortcut("包裹助手·智能识别.shortcut")} />
        <Row icon="bolt.fill" title="打开快捷指令 App" chevron={false}
          onTap={() => { void Safari.openURL("shortcuts://") }} />
      </Section>

      <Section title="短信自动化" footer="驿站 App 的推送通知不是短信，不会触发。">
        <Row icon="1.circle.fill" title="快捷指令 → 自动化 → 新建个人自动化" chevron={false} />
        <Row icon="2.circle.fill" title="触发条件：信息" detail={`包含 ${KWS.join("、")} · 点此复制`} onTap={copyKw} chevron={false} />
        <Row icon="3.circle.fill" title="动作：运行快捷指令" detail="包裹助手智能识别" chevron={false} />
        <Row icon="4.circle.fill" title="关闭「运行前询问」" chevron={false} />
      </Section>

      <Section title="试一试" footer="粘贴取件短信，识别后写入列表。">
        <TextField title="" prompt="粘贴取件短信或截图文字" value={draft} onChanged={setDraft} />
        <Button title="识别并入库" systemImage="wand.and.stars" disabled={!draft.trim()} action={test} />
        {out ? <Row icon="checkmark.circle.fill" title={out.split("\n")[0]} detail={out.split("\n")[1]} chevron={false} /> : null}
      </Section>

      <Section title="识别记录" footer="共 10 条：普通 5 条、已关联 5 条。左滑可撤回或删除。">
        {records.length === 0
          ? <Row icon="tray" title="还没有记录" detail="搭好快捷指令后，识别过的内容会出现在这里" chevron={false} />
          : records.map(r => {
            // 来源 App：快捷指令用 CurrentApp 传过来的 bundle id / 名字（见 utils/appBrand）。
            // 认得平台就显平台图标，认不出就用状态图标，名字照旧写进副标题。
            const brand = brandOf(r.srcApp)
            const statusIcon = r.status === "applied" ? "checkmark.circle.fill" : r.status === "failed" ? "exclamationmark.circle.fill" : "clock.fill"
            const row = (
              <Row
                image={brand?.icon ? assetImage(brand.icon) : undefined}
                icon={brand?.icon ? undefined : statusIcon}
                title={summarizeParsed(r.parsed)}
                detail={`${brand ? `${brand.name} · ` : ""}${hm(r.at)} · ${r.status === "applied" ? "已入库" : r.status === "failed" ? "失败" : "待处理"}${r.note ? ` · ${r.note}` : ""}`}
                chevron={false}
              />
            )
            const swipe = {
              allowsFullSwipe: false,
              actions: [
                ...(r.linkedUuid ? [
                  <Button key="undo" title="撤回" action={() => {
                    const msg = undoIntentLink(r.id)
                    notify(msg)
                    setRev(x => x + 1)
                    bump()
                  }} />,
                ] : []),
                <Button key="del" title="删除" role="destructive" action={() => dropRecord(r.id)} />,
              ],
            }
            // 识别失败的记录可以手工关联到包裹：必须真 push（与账号授权页同构），
            // 原来这里是 setLinking 整页替换 —— 没有系统返回，返回直接退到「设置」。
            if (r.status === "failed" && r.parsed?.code) {
              return (
                <NavigationLink key={r.id} trailingSwipeActions={swipe}
                  destination={<LinkIntentPage item={r} pushed close={() => {}}
                    onDone={() => { setRev(x => x + 1); bump() }} />}>
                  {row}
                </NavigationLink>
              )
            }
            return (
              <Button key={r.id} buttonStyle="plain" frame={{ maxWidth: "infinity", alignment: "leading" }} contentShape="rect"
                action={() => { if (r.status === "failed") notify("该记录无取件码", "warn") }}
                trailingSwipeActions={swipe}>
                {row}
              </Button>
            )
          })}
      </Section>
    </SubPage>
  )
}

/** 取件码没找到对应包裹时，手动选一个待取包裹关联（可撤回） */
export function LinkIntentPage({ item, close, onDone, pushed }: {
  item: any; close: Closer; onDone: () => void
  /** push 进来时，关联成功后自己 dismiss 回上一级（记录列表）；整页替换的入口用 onDone 关掉自己 */
  pushed?: boolean
}) {
  const dismiss = Navigation.useDismiss()
  const [code, setCode] = useState<string>(item?.parsed?.code ?? "")
  const station: string = item?.parsed?.station ?? ""
  const list = getPickups().filter(p => p.status === 1 && !p.closed)

  const linkTo = (p: Pickup) => {
    const finalCode = code.trim()
    if (!finalCode) { notify("请填写取件码", "warn"); return }
    const merged = mergeCodes(p.codes ?? (p.code ? [p.code] : []), finalCode)
    // 旧数据里 code 可能存的是运单号：那不算真取件码，要用手填的这个替掉
    const oldCode = (p.code ?? "").trim()
    const codeIsMail = !!p.mailNo && oldCode.replace(/[\s-]/g, "").toLowerCase() === p.mailNo.replace(/[\s-]/g, "").toLowerCase()
    const setArrived = !p.arrivedAt
    updatePickup(p.uuid, {
      codes: merged,
      code: oldCode && !codeIsMail ? oldCode : finalCode,
      pickupCode: oldCode && !codeIsMail ? (p as any).pickupCode || oldCode : finalCode,
      ...(setArrived ? { arrivedAt: Date.now() } : {}),
      ...(station ? { courierStationName: station, address: station } : {}),
    } as any)
    markIntentApplied(item.id, `已关联到 ${p.itemTitle || p.mailNo || "包裹"}`, p.uuid, finalCode, setArrived)
    notify("已关联")
    onDone()
    // 关联完回记录列表（和位置提醒详情删除后一样，用 dismiss 回上一级）
    if (pushed) dismiss()
  }

  return (
    <SubPage title="关联到包裹" onClose={close}>
      <Section title="取件码" footer="识别有误可直接修改。">
        <TextField title="取件码" value={code} onChanged={setCode} />
      </Section>
      <Section title="选一个待取包裹" footer="关联后可在记录上左滑撤回或删除。">
        {list.length === 0
          ? <Row icon="tray" title="没有待取包裹" detail="请先同步一次" chevron={false} />
          : list.map(p => (
            <Row key={p.uuid}
              title={p.itemTitle || p.mailNo || "包裹"}
              detail={[p.mailNo, p.courierStationName || p.address].filter(Boolean).join(" · ")}
              onTap={() => linkTo(p)} />
          ))}
      </Section>
    </SubPage>
  )
}

// ---------------- 路由 ----------------
export function RouteHost({ route, close, bump, open, openSheet, closeSheet, modal, revision }: {
  route: any; close: Closer; bump: Closer; open: Opener; openSheet: Opener; closeSheet: Closer; modal?: boolean; revision: number
}) {
  const k = route?.kind ?? "none"
  const p = route?.props ?? {}
  void modal; void revision; void closeSheet
  const inner = routeInner(k, p, { close, bump, open, openSheet, revision })
  if (!inner) return null
  // 气泡只挂一处：sheet 内容层已经有一个 ToastHost（见 App.tsx），这里再挂就会同一句话弹两个
  return inner
}

function routeInner(k: string, p: any, ctx: { close: Closer; bump: Closer; open: Opener; openSheet: Opener; revision: number }): any {
  const { close, bump, open, openSheet, revision } = ctx
  if (k === "addLocation") return <AddLocationPage close={close} bump={bump} />
  if (k === "all") return <AllPickupsPage close={close} bump={bump} openSheet={openSheet} revision={revision} />
  if (k === "profile") return <ProfilePage close={close} bump={bump} open={open} revision={revision} />
  if (k === "kdLogin") return <KdniaoLoginPage close={close} bump={bump} />
  if (k === "reminderHub") return <ReminderSettingsPage close={close} bump={bump} openSheet={openSheet} />
  if (k === "locationDetail") return <LocationDetailPage id={p.id} close={close} bump={bump} />
  if (k === "identity") return <IdentityEntrySettings close={close} open={open} bump={bump} />
  if (k === "identityCode") return <IdentityCodeSheet id={p.id ?? "taobao"} close={close} open={open} />
  if (k === "qrLogin") return <QrLoginPage close={close} bump={bump} />
  if (k === "authorize") return <AuthorizePage close={close} bump={bump} open={open} />
  if (k === "fengchaoLogin") return <FengchaoLoginPage close={close} bump={bump}
    onDone={() => void syncPlatformParcels(undefined, { only: ["fengchao"], force: true }).catch(() => { })} />
  if (k === "miLogin") return <MiLoginPage close={close} bump={bump} />
  // pddMobiles 已并入平台详情页（PddMobileSection），旧路由删掉
  if (k === "nickname") return <NicknamePage close={close} bump={bump} />
  if (k === "station") return <StationPage close={close} bump={bump} />
  if (k === "trackSearch") return <TrackSearchSheet close={close} bump={bump} />
  if (k === "trackDetail") {
    const pkg = getPickups().find(x => x.uuid === p.uuid)
    return pkg ? <TrackDetailPage pkg={pkg} close={close} /> : <VStack />
  }
  if (k === "stationDetail") return <StationDetailPage name={p.name ?? ""} close={close} open={open} bump={bump} />
  if (k === "appearance") return <AppearancePage close={close} bump={bump} />
  if (k === "refreshRate") return <RefreshRatePage close={close} bump={bump} />
  if (k === "live") return <LivePage close={close} bump={bump} />
  if (k === "shortcuts") return <ShortcutsPage close={close} bump={bump} linkIntentId={p.linkIntentId} />
  if (k === "faq") return <FaqPage close={close} />
  if (k === "widget") return <WidgetPage close={close} bump={bump} />
  return null
}

import { LIVE_EXPIRY_OPTIONS } from "../store"

