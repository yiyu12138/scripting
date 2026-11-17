// 查快递：搜索框 + 历史（3 列，最多 9 条）+ 结果；右上角 + 加入包裹。
// 详情页：地图铺满顶部，内容上滑盖住地图。
import { Annotation, Button, Device, HStack, Image, Map, MapPolyline, Marker, NavigationStack, ProgressView, ScrollView, Spacer, Text, TextField, Toolbar, ToolbarItem, UnevenRoundedRectangle, VStack, ZStack, useColorScheme, useObservable, useEffect, useState } from "scripting"
import { assetImage } from "./assets"
import { PlatformMark } from "./platformMark"
import { sourceOf } from "../utils/model"
import { C, CAPSULE, CLOSED_TINT, GLASS, RR, alpha, companyName, glassFill } from "../theme"
// 顶部两角圆角、底部直角的面板形状
const TOP_PANEL = { type: "rect" as const, cornerRadii: { topLeading: 26, topTrailing: 26, bottomLeading: 0, bottomTrailing: 0 }, style: "continuous" as const }
// 面板顶边压住地图的高度：圆角两侧透出地图
const OVERLAP = 26
import { Icon, RoundButton } from "./kit"
import { phoneSpans } from "../utils/phone"
import { etaInText } from "../utils/eta"
import { mergeCodes, codeKey } from "../utils/codes"
import { notify } from "./notify"
import { CompanyLogo } from "./PickupRow"
import { notifyArrived } from "../utils/reminders"
import { arrivedAtOf } from "../utils/arrive"
import { addPickup, arrivalState, getPickups, matchStation, updatePickup, type Pickup } from "../store"
import {
  clearTrackHistory, companyIndex, extractPickupCode, getCodeFor, getPhoneFor, loadTrackHistory, pushTrackHistory,
  queryTracking, removeTrackHistory, saveCodeFor, savePhoneFor, statusLabel,
  type TrackHistoryItem, type TrackResult,
} from "../kdniao"
import { trackMailNo } from "../utils/cainiao"
import { pddTrack } from "../utils/pddExpress"
import { pddHasLogin } from "../utils/pdd"

type Closer = () => void

// 运行时是全局函数，类型里没声明
// 注意：不能用 scripting 的 Fetch 模块包装（直接用全局 fetch，真机测试 200/25 点/1.2s 可用）
declare const fetch: any

const STATUS_TINT: Record<string, string> = {
  delivered: "#34A853",
  transit: "#2D7BF6",
  none: "#8E8E93",
}

const CHIP_W = 0 // 已改为等分宽度，保留定义避免旧引用报错

/* ---------------- 查询 + 加入包裹 ---------------- */

export function TrackSearchSheet({ close, bump }: { close: Closer; bump: Closer }) {
  const [no, setNo] = useState("")
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState("")
  const [res, setRes] = useState<TrackResult | null>(null)
  const [history, setHistory] = useState<TrackHistoryItem[]>(loadTrackHistory())
  const [needPhone, setNeedPhone] = useState(false)
  const [phoneGate, setPhoneGate] = useState(false)
  const [phoneGateWrong, setPhoneGateWrong] = useState(false)
  const [phone, setPhone] = useState("")

  async function run(mailNo = no) {
    const n = mailNo.replace(/\s+/g, "")
    if (!n) { setMsg("先输入运单号"); return }
    setBusy(true); setMsg(""); setRes(null); setNeedPhone(false); setPhoneGate(false); setPhoneGateWrong(false)
    try {
      // 先走菜鸟：免登录、不需要任何凭证，节点也比快递鸟新；没节点或失败才用快递鸟兜底
      const cn = await trackMailNo(n).catch(() => null)
      if (cn && cn.nodes.length > 0) {
        const latest = cn.nodes[0]?.text ?? ""
        const r: TrackResult = {
          shipperCode: "",
          company: cn.company,
          state: "",
          status: /已签收|已送达|已取出|已领取/.test(latest) ? "delivered" : "transit",
          latest,
          nodes: cn.nodes.slice(0, 60).map(nd => ({ time: nd.time, text: nd.text })),
          source: "菜鸟",
        }
        setRes(r)
        pushTrackHistory({ mailNo: n, shipperCode: "", company: r.company, at: Date.now() })
        setHistory(loadTrackHistory())
        return
      }
      // 拼多多已授权时走它的官方物流接口：同样免费，菜鸟没节点时先比快递鸟快
      if (pddHasLogin()) {
        const pd = await pddTrack(n).catch(() => null)
        if (pd && pd.nodes.length > 0) {
          const latest = pd.nodes[0]?.text ?? ""
          const r: TrackResult = {
            shipperCode: "",
            company: pd.company,
            state: "",
            status: /已签收|已送达|已取出|已领取/.test(latest) ? "delivered" : "transit",
            latest,
            nodes: pd.nodes.slice(0, 60).map(nd => ({ time: nd.time, text: nd.text })),
            source: "拼多多",
          }
          setRes(r)
          pushTrackHistory({ mailNo: n, shipperCode: "", company: r.company, at: Date.now() })
          setHistory(loadTrackHistory())
          return
        }
      }
      const r = await queryTracking(n, {})
      setRes(r)
      pushTrackHistory({ mailNo: n, shipperCode: r.shipperCode, company: r.company, at: Date.now() })
      setHistory(loadTrackHistory())
      if (r.nodes.length === 0) setMsg("还没有轨迹，可能刚揽收")
    } catch (e: any) {
      if (e?.needPhone) {
        // 需要手机尾号：先进详情页，在详情页弹窗里补；错误时提示并让重填
        setRes({ shipperCode: "", company: "", state: "", status: "none", latest: "", nodes: [] })
        setPhoneGate(true)
        setPhoneGateWrong(!!e?.wrongPhone)
      } else {
        const text = String(e?.message ?? e)
        setMsg(text)
        notify(text, "error")
      }
    } finally {
      setBusy(false)
    }
  }

  function addToParcels() {
    if (!res) return
    const n = (no || "").replace(/\s+/g, "")
    const idx = companyIndex(res.shipperCode)
    // 驿站与取件码都从物流文案里推（现在没有短信导入）
    const station = matchStation(res.latest ?? "")
    const arrival = arrivalState(res.latest)
    const found = extractPickupCode(res.nodes) || getCodeFor(n)
    // 运单号不是取件码：没识别到真码就留空，界面上单独显示运单号
    const pickedCode = found && codeKey(found) !== codeKey(n) ? found : ""
    const eta = etaInText(res.latest ?? "")
    const exist = getPickups().find(p => (p.mailNo ?? p.code) === n)

    if (!exist) {
      const created = addPickup({
        code: pickedCode, codes: pickedCode ? [pickedCode] : [], companyName: idx, address: station?.name ?? "", phone: getPhoneFor(n), notes: res.latest,
        // 已领取→已取；否则进取件页等用户取
        status: arrival === "picked" ? 2 : 1,
        pickedAt: arrival === "picked" ? (arrivedAtOf(res.nodes) ?? Date.now()) : undefined,
        type: "delivery",
        smsContent: "", courierStationName: station?.name ?? "", courierStationUuid: station?.uuid ?? "",
        mailNo: n, shipperCode: res.shipperCode,
        trackCompany: res.company || companyName(idx),
        trackLatest: res.latest, trackNodes: res.nodes, trackUpdatedAt: Date.now(),
        arrivedAt: arrival === "arrived" ? arrivedAtOf(res.nodes) : undefined,
        source: "kdniao", receiverCity: res.receiverCity, receiverAddress: res.receiverAddress,
        eta,
      })
      // 手动添加时包裹已经到站，也得提醒一句
      if (arrival === "arrived") void notifyArrived(created)
    } else if (pickedCode) {
      // 包裹已在列表里：新识别到的码并进去（可能两个平台各给一个），不拆成第二条记录
      const base = (exist.codes ?? (exist.code ? [exist.code] : [])).filter(c => {
        const k = codeKey(c)
        return k !== codeKey(n) && k !== codeKey(exist.mailNo ?? "")
      })
      const merged = mergeCodes(base, pickedCode)
      if (merged.length > (exist.codes?.length ?? (exist.code ? 1 : 0))) {
        updatePickup(exist.uuid, {
          codes: merged,
          code: codeKey(exist.code) === codeKey(merged[0]) ? exist.code : merged[0],
        })
      }
    }
    bump(); close()
  }

  // 查到结果就直接进详情页，添加按钮放在详情页右上角
  if (res) {
    const n = no.replace(/\s+/g, "")
    const idx = companyIndex(res.shipperCode)
    const draft: Pickup = {
      uuid: "preview", code: extractPickupCode(res.nodes) && codeKey(extractPickupCode(res.nodes)) !== codeKey(n) ? extractPickupCode(res.nodes) : "", companyName: idx, address: "", phone: getPhoneFor(n), notes: res.latest,
      status: res.status === "delivered" ? 2 : 1, type: "delivery", codeTime: "", smsContent: "",
      courierStationName: "", courierStationUuid: "", createdAt: Date.now(),
      mailNo: n, shipperCode: res.shipperCode, trackCompany: res.company || companyName(idx),
      trackLatest: res.latest, trackNodes: res.nodes, trackUpdatedAt: Date.now(),
      source: "kdniao", receiverCity: res.receiverCity, receiverAddress: res.receiverAddress,
      eta: etaInText(res.latest ?? ""),
    }
    return (
      <TrackDetailPage pkg={draft} initial={res} standalone close={() => setRes(null)}
        needPhoneOnOpen={phoneGate} needPhoneWrong={phoneGateWrong}
        onAdd={addToParcels} />
    )
  }

  const rows: TrackHistoryItem[][] = []
  for (let i = 0; i < Math.min(history.length, 9); i += 3) rows.push(history.slice(i, i + 3))

  const chip = (h: TrackHistoryItem) => (
    <VStack key={h.mailNo} frame={{ maxWidth: "infinity", alignment: "leading" }}>
      <HStack spacing={2} frame={{ height: 38 }}
        padding={{ horizontal: 10 }}
        background={{ style: C.track, shape: CAPSULE }}>
        <Text font={12} foregroundStyle={C.text} lineLimit={1} minScaleFactor={0.7}
          contentShape="rect"
          onTapGesture={() => { setNo(h.mailNo); void run(h.mailNo) }}>
          {h.mailNo}
        </Text>
        <Button action={() => { removeTrackHistory(h.mailNo); setHistory(loadTrackHistory()) }}>
          <Icon name="xmark" size={10} color={C.tertiary} />
        </Button>
      </HStack>
    </VStack>
  )

  return (
    <ZStack frame={{ maxWidth: "infinity", maxHeight: "infinity" }} background={C.bg} ignoresSafeArea>
    <NavigationStack
      background={C.bg}
      toolbarBackgroundVisibility={{ visibility: "hidden", bars: ["navigationBar"] }}
      toolbarBackground={{ style: C.bg, bars: ["navigationBar"] }}>
      <ScrollView navigationTitle="查快递" navigationBarTitleDisplayMode="inline" scrollIndicator="never"
        background={C.bg}
        toolbar={
          <Toolbar>
            <ToolbarItem placement="cancellationAction">
              <Button title="取消" action={close} />
            </ToolbarItem>
          </Toolbar>
        }>
        <VStack alignment="leading" spacing={14} frame={{ maxWidth: "infinity", alignment: "leading" }}
          padding={{ horizontal: 16, top: 6, bottom: 40 }}>

          {/* 搜索条：和参考图一样的胶囊形输入框 */}
          <HStack spacing={8} frame={{ maxWidth: "infinity" }}
            padding={{ horizontal: 16, vertical: 13 }}
            background={{ style: C.searchField, shape: CAPSULE }}>
            <Icon name="magnifyingglass" size={18} color={C.text} />
            <TextField title="搜索运单号" value={no}
              onChanged={(v: string) => { setNo(v); setRes(null); setMsg("") }} />
            {no ? (
              <Button action={() => { setNo(""); setRes(null); setMsg("") }}>
                <Icon name="xmark.circle.fill" size={16} color={C.tertiary} />
              </Button>
            ) : null}
            {no.trim() ? (
              <Button disabled={busy} action={() => void run()}>
                <HStack spacing={5} padding={{ horizontal: 10, vertical: 7 }} contentShape="rect"
                  background={{ style: C.accent, shape: CAPSULE }}>
                  {busy
                    ? <ProgressView controlSize="small" tint="#FFFFFF" />
                    : <Icon name="magnifyingglass" size={12} color="#FFFFFF" />}
                  <Text font={13} fontWeight="semibold" foregroundStyle="#FFFFFF">
                    {busy ? "查询中" : "查询"}
                  </Text>
                </HStack>
              </Button>
            ) : null}
          </HStack>

          {msg ? <Text font={13} foregroundStyle={C.secondary}>{msg}</Text> : null}

          {rows.length > 0 ? (
            <>
              <HStack frame={{ maxWidth: "infinity" }} padding={{ top: 2 }}>
                <Text font={12} foregroundStyle={C.secondary} frame={{ maxWidth: "infinity", alignment: "leading" }}>
                  最近查询
                </Text>
                <Button action={() => { clearTrackHistory(); setHistory([]) }}>
                  <Text font={12} foregroundStyle={C.tertiary}>清除</Text>
                </Button>
              </HStack>
              <VStack spacing={6} frame={{ maxWidth: "infinity", alignment: "leading" }}>
                {rows.map((row, i) => (
                  <HStack key={i} spacing={6} frame={{ maxWidth: "infinity", alignment: "leading" }}>
                    {row.map(chip)}
                    {Array.from({ length: 3 - row.length }).map((_, k) => (
                      <VStack key={`sp-${k}`} frame={{ maxWidth: "infinity" }} />
                    ))}
                  </HStack>
                ))}
              </VStack>
            </>
          ) : null}
        </VStack>
      </ScrollView>
    </NavigationStack>
    </ZStack>
  )
}

/* ---------------- 地图 + 时间线 ---------------- */

type Pt = { name: string; latitude: number; longitude: number }

/** 常见城市坐标：先查本地表，不依赖网络，不会因为地理编码被限流就画不出路线 */
const CITY_COORDS: Record<string, [number, number]> = {
  北京: [39.9042, 116.4074], 上海: [31.2304, 121.4737], 广州: [23.1291, 113.2644], 深圳: [22.5431, 114.0579],
  东莞: [23.021, 113.7518], 佛山: [23.0215, 113.1214], 中山: [22.5176, 113.3928], 珠海: [22.2707, 113.5767],
  惠州: [23.1115, 114.4162], 汕头: [23.3541, 116.6822], 揭阳: [23.5497, 116.3728], 潮州: [23.6567, 116.6221],
  天津: [39.3434, 117.3616], 重庆: [29.563, 106.5516], 成都: [30.5728, 104.0668], 杭州: [30.2741, 120.1551],
  宁波: [29.8683, 121.544], 温州: [27.9938, 120.6994], 嘉兴: [30.7522, 120.75], 绍兴: [30.0023, 120.5811],
  金华: [29.0784, 119.6474], 台州: [28.6564, 121.4205], 南京: [32.0603, 118.7969], 苏州: [31.2989, 120.5853],
  无锡: [31.4912, 120.3119], 常州: [31.8107, 119.9741], 南通: [31.9802, 120.8943], 徐州: [34.2058, 117.2844],
  扬州: [32.3942, 119.4129], 合肥: [31.8206, 117.2272], 芜湖: [31.3525, 118.4331], 武汉: [30.5928, 114.3055],
  宜昌: [30.6919, 111.2865], 襄阳: [32.009, 112.1224], 长沙: [28.2282, 112.9388], 株洲: [27.8274, 113.1341],
  南昌: [28.682, 115.8579], 赣州: [25.8309, 114.935], 福州: [26.0745, 119.2965], 厦门: [24.4798, 118.0894],
  泉州: [24.8741, 118.6757], 济南: [36.6512, 117.1201], 青岛: [36.0671, 120.3826], 潍坊: [36.7069, 119.1618],
  烟台: [37.4638, 121.4479], 临沂: [35.1045, 118.3564], 郑州: [34.7466, 113.6254], 洛阳: [34.6197, 112.454],
  西安: [34.3416, 108.9398], 太原: [37.8706, 112.5489], 石家庄: [38.0428, 114.5149], 保定: [38.8671, 115.4845],
  邯郸: [36.6253, 114.5391], 邢台: [37.0708, 114.5048], 衡水: [37.7392, 115.6705], 沧州: [38.3045, 116.8387],
  唐山: [39.6304, 118.1802], 廊坊: [39.5377, 116.6837], 秦皇岛: [39.9354, 119.6005], 沈阳: [41.8057, 123.4315],
  大连: [38.914, 121.6147], 长春: [43.8171, 125.3235], 哈尔滨: [45.8038, 126.5349], 呼和浩特: [40.8424, 111.749],
  银川: [38.4872, 106.2309], 兰州: [36.0611, 103.8343], 西宁: [36.6171, 101.7782], 乌鲁木齐: [43.8256, 87.6168],
  拉萨: [29.652, 91.1721], 昆明: [25.0389, 102.7183], 贵阳: [26.647, 106.6302], 南宁: [22.817, 108.3669],
  柳州: [24.3264, 109.4281], 桂林: [25.2736, 110.29], 海口: [20.0444, 110.1999], 三亚: [18.2528, 109.5119],
  绵阳: [31.4675, 104.6796], 南充: [30.8378, 106.1104], 遵义: [27.7256, 106.9272], 义乌: [29.3069, 120.0754],
}

function lookupCity(raw: string): Pt | null {
  const key = raw.replace(/(特别行政区|自治州|地区|盟|市|县|区)$/, "").trim()
  const hit = CITY_COORDS[key] ?? CITY_COORDS[raw.trim()]
  if (!hit) return null
  return { name: key || raw, latitude: hit[0], longitude: hit[1] }
}

/** 轨迹文本 → 富文本：号码内联高亮且可点（点后确认呼叫）。
 *  Text 的 children 只接受字符串，分段要用 styledText，否则子元素会变成 [object Object]。 */
function nodeStyledText(text: string, color: any, exclude?: string) {
  // 已经识别为取件码的串不再当成电话高亮（避免码恰好形态像短号时冲突）
  const spans = phoneSpans(text, 3).filter(s => !exclude || s.phone !== exclude)
  const segs: any[] = []
  let last = 0
  for (const s of spans) {
    if (s.start > last) segs.push(text.slice(last, s.start))
    const p = s.phone
    segs.push({
      content: p,
      foregroundColor: C.accent,
      fontWeight: "semibold",
      onTapGesture: () => {
        Dialog.confirm({ title: "呼叫", message: p, confirmLabel: "呼叫" })
          .then((ok: boolean) => { if (ok) { try { void Safari.openURL(`tel://${p}`) } catch { } } })
          .catch(() => { })
      },
    })
    last = s.end
  }
  if (segs.length === 0) return { content: text, font: 14, foregroundColor: color }
  if (last < text.length) segs.push(text.slice(last))
  return { content: segs, font: 14, foregroundColor: color }
}

function nextHopCity(nodes: { text: string }[]): string {
  for (const n of nodes) {
    const m = n.text.match(/(?:发往|发至|下一站[:：]?)\s*([\u4e00-\u9fa5]{2,6}?市)/)
    if (m && m[1]) return m[1]
  }
  return ""
}

function extractCities(nodes: { text: string }[]): string[] {
  const out: string[] = []
  for (const n of nodes) {
    const re = /【([^】]{2,14})】/g
    let m: RegExpExecArray | null = re.exec(n.text)
    while (m != null) {
      const raw = m[1]
      // 必须是真行政区名（带 市/自治州/地区/盟）。中通轨迹里常见「【：95311】」这种
      // 客服热线括号，以前会被当成一个城市画进路线里
      const hit = raw.match(/^([\u4e00-\u9fa5]{2,6}?(?:市|自治州|地区|盟))/)
      if (hit) {
        const city = hit[1]
        if (!/月|日|时|号|点/.test(city) && !out.includes(city)) out.push(city)
      }
      m = re.exec(n.text)
    }
  }
  return out
}

function geoCache(name: string): Pt | null {
  const v = Storage.get<Pt>(`cc.geo.${name}`)
  return v && typeof v.latitude === "number" ? v : null
}

async function geocode(name: string): Promise<Pt | null> {
  const hit = geoCache(name)
  if (hit) return hit
  try {
    const list = await Location.geocodeAddress({ address: name, locale: "zh-CN" })
    const loc = list?.[0]?.location
    if (!loc) return null
    const pt: Pt = { name, latitude: loc.latitude, longitude: loc.longitude }
    try { Storage.set(`cc.geo.${name}`, pt) } catch { }
    return pt
  } catch { return null }
}

function routeFromNodes(nodes: { time?: string; text: string }[], extraCity?: string) {
  const list = extractCities(ascending(nodes as any)).slice(-6)
  pushCity(list, extraCity)
  const pts: Pt[] = []
  for (const c of list) {
    const hit = lookupCity(c)
    if (hit) pts.push(hit)
  }
  return { cities: list, points: pts }
}

/** 去掉市/区后缀，用来比较城市名 */
const normCity = (s: string) => (s || "").replace(/(特别行政区|自治州|地区|盟|市|县|区)$/, "").trim()

/** 从「西安市雁塔区科技路 3 号」这类文本里抽城市名 */
function cityOfText(s: string): string {
  const m = /([\u4e00-\u9fa5]{2,8}?(?:市|自治州|地区|盟))/.exec(s || "")
  return m ? m[1] : ""
}

/** 城市列表末尾补上收货地（已含则不重复） */
function pushCity(list: string[], extra?: string) {
  if (!extra) return
  if (list.some(c => normCity(c) === normCity(extra))) return
  list.push(extra)
}

/** 从轨迹里「派送至【XX】」拿收货地址（最新的那条优先），拿不到返回 null */
function destFromTrace(nodes: { time: string; text: string }[]): { city: string; address: string } | null {
  const asc = ascending(nodes)
  for (let i = asc.length - 1; i >= 0; i--) {
    const t = asc[i].text
    const m = /(?:派送至|派送到|送往|投递至|送至|已送达)\s*【([^】]{3,40})】/.exec(t)
    if (m) {
      const city = cityOfText(t) || cityOfText(m[1])
      return { city, address: city ? `${city}${m[1]}` : m[1] }
    }
  }
  return null
}

/** 把时间文本转成时间戳；解析不出来当 0
 *  淘宝物流节点的 subtitle 是「11-13 14:35」（只有月日）——旧实现只认带年份的，
 *  导致全部返回 0，倒序失效（最新的反被排到最下面）。 */
function tsOf(s: string): number {
  const t = (s || "").trim()
  const full = /(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})[ T](\d{1,2}):(\d{2})(?::(\d{2}))?/.exec(t)
  if (full) return new Date(+full[1], +full[2] - 1, +full[3], +full[4], +full[5], +(full[6] ?? 0)).getTime()
  const short = /(\d{1,2})[-/.](\d{1,2})\s+(\d{1,2}):(\d{2})(?::(\d{2}))?/.exec(t)
  if (short) {
    const now = Date.now()
    const make = (year: number) => new Date(year, +short[1] - 1, +short[2], +short[3], +short[4], +(short[5] ?? 0)).getTime()
    let ts = make(new Date().getFullYear())
    // 比现在晚一天以上：肯定是去年的日子（跨年订单）
    if (ts - now > 24 * 3600 * 1000) ts = make(new Date().getFullYear() - 1)
    return ts
  }
  return 0
}

/** 按时间升序（最早的在前），不依赖接口返回顺序 */
function ascending(nodes: { time: string; text: string }[]) {
  return [...nodes].sort((a, b) => tsOf(a.time) - tsOf(b.time))
}

const MAP_H = Math.max(240, Math.round(Device.screen.height * 0.44))
const SCREEN_H = Device.screen.height

/** 真实公路路线：OSRM 公开服务，结果按城市对缓存，失败就退回直线 */
const ROAD_KEY = "cc.track.road"

type LatLng = { latitude: number; longitude: number }

function roadCache(): Record<string, any> {
  try { const v = Storage.get(ROAD_KEY); return v && typeof v === "object" ? (v as any) : {} } catch { return {} }
}

/**
 * 把缓存/接口里的坐标统一成 {latitude, longitude}。
 * OSRM 返回的是 [经度, 纬度]；旧缓存读时当成了 [纬度, 经度]，
 * 画出来纬度 113 这种非法值，MapPolyline 直接不可见（就是“没线”的真因）。
 * 所以这里校验纬度范围，越界一律当成缓存无效去重新请求。
 */
function toCoords(raw: any): LatLng[] | null {
  if (!Array.isArray(raw) || raw.length < 2) return null
  const first = raw[0]
  let out: LatLng[]
  if (Array.isArray(first)) out = raw.map((v: number[]) => ({ latitude: v[1], longitude: v[0] }))
  else out = raw.map((v: any) => ({ latitude: v?.latitude, longitude: v?.longitude }))
  const bad = out.some(p =>
    typeof p.latitude !== "number" || typeof p.longitude !== "number" ||
    Math.abs(p.latitude) > 90 || Math.abs(p.longitude) > 180)
  return bad ? null : out
}

function roadKey(a: Pt, b: Pt) {
  return `${a.latitude.toFixed(1)},${a.longitude.toFixed(1)}-${b.latitude.toFixed(1)},${b.longitude.toFixed(1)}`
}

async function roadBetween(a: Pt, b: Pt): Promise<LatLng[]> {
  const key = roadKey(a, b)
  const cache = roadCache()
  if (cache[key]) {
    const hit = toCoords(cache[key])
    if (hit) return hit
    delete cache[key]
    try { Storage.set(ROAD_KEY, cache) } catch { }
  }
  try {
    const url = `https://router.project-osrm.org/route/v1/driving/${a.longitude},${a.latitude};${b.longitude},${b.latitude}?geometries=geojson&overview=simplified`
    // fetch 不带超时会一直挂着（不报错），外面就一直画不出线
    const r = await Promise.race([
      fetch(url),
      new Promise<never>((_, rej) => setTimeout(() => rej(new Error("timeout")), 3500)),
    ]) as any
    const j: any = await r.json()
    const coords: number[][] = j?.routes?.[0]?.geometry?.coordinates ?? []
    if (coords.length < 2) throw new Error("no route")
    cache[key] = coords
    try { Storage.set(ROAD_KEY, cache) } catch { }
    return coords.map(([lo, la]) => ({ latitude: la, longitude: lo }))
  } catch {
    return [{ latitude: a.latitude, longitude: a.longitude }, { latitude: b.latitude, longitude: b.longitude }]
  }
}

/** 正在开柜的包裹（柜机|格口|取件码|运单号）：拦重复点击 */
const OPENING = new Set<string>()

export function TrackDetailPage({ pkg, close, initial, standalone, onAdd, needPhoneOnOpen, needPhoneWrong, topGap = 8 }: {
  pkg: Pickup; close: Closer; initial?: TrackResult; standalone?: boolean; onAdd?: () => void
  /** 顶部按钮下移量：带导航栏的页（搜索流程）得避开系统按钮，不然点的是后面的“取消/关闭” */
  topGap?: number
  /** 搜索时就已判明要手机尾号：直接弹窗，不再重复查一次 */
  needPhoneOnOpen?: boolean
  /** 上一次填的尾号不对 */
  needPhoneWrong?: boolean
}) {
  const mailNo = pkg.mailNo ?? pkg.code
  const start = initial ?? (pkg.trackNodes && pkg.trackNodes.length > 0
    ? {
      shipperCode: pkg.shipperCode ?? "", company: pkg.trackCompany ?? "",
      state: "", status: (pkg.status === 2 ? "delivered" : "transit") as TrackResult["status"],
      latest: pkg.trackLatest ?? "", nodes: pkg.trackNodes,
    }
    : null)
  const isPlatform = pkg.source === "taobao" || pkg.source === "jd" || pkg.source === "pdd"
  const sourceLabel = isPlatform
    ? (pkg.source === "taobao" ? "淘宝" : pkg.source === "jd" ? "京东" : "拼多多")
    : "快递鸟"
  // 收货地：平台同步/快递鸟带回来的收货信息优先，其次从轨迹文字里找（不用驿站地址）
  const pkgDest = pkg.receiverCity
    ? { city: pkg.receiverCity, address: pkg.receiverAddress ?? "" }
    : (pkg.receiverAddress ? { city: cityOfText(pkg.receiverAddress), address: pkg.receiverAddress } : null)
  const cached = routeFromNodes(start?.nodes ?? [], pkgDest?.city || destFromTrace(start?.nodes ?? [])?.city)
  const [res, setRes] = useState<TrackResult | null>(start)
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState("")
  const [phone, setPhone] = useState(getPhoneFor(mailNo) || pkg.phone || "")
  const [needPhone, setNeedPhone] = useState(!!needPhoneOnOpen)
  const [phoneWrong, setPhoneWrong] = useState(!!needPhoneWrong)
  const [points, setPoints] = useState<Pt[]>(cached.points)
  const [cities, setCities] = useState<string[]>(cached.cities)
  /** 收货地城市名（有值时最后一个点就是收货地，而不是当前位置） */
  const [destName, setDestName] = useState(pkgDest?.city || "")
  const [segs, setSegs] = useState<{ coords: { latitude: number; longitude: number }[]; done: boolean }[]>([])
  const [routing, setRouting] = useState(false)
  const [copied, setCopied] = useState(false)
  const [copiedCode, setCopiedCode] = useState(false)
  const [codeEdit, setCodeEdit] = useState(false)
  const [codeDraft, setCodeDraft] = useState("")
  const [opening, setOpening] = useState(false)
  const [openMsg, setOpenMsg] = useState("")
  const [openFailed, setOpenFailed] = useState(false)
  // 手动备注（当商品名显示）：快递没带商品名时用户自己写一个
  const [titleEdit, setTitleEdit] = useState(false)
  const [titleDraft, setTitleDraft] = useState("")

  async function buildRoute(r: TrackResult) {
    setSegs([])
    setRouting(true)
    try {
      const asc = ascending(r.nodes)
      const list = extractCities(asc).slice(-6)
      // 目的地：接口/平台给的收货信息 > 轨迹里「派送至【…】」；两者都没有就不编
      const dest = (r.receiverCity
        ? { city: r.receiverCity, address: r.receiverAddress ?? "" }
        : (r.receiverAddress ? { city: cityOfText(r.receiverAddress), address: r.receiverAddress } : null))
        ?? pkgDest
        ?? destFromTrace(asc)
      if (dest?.city) pushCity(list, dest.city)
      setCities(list)
      setDestName(dest?.city || "")
      if (list.length === 0) { setPoints([]); return }
      const out: Pt[] = []
      for (let i = 0; i < list.length; i++) {
        const c = list[i]
        const isLast = i === list.length - 1
        // 收货地优先用完整地址定位（比城市中心准）
        if (isLast && dest?.address) {
          const precise = await geocode(dest.address).catch(() => null)
          if (precise) { out.push({ ...precise, name: c }); continue }
        }
        const local = lookupCity(c)
        if (local) { out.push(local); continue }
        try {
          const p = await geocode(c)
          if (p) out.push(p)
        } catch { }
      }
      if (out.length === 0) { setPoints([]); return }
      setPoints(out)
      if (out.length < 2) { setSegs([]); return }

      // 未到收货地：从当前位置到收货地那段用虚线。
      // 已签收的包裹全部段都走过 → 全实线；未签收时最后一段（当前位置→收货地）是虚线。
      const delivered = r.status === "delivered"
      const hasDestPoint = !!dest?.city && normCity(out[out.length - 1].name) === normCity(dest.city)
      const cur = delivered ? out.length - 1 : (hasDestPoint ? out.length - 2 : out.length - 1)
      const all = out
      const doneFlag = (i: number) => i + 1 <= cur

      // 拿真实公路路线；单段失败/超时就退回该段的直线，保证一定有线
      const roads = await Promise.all(all.slice(0, -1).map((a, i) => roadBetween(a, all[i + 1])))
      const segsOut = roads.map((coords, i) => ({ coords, done: doneFlag(i) }))
      setSegs(segsOut)
    } finally { setRouting(false) }
  }

  async function load(withPhone = phone) {
    // 平台授权的包裹只用平台同步的轨迹，不走快递鸟查询
    if (isPlatform) { setBusy(false); return }
    setBusy(true); setMsg("")
    try {
      const r = await queryTracking(mailNo, { shipperCode: pkg.shipperCode, phone: withPhone })
      setRes(r)
      setNeedPhone(false)
      void buildRoute(r)
    } catch (e: any) {
      if (e?.needPhone) {
        setNeedPhone(true)
        setPhoneWrong(!!e?.wrongPhone)
        setMsg(e?.wrongPhone ? "" : "")
      } else setMsg(String(e?.message ?? e))
      if (res) void buildRoute(res)
    } finally { setBusy(false) }
  }

  useEffect(() => {
    if (res && (res.nodes?.length ?? 0) > 0) void buildRoute(res)
    // 每次进详情都拉一次最新物流（先显示已有缓存，再替换成新结果）；
    // 要手机尾号时直接弹窗，不重复请求
    if (!needPhoneOnOpen) void load()
  }, [])

  const nodes = res ? ascending(res.nodes).reverse() : []
  // 当前所在城市在 points 里的下标（最后一个是收货地时往前退一位）
  const curIdx = (() => {
    if (points.length === 0) return 0
    const last = points[points.length - 1]
    const isDest = !!destName && points.length > 1 && normCity(last.name) === normCity(destName)
    return isDest ? points.length - 2 : points.length - 1
  })()
  const tint = STATUS_TINT[res?.status ?? "none"]
  const pickupCodes = mergeCodes(
    (pkg.codes ?? (pkg.code ? [pkg.code] : [])).filter(c => {
      const k = codeKey(c)
      return k !== codeKey(pkg.mailNo ?? "")
    }),
    extractPickupCode(res?.nodes ?? []),
    res?.pickupCode,
  ).filter(c => {
    const k = codeKey(c)
    return k !== codeKey(pkg.mailNo ?? "")
  })
  const pickupCode = pickupCodes[0] ?? ""
  const otherCodes = pickupCodes.slice(1)
  // 平台已退款/退货/取消：取件码位置改显状态字
  const closedLabel = (pkg.closed ?? "").trim()
  // 预计送达：先看这次拉到的文案，再看已存的（快递鸟 8001 不返回这个字段，所以经常为空）
  const etaText = etaInText(res?.latest ?? "") || pkg.eta || ""
  const hasData = (res?.nodes?.length ?? 0) > 0 || !!res?.latest

  const region = (() => {
    // 视角只看「当前所在 → 收货地」，已经走过的不再占画面
    const focus = curIdx > 0 && points.length - curIdx >= 1 ? points.slice(curIdx) : points
    if (focus.length === 0) return null
    const lats = focus.map(p => p.latitude), lngs = focus.map(p => p.longitude)
    const minLat = Math.min(...lats), maxLat = Math.max(...lats)
    const minLng = Math.min(...lngs), maxLng = Math.max(...lngs)
    return {
      center: { latitude: (minLat + maxLat) / 2, longitude: (minLng + maxLng) / 2 },
      span: { latitudeDelta: Math.max(maxLat - minLat, 0.05) * 1.6, longitudeDelta: Math.max(maxLng - minLng, 0.05) * 1.6 },
    }
  })()

  const cam = useObservable<MapCameraPosition>(MapCameraPosition.region(region ?? {
    center: { latitude: 34.5, longitude: 108.9 },
    span: { latitudeDelta: 20, longitudeDelta: 20 },
  }))
  // 只要操作的不是地图本身（点/滑卡片、按钮），就无条件回到默认视角。
  // 不比较当前相机：cam.value 读回来的是我们自己写进去的值，比较永远相等，
  // 之前的“自动回正”就是死在这里，从来没生效过。
  function restoreOverview() {
    if (!region) return
    cam.value = MapCameraPosition.region(region)
  }

  // 开柜防重：同一个包裹（柜机+格口+运单号）同一时刻只允许一个请求。
  // 用模块级 Set 而不是组件 state：重渲染/多开一层详情页也拦得住。
  // 而且每次只发这一件的柜机与格口，不会连带开其它柜门。
  async function openCabinet() {
    const box = pkg.fcBox
    if (!box || opening) return
    const key = [box.cabinetCode, box.boxId, box.code, box.expressId].join("|")
    if (OPENING.has(key)) return
    // 开柜不可撤销，先确认一次，并且把要开的是哪个柜机/格口写清楚，防误点
    const where = [box.cabinetCode, box.location || ""].filter(Boolean).join(" ")
    const ok = await Dialog.confirm({
      title: "打开柜门？",
      message: [
        pkg.trackCompany || box.companyName || "这个包裹",
        where ? `柜机/格口：${where}` : "",
        box.code ? `取件码：${box.code}` : "",
        "确认后柜门会直接弹开，请及时取出。",
      ].filter(Boolean).join("\n"),
      confirmLabel: "开柜",
      cancelLabel: "取消",
    } as any)
    if (!ok) return
    if (OPENING.has(key)) return
    OPENING.add(key)
    setOpening(true)
    setOpenFailed(false)
    setOpenMsg("正在开柜…")
    try {
      const { fcOpenBox } = await import("../utils/fengchao")
      await fcOpenBox(box)
      setOpenMsg("柜门已开，请取件")
      setTimeout(() => setOpenMsg(""), 6000)
    } catch (e: any) {
      const text = String(e?.message ?? e)
      setOpenFailed(true)
      // 文案太长就截断，气泡本身不限行数但别挡住地图
      setOpenMsg(text.length > 40 ? text.slice(0, 40) + "…" : text)
      setTimeout(() => { setOpenMsg(""); setOpenFailed(false) }, 8000)
    } finally {
      OPENING.delete(key)
      setOpening(false)
    }
  }

  const scheme = useColorScheme()
  // 地图上的胶囊要随明暗切换，否则浅色地图上白字看不清
  const chipBg = scheme === "dark" ? "rgba(28,28,30,0.95)" : "rgba(255,255,255,0.96)"
  const chipText = scheme === "dark" ? "#FFFFFF" : "#1C1C1E"
  const currentLabel = "当前位置"

  const content = (
    <ZStack frame={{ maxWidth: "infinity", maxHeight: "infinity" }}
      background={C.bg}
      ignoresSafeArea
      toolbarBackgroundVisibility={{ visibility: "hidden", bars: ["navigationBar"] }}
      navigationTitle="物流详情" navigationBarTitleDisplayMode="inline"
      toolbarVisibility={standalone ? { visibility: "hidden", bars: ["navigationBar"] } : undefined}>
      {/* 地图在滚动内容里：上拉卡片时地图被推上去，地图区本身可缩放拖动 */}
      <ScrollView scrollIndicator="never" background={undefined as any}
        blur={needPhone ? 6 : 0}
        onScrollPhaseChange={(_o: any, n: any) => { if (n === "interacting") restoreOverview() }}>
        <VStack alignment="leading" spacing={0} frame={{ maxWidth: "infinity", alignment: "leading" }}>
        <ZStack frame={{ maxWidth: "infinity", height: MAP_H }}>
        <Map cameraPosition={cam}
          mapStyle={{ style: "standard" }}
          annotationTitles="hidden"
          frame={{ width: "infinity" as any, height: MAP_H }}>
            {segs.map((s, i) => (
              <MapPolyline key={`seg-${i}`} coordinates={s.coords}
                strokeColor={s.done ? "#1F6FEB" : "rgba(31,111,235,0.6)"}
                strokeStyle={s.done
                  ? { lineWidth: 5, lineCap: "round", lineJoin: "round" }
                  : { lineWidth: 5, lineCap: "round", lineJoin: "round", dash: [8, 8] }} />
            ))}
            {points.map((p, i) => {
              const ci = curIdx
              const isCurrent = i === ci
              const isDest = i === points.length - 1 && i > ci
              const isFirst = i === 0 && !isCurrent && !isDest
              return (
                <Annotation key={`${p.name}-${i}`} coordinate={{ latitude: p.latitude, longitude: p.longitude }} anchor="bottom">
                  <VStack spacing={6}>
                    {isCurrent ? (
                      <HStack spacing={4} padding={{ horizontal: 9, vertical: 4 }}
                        background={{ style: chipBg as any, shape: CAPSULE }}
                        shadow={{ color: "rgba(0,0,0,0.2)", radius: 4, y: 1 }}>
                        <Text font={11} fontWeight="semibold" foregroundStyle={chipText}>{currentLabel}</Text>
                      </HStack>
                    ) : isDest ? (
                      <HStack spacing={4} padding={{ horizontal: 9, vertical: 4 }}
                        background={{ style: "rgba(52,168,83,0.95)" as any, shape: CAPSULE }}
                        shadow={{ color: "rgba(0,0,0,0.2)", radius: 4, y: 1 }}>
                        <Text font={11} fontWeight="semibold" foregroundStyle="#FFFFFF">收货地</Text>
                      </HStack>
                    ) : isFirst ? (
                      <HStack spacing={4} padding={{ horizontal: 9, vertical: 4 }}
                        background={{ style: chipBg as any, shape: CAPSULE }}
                        shadow={{ color: "rgba(0,0,0,0.15)", radius: 4, y: 1 }}>
                        <Text font={11} fontWeight="semibold" foregroundStyle={chipText}>发货地</Text>
                      </HStack>
                    ) : null}
                    {isCurrent ? (
                      <VStack frame={{ width: 38, height: 38 }}
                        background={{ style: C.accent, shape: RR(13) }}
                        shadow={{ color: "rgba(0,0,0,0.27)", radius: 8, y: 3 }}>
                        <Icon name="shippingbox.fill" size={19} color="#FFFFFF" />
                      </VStack>
                    ) : isDest ? (
                      <VStack frame={{ width: 30, height: 30 }}
                        background={{ style: "#FFFFFF" as any, shape: RR(15) }}
                        shadow={{ color: "rgba(0,0,0,0.22)", radius: 6, y: 2 }}>
                        <VStack frame={{ width: 22, height: 22 }}
                          background={{ style: "#34A853", shape: RR(11) }}>
                          <Icon name="house.fill" size={11} color="#FFFFFF" />
                        </VStack>
                      </VStack>
                    ) : isFirst ? (
                      <VStack frame={{ width: 22, height: 22 }}
                        background={{ style: "#FFFFFF" as any, shape: RR(11) }}
                        shadow={{ color: "rgba(0,0,0,0.22)", radius: 5, y: 2 }}>
                        <VStack frame={{ width: 10, height: 10 }}
                          background={{ style: C.accent, shape: RR(5) }} />
                      </VStack>
                    ) : (
                      <VStack frame={{ width: 13, height: 13 }}
                        background={{ style: "#FFFFFF" as any, shape: RR(7) }}
                        shadow={{ color: "rgba(0,0,0,0.18)", radius: 3, y: 1 }}>
                        <VStack frame={{ width: 5, height: 5 }} background={{ style: "#9A9AA0", shape: RR(3) }} />
                      </VStack>
                    )}
                  </VStack>
                </Annotation>
              )
            })}
        </Map>
          {routing && segs.length === 0 ? (
            <VStack frame={{ maxWidth: "infinity", maxHeight: "infinity", alignment: "bottomLeading" }}
              padding={{ leading: 14, bottom: 40 }}>
              <HStack spacing={6} padding={{ horizontal: 12, vertical: 6 }}
                background={{ style: "rgba(0,0,0,0.45)" as any, shape: CAPSULE }}>
                <Text font={12} foregroundStyle="#FFFFFF">正在生成路线</Text>
              </HStack>
            </VStack>
          ) : null}
        </ZStack>

      {/* 面板顶边往上压 OVERLAP，圆角两侧透出地图 */}
      <VStack spacing={0} frame={{ maxWidth: "infinity" }} padding={{ top: -OVERLAP }}>
      <VStack alignment="leading" spacing={0} frame={{ maxWidth: "infinity", alignment: "topLeading", minHeight: SCREEN_H - MAP_H + OVERLAP }}
        padding={{ horizontal: 16, top: 20, bottom: 40 }}
        contentShape="rect"
        onTapGesture={restoreOverview}
        background={{ style: C.card, shape: TOP_PANEL }}
        shadow={{ color: "rgba(0,0,0,0.25)", radius: 18, y: -6 }}>
            <HStack spacing={10} frame={{ maxWidth: "infinity", alignment: "leading" }}>
              <CompanyLogo code={pkg.companyName} hint={res?.company || pkg.trackCompany} size={36} />
              <VStack alignment="leading" spacing={2} frame={{ maxWidth: "infinity", alignment: "leading" }}>
                <HStack spacing={8}>
                  <Text font={17} fontWeight="semibold" foregroundStyle={C.text}>
                    {res?.company || pkg.trackCompany || "快递"}
                  </Text>
                  <Text font={11} fontWeight="semibold" foregroundStyle={tint as any}
                    padding={{ horizontal: 7, vertical: 2 }}
                    background={{ style: alpha(tint, 0.16), shape: RR(8) }}>
                    {res?.latest || (res?.nodes?.length ?? 0) > 0
                      ? statusLabel(res?.status ?? "none")
                      : "查询中"}
                  </Text>
                </HStack>
                <HStack spacing={6}>
                  <Text font={13} foregroundStyle={C.secondary}>{mailNo}</Text>
                  <Button action={() => {
                    void Pasteboard.setString(mailNo)
                    setCopied(true)
                    setTimeout(() => setCopied(false), 1200)
                  }}>
                    <Text font={12} foregroundStyle={C.accent}>{copied ? "已复制" : "复制"}</Text>
                  </Button>
                </HStack>
              </VStack>
            </HStack>

                {(pkg.userTitle || pkg.itemTitle) ? (
              <HStack spacing={6} padding={{ top: 12 }} frame={{ maxWidth: "infinity", alignment: "leading" }}
                onTapGesture={() => { setTitleDraft(pkg.userTitle || ""); setTitleEdit(true) }} contentShape="rect">
                <PlatformMark source={sourceOf(pkg)} size={14} />
                <Text font={14} foregroundStyle={pkg.userTitle ? C.text : C.secondary} lineLimit={2}>
                  {pkg.userTitle || pkg.itemTitle || ""}
                </Text>
                <Icon name="square.and.pencil" size={12} color={C.tertiary} />
              </HStack>
            ) : (
              <HStack spacing={6} padding={{ top: 12 }} frame={{ maxWidth: "infinity", alignment: "leading" }}
                onTapGesture={() => { setTitleDraft(""); setTitleEdit(true) }} contentShape="rect">
                <Icon name="square.and.pencil" size={12} color={C.tertiary} />
                <Text font={13} foregroundStyle={C.tertiary}>添加备注，当商品名显示</Text>
              </HStack>
            )}

            {(pkg.receiverName || pkg.receiverPhone || pkg.receiverAddress || pkg.receiverCity) ? (
              <HStack spacing={6} padding={{ top: 10 }} frame={{ maxWidth: "infinity", alignment: "leading" }}>
                <Icon name="house.fill" size={12} color={C.secondary} />
                {/* 一行内：姓名 掩码手机号 详细地址；地址放不下就尾部省略 */}
                <Text font={12} foregroundStyle={C.secondary} lineLimit={1} truncationMode="tail"
                  frame={{ maxWidth: "infinity", alignment: "leading" }}>
                  {[
                    [pkg.receiverName, pkg.receiverPhone].filter(Boolean).join(" "),
                    pkg.receiverAddress || pkg.receiverCity || "",
                  ].filter(Boolean).join("  ")}
                </Text>
              </HStack>
            ) : null}

            {etaText ? (
              <HStack spacing={5} padding={{ top: 10 }} frame={{ maxWidth: "infinity", alignment: "leading" }}>
                <Icon name="clock.badge.checkmark" size={12} color={C.blue} />
                <Text font={12} foregroundStyle={C.blue} lineLimit={1}>{etaText}</Text>
              </HStack>
            ) : null}

            {closedLabel ? (
              <HStack spacing={10} frame={{ maxWidth: "infinity" }} padding={{ top: 16 }}>
                <VStack alignment="leading" spacing={2} frame={{ maxWidth: "infinity", alignment: "leading" }}>
                  <Text font={11} foregroundStyle={C.tertiary}>取件码</Text>
                  <Text font={22} fontWeight="bold" foregroundStyle={CLOSED_TINT}>{closedLabel}</Text>
                  {pkg.courierStationName ? (
                    <Text font={12} foregroundStyle={C.secondary}>{pkg.courierStationName}</Text>
                  ) : null}
                </VStack>
                <Icon name="xmark.circle.fill" size={20} color={CLOSED_TINT} />
              </HStack>
            ) : pickupCode ? (
              <HStack spacing={10} frame={{ maxWidth: "infinity" }} padding={{ top: 16 }}>
                <VStack alignment="leading" spacing={2} frame={{ maxWidth: "infinity", alignment: "leading" }}>
                  <Text font={11} foregroundStyle={C.tertiary}>取件码</Text>
                  <Text font={26} fontWeight="bold" foregroundStyle={C.accent}>{pickupCode}</Text>
                  {otherCodes.length > 0 ? (
                    <Text font={15} fontWeight="semibold" foregroundStyle={C.secondary} lineLimit={1}>
                      {otherCodes.join(" · ")}
                    </Text>
                  ) : null}
                  {pkg.courierStationName ? (
                    <Text font={12} foregroundStyle={C.secondary}>{pkg.courierStationName}</Text>
                  ) : null}
                </VStack>
                <Button action={() => {
                  void Pasteboard.setString(pickupCode)
                  setCopiedCode(true)
                  setTimeout(() => setCopiedCode(false), 1200)
                }}>
                  <HStack spacing={4} padding={{ horizontal: 11, vertical: 7 }} contentShape="rect"
                    background={{ style: C.track, shape: CAPSULE }}>
                    <Icon name="doc.on.doc" size={11} color={C.accent} />
                    <Text font={12} fontWeight="semibold" foregroundStyle={C.accent}>
                      {copiedCode ? "已复制" : "复制"}
                    </Text>
                  </HStack>
                </Button>
              </HStack>
            ) : null}

            {!pickupCode && !closedLabel && res?.status === "delivered" ? (
              <HStack spacing={10} frame={{ maxWidth: "infinity" }} padding={{ top: 14 }}>
                <VStack alignment="leading" spacing={2} frame={{ maxWidth: "infinity", alignment: "leading" }}>
                  <Text font={11} foregroundStyle={C.tertiary}>取件码</Text>
                  <Text font={15} foregroundStyle={C.secondary}>暂无取件码</Text>
                </VStack>
                <Icon name="qrcode" size={20} color={C.tertiary} />
              </HStack>
            ) : null}

            {/* 最新一条轨迹不在这里重复，时间线首条就是它 */}
            {!hasData && !needPhone ? (
              <VStack spacing={12} frame={{ maxWidth: "infinity" }} padding={{ vertical: 44 }}>
                <ProgressView controlSize="regular" />
                <Text font={13} foregroundStyle={C.secondary}>正在查询物流信息</Text>
              </VStack>
            ) : msg ? (
              <Text font={13} foregroundStyle={C.red} padding={{ top: 12 }}>{msg}</Text>
            ) : null}

            {cities.length > 0 ? (
              <HStack spacing={7} frame={{ maxWidth: "infinity", alignment: "leading" }} padding={{ top: 14 }}>
                {cities.map((c, i) => (
                  <HStack key={`${c}-${i}`} spacing={7}>
                    <Text font={14} fontWeight={i === cities.length - 1 ? "semibold" : "regular"}
                      foregroundStyle={i === cities.length - 1 ? C.accent : C.text}>{c}</Text>
                    {i < cities.length - 1 ? <Icon name="chevron.forward" size={10} color={C.tertiary} /> : null}
                  </HStack>
                ))}
              </HStack>
            ) : null}

            <HStack frame={{ maxWidth: "infinity" }} padding={{ top: 20, bottom: 14 }}>
              <Text font={16} fontWeight="semibold" foregroundStyle={C.text}>物流轨迹</Text>
              <VStack frame={{ maxWidth: "infinity" }} />
              {res?.source || isPlatform ? (
                <Text font={11} foregroundStyle={C.tertiary}>数据来源 {sourceLabel}</Text>
              ) : null}
            </HStack>
            {nodes.length === 0 ? (
              <Text font={13} foregroundStyle={C.secondary}>{busy ? "正在查询…" : "暂无轨迹"}</Text>
            ) : (
              <VStack alignment="leading" spacing={16} frame={{ maxWidth: "infinity", alignment: "leading" }}>
                {nodes.map((n, i) => (
                  <HStack key={`${n.time}-${i}`} spacing={11} frame={{ maxWidth: "infinity", alignment: "leading" }}>
                    <VStack frame={{ width: 9 }}>
                      <VStack frame={{ width: i === 0 ? 9 : 7, height: i === 0 ? 9 : 7 }}
                        background={{ style: i === 0 ? C.accent : C.tertiary, shape: RR(5) }} />
                    </VStack>
                    <VStack alignment="leading" spacing={4} frame={{ maxWidth: "infinity", alignment: "leading" }}>
                      {/* Text 只接受字符串子元素，富文本要用 styledText，否则子元素会被转成 [object Object] */}
                      <Text styledText={nodeStyledText(n.text, i === 0 ? C.text : C.secondary, pickupCode || undefined)} lineSpacing={2} />
                      <Text font={12} foregroundStyle={C.tertiary}>{n.time}</Text>
                    </VStack>
                  </HStack>
                ))}
              </VStack>
            )}
          </VStack>
      </VStack>
        </VStack>
      </ScrollView>

      {standalone ? (
        <VStack frame={{ maxWidth: "infinity", maxHeight: "infinity", alignment: "top" }}
          padding={{ horizontal: 16, top: topGap }}>
          <HStack spacing={0} frame={{ maxWidth: "infinity" }}>
            <RoundButton icon="chevron.left" size={44} iconSize={17} withShadow onTap={close} />
            <Spacer />
            {onAdd ? <RoundButton icon="plus" size={44} iconSize={19} withShadow onTap={onAdd} /> : null}
          </HStack>
        </VStack>
      ) : null}

      {pkg.fcBox ? (
        <VStack frame={{ maxWidth: "infinity", maxHeight: "infinity", alignment: "bottomTrailing" }}
          padding={{ horizontal: 20, bottom: 120 }} spacing={0}>
          <HStack spacing={10} alignment="center">
            {/* 状态气泡：开柜中/成功/失败都在这里说一句，失败用红字 */}
            {openMsg ? (
              <HStack padding={{ horizontal: 12, vertical: 8 }}
                background={{ style: glassFill(), shape: CAPSULE }}
                glassEffect={GLASS.topButton}
                shadow={{ color: "rgba(0,0,0,0.16)", radius: 10, y: 3 }}>
                <Text font={13} fontWeight="medium" lineLimit={2}
                  foregroundStyle={openFailed ? C.red : C.text}>{openMsg}</Text>
              </HStack>
            ) : null}
            {/* 圆形玻璃按钮，宽度固定：转圈时不跳位，开柜中禁点 */}
            <VStack spacing={1} frame={{ width: 64, height: 64 }}
              background={{ style: glassFill(), shape: "circle" }}
              glassEffect={GLASS.floating}
              shadow={{ color: "rgba(0,0,0,0.18)", radius: 12, y: 4 } as any}
              opacity={opening ? 0.55 : 1}
              onTapGesture={openCabinet}
              contentShape="rect">
              {opening
                ? <ProgressView controlSize="small" />
                : (
                  <>
                    <Image systemName={openFailed ? "exclamationmark.lock" : "lock.open"} font={19} fontWeight="semibold"
                      foregroundStyle={openFailed ? C.red : C.text} />
                    <Text font={9} fontWeight="medium" foregroundStyle={openFailed ? C.red : C.text}>开柜</Text>
                  </>
                )}
            </VStack>
          </HStack>
        </VStack>
      ) : null}

      {titleEdit ? (
        <VStack frame={{ maxWidth: "infinity", maxHeight: "infinity" }}
          background={{ style: "rgba(0,0,0,0.5)", shape: RR(0) }}>
          <VStack spacing={14} padding={18} frame={{ width: 300 }}
            glassEffect={{ glass: UIGlass.regular(), shape: RR(26) }}
            shadow={{ color: "rgba(0,0,0,0.27)", radius: 28, y: 10 }}>
            <VStack alignment="leading" spacing={4} frame={{ maxWidth: "infinity", alignment: "leading" }}>
              <Text font={16} fontWeight="semibold" foregroundStyle={C.text}>备注</Text>
              <Text font={12} foregroundStyle={C.secondary}>填了就在列表里当商品名显示，留空恢复原来的名字</Text>
            </VStack>
            <HStack frame={{ maxWidth: "infinity" }} padding={{ horizontal: 12, vertical: 9 }}
              glassEffect={{ glass: UIGlass.clear(), shape: RR(12) }}>
              <TextField title="备注" prompt="比如：洗衣液" value={titleDraft}
                onChanged={(v: string) => setTitleDraft(v.slice(0, 24))} />
            </HStack>
            <HStack spacing={10} frame={{ maxWidth: "infinity" }}>
              <Button title="取消" buttonStyle="bordered" action={() => setTitleEdit(false)} />
              <Button title="保存" buttonStyle="borderedProminent" tint={C.accent}
                action={() => {
                  updatePickup(pkg.uuid, { userTitle: titleDraft.trim() || undefined })
                  setTitleEdit(false)
                }} />
            </HStack>
          </VStack>
        </VStack>
      ) : null}

      {needPhone ? (
        <VStack frame={{ maxWidth: "infinity", maxHeight: "infinity" }}
          background={{ style: "rgba(0,0,0,0.5)", shape: RR(0) }}>
          <VStack spacing={14} padding={18} frame={{ width: 300 }}
            glassEffect={{ glass: UIGlass.regular(), shape: RR(26) }}
            shadow={{ color: "rgba(0,0,0,0.27)", radius: 28, y: 10 }}>
            <VStack alignment="leading" spacing={4} frame={{ maxWidth: "infinity", alignment: "leading" }}>
              <Text font={16} fontWeight="semibold" foregroundStyle={C.text}>
                {phoneWrong ? "手机号后四位不正确，请重新输入" : "请输入收货人手机号后四位"}
              </Text>
              <Text font={12} foregroundStyle={C.secondary}>{mailNo}</Text>
            </VStack>
            <HStack frame={{ maxWidth: "infinity" }} padding={{ horizontal: 12, vertical: 9 }}
              glassEffect={{ glass: UIGlass.clear(), shape: RR(12) }}>
              <TextField title="手机号后四位" value={phone}
                onChanged={(v: string) => setPhone(v.replace(/\D/g, "").slice(0, 4))}
                keyboardType="phonePad" />
            </HStack>
            <HStack spacing={10} frame={{ maxWidth: "infinity" }}>
              <Button title="取消" buttonStyle="bordered"
                action={() => { setNeedPhone(false); if (nodes.length === 0) close() }} />
              <Button title="确定" buttonStyle="borderedProminent" tint={C.accent}
                disabled={phone.length !== 4}
                action={() => { savePhoneFor(mailNo, phone); setPhoneWrong(false); setNeedPhone(false); void load(phone) }} />
            </HStack>
          </VStack>
        </VStack>
      ) : null}
    </ZStack>
  )

  return standalone ? (
    <NavigationStack background={C.bg}
      toolbarBackgroundVisibility={{ visibility: "hidden", bars: ["navigationBar"] }}>
      {content}
    </NavigationStack>
  ) : content
}
