import { COOKIE_KEY, Pkg, Snapshot, classify, closedOrderStatus, timeOfTrack, isHistoricalPkg, statusFromCode } from "./model"

/** 运行时全局 fetch（类型声明里没导出，跟 Response 情况一样） */
declare const fetch: any
/** setTimeout 在类型里签名不同，包一层 */
const delay = (ms: number) => new Promise<void>(resolve => (setTimeout as any)(resolve, ms))

/** 页面加载加超时：淘宝部分页会一直转圈不触发完成，不设超时会把同步拖死 */
function pageTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = (setTimeout as any)(() => reject(new Error("页面超时")), ms)
    p.then(v => { clearTimeout(t); resolve(v) }, e => { clearTimeout(t); reject(e) })
  })
}

const UA = "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1"

const LOGISTICS_URL = (orderId: string) =>
  `https://pages-g.m.taobao.com/wow/z/app/mtb/logisticsV2/h5-detail?x-ssr=true&bizOrderId=${orderId}&viewLogisticDetail=true&skipEnterAnimation=true&forceThemis=true&disableNav=YES`

const ODETAIL_URL = (orderId: string) =>
  `https://m.m.taobao.com/wow/z/app/tb-trade/odetail/h5-home?x-ssr=true&orderId=${orderId}&forceThemis=true&disableNav=YES&status_bar_transparent=true&openFrom=taoBoughtList`

/* ---------------- 登录态 ---------------- */

export function getCookies(): any[] {
  const raw = Keychain.get(COOKIE_KEY)
  if (!raw) return []
  try {
    const v = JSON.parse(raw)
    return Array.isArray(v) ? v : []
  } catch { return [] }
}

export function hasLogin(): boolean {
  // 只认真正的登录凭证：登录页本身就会下发 _tb_token_/cookie2 这类匿名 cookie，
  // 拿「有 cookie」当已登录会让 mtop 一路 FAIL_SYS_SESSION_EXPIRED
  return getCookies().some((c: any) => ["unb", "tracknick"].includes(String(c.name)) && !!c.value)
}


export function cookieHeader(): string {
  return getCookies().map((c: any) => `${c.name}=${c.value}`).join("; ")
}

/** 打开淘宝官方登录页（账号密码 / 短信），登录后把 Cookie 存进钥匙串。扫码登录见 utils/qrlogin.ts */
export async function loginTaobao(): Promise<boolean> {
  const controller = new WebViewController()
  try {
    await controller.loadURL("https://login.taobao.com/member/login.jhtml")
    await controller.present({ fullscreen: true, navigationTitle: "登录淘宝（登录后点完成）" })
    const cookies = await controller.getAllCookies()
    const usable = (cookies || []).filter((c: any) => /taobao|tmall|alibaba/.test(String(c.domain || "")))
    const logged = (cookies || []).some((c: any) => ["unb", "tracknick"].includes(String(c.name)) && !!c.value)
    if (!logged || usable.length === 0) return false
    Keychain.set(COOKIE_KEY, JSON.stringify(usable))
    return true
  } finally {
    try { controller.dispose() } catch { }
  }
}

/* ---------------- 解析 ---------------- */

function unescapeJson(value: string): string {
  try { return JSON.parse(`"${value}"`) } catch { return value }
}

function firstMatch(html: string, re: RegExp): string {
  const m = html.match(re)
  return m ? unescapeJson(m[1]) : ""
}

/** 订单详情页 → 商品标题 / 店铺名 / 订单状态 */
export function parseOrder(html: string): { itemTitle: string; shopName: string; orderStatus: string } {
  const titles = [...html.matchAll(/"itemTitle":"([^"]{4,140})"/g)]
    .map(m => unescapeJson(m[1]))
    .filter(t => !/如发生争议/.test(t) && !/^\s*$/.test(t))
    .sort((a, b) => b.length - a.length)
  return {
    itemTitle: titles[0] || "",
    shopName: firstMatch(html, /"shopName":"([^"]{1,60})"/),
    orderStatus: parseOrderStatus(html),
  }
}

/** 只读明确的订单状态字段，避开「申请退款 / 取消订单」这类操作按钮文案 */
export function parseOrderStatus(html: string): string {
  const values = [...html.matchAll(/"(?:statusText|statusDesc|statusTitle|orderStatusText|orderStatusDesc|tradeStatusText|mainStatusText)"\s*:\s*"((?:\\.|[^"\\])*)"/g)]
    .map(m => unescapeJson(m[1]))
  // 订单详情头部常把主状态放在 statusInfo 的 text/title 字段里
  const blocks = [...html.matchAll(/"(?:statusInfo|orderStatusInfo|tradeStatusInfo)"\s*:\s*\{([^{}]{0,1500})\}/g)]
  for (const block of blocks) {
    const text = firstMatch(block[1], /"(?:text|title|value)"\s*:\s*"((?:\\.|[^"\\])*)"/)
    if (text) values.push(text)
  }
  return values.find(v => closedOrderStatus(v)) || values.find(v => !/^\d+$/.test(v)) || ""
}

/** 物流详情页 → 运单号 / 快递公司 / 官方状态 / 完整节点 */

/** 「08-07 18:59」→ 毫秒（实现在 model.ts，三个平台共用） */

export function parseLogistics(html: string): {
  mailNo: string
  company: string
  latest: string
  tracks: { time: string; text: string }[]
  statusCode: string
  statusDesc: string
  city: string
  station: string
  /** 官方取件码（淘宝物流页实测没有这个字段，留接口；有就直接用） */
  pickupCode: string
  /** 收货地（淘宝 END_TRACE_CODING，最后一段路的终点就是收货地址） */
  receiverCity: string
  receiverAddress: string
  /** 收货人姓名 + 掩码手机号（淘宝「号码保护中」节点里的） */
  receiverName: string
  receiverPhone: string
} {
  const mailNo = firstMatch(html, /"mailNo":"(\d{6,})"/)
  const company = firstMatch(html, /"logisticCompany":\{[^}]*?"name":"([^"]+)"/)
  // 官方状态：logisticsPackageStatus.statusCode，SIGN = 已签收（权威于节点文案）
  const statusCode = firstMatch(html, /"logisticsPackageStatus":\{"statusCode":"([A-Za-z_]+)"/)
  const statusDesc = firstMatch(html, /"logisticsPackageStatus":\{"statusCode":"[A-Za-z_]+","statusDesc":"([^"]+)"/)

  // 节点全在 multiStage[] 里：每个 stage 有 labelDesc.text 和 subtitle（MM-DD HH:mm），新→旧
  const stages = parseMultiStages(html)
  const tracks: { time: string; text: string }[] = []
  for (const st of stages) {
    // richContent 是分段的：labelDesc.text 有时只给第一段（「快件已由快递员【柳长华：」），
    // 把 richContent 里所有 text 拼起来才是完整文案，两个取长的那个。
    const parts: string[] = (Array.isArray(st?.labelDesc?.richContent) ? st.labelDesc.richContent : [])
      .map((x: any) => String(x?.text ?? ""))
    const joined = parts.join("").trim()
    const official = String(st?.labelDesc?.text ?? "").trim()
    const text = (joined.length > official.length ? joined : official).trim()
    const time = String(st?.subtitle ?? "")
    if (text && !tracks.some(t => t.text === text && t.time === time)) {
      // 「号码保护中」是收货人信息、「商家选择无需物流发货」是无物流占位节点，都不是真实轨迹
      const tag = String(st?.labelDesc?.mainTag ?? "")
      if (tag.includes("号码保护") || text.includes("无需物流")) continue
      tracks.push({ time, text })
    }
  }

  // 收货人：淘宝把收货人与脱敏手机号放在收货节点的 labelDesc.text 里（mainTag=号码保护中），
  // 收货地址在同一个节点的 title：「送至 XX路2号某公寓」。
  let receiverName = ""
  let receiverPhone = ""
  let receiverFromTitle = ""
  for (const st of stages) {
    const tag = String(st?.labelDesc?.mainTag ?? "")
    const txt = String(st?.labelDesc?.text ?? "").replace(/\s+/g, " ").trim()
    const title = String(st?.title ?? "").trim()
    if (!receiverName && (tag.includes("号码保护") || /^[\u4e00-\u9fa5]{1,4}\s*(?:\+?86-?)?\d{3}\*{4}\d{4}$/.test(txt))) {
      const m = /^([\u4e00-\u9fa5]{1,4})\s*(?:\+?86-?)?(\d{3}\*{4}\d{4})$/.exec(txt)
      if (m) { receiverName = m[1]; receiverPhone = m[2] } else receiverName = txt
    }
    if (!receiverFromTitle && /^送至/.test(title)) receiverFromTitle = title.replace(/^送至\s*/, "")
  }
  const first = tracks[0]?.text
    || firstMatch(html, /"labelDesc":\{"richContent":\[\{[^}]*?"text":"([^"]+)"/)
  // 收货地：物流页的 END_TRACE_CODING 就是最后一段路的终点（收货地址），
  // 不能拿 LASTONE_TRACE_CODING（那是驿站代收点地址）。
  const endTrace = (() => {
    const at = html.indexOf('"END_TRACE_CODING":')
    if (at < 0) return { address: "", city: "" }
    const seg = html.slice(at, at + 600)
    return {
      address: /"address":"([^"]+)"/.exec(seg)?.[1] ?? "",
      city: /"cityName":"([^"]+)"/.exec(seg)?.[1] ?? "",
    }
  })()
  // 代收点：优先 LASTONE_TRACE_CODING（最后一段路的终点＝驿站/柜机）；
  // END_TRACE_CODING 是收货地址，两者不能混用。取不到时才用首个 address，
  // 而且必须长得像代收点，否则会把家里的收货地址当成驿站显示在卡片上。
  const lastOne = (() => {
    const at = html.indexOf('"LASTONE_TRACE_CODING":')
    if (at < 0) return { address: "", name: "" }
    const seg = html.slice(at, at + 900)
    return {
      address: /"address":"([^"]+)"/.exec(seg)?.[1] ?? "",
      name: /"(?:stationName|storeName|name)":"([^"]{2,40})"/.exec(seg)?.[1] ?? "",
    }
  })()
  const hasProxy = /"typeDesc":"(代收点|驿站|快递柜|自提点)"/.test(html)
  const guessed = hasProxy ? (firstMatch(html, /"address":"([^"]{4,60})"/) || "") : ""
  const station = lastOne.name || lastOne.address
    || (/驿站|代收|快递柜|自提|菜鸟|丰巢/.test(guessed) ? guessed : "")
  return {
    mailNo, company, tracks, statusCode, statusDesc,    // 官方字段优先：城市与驿站直接取页面里的结构化值，不再从文案里猜
    city: firstMatch(html, /"cityName":"([^"]+)"/),
    receiverCity: endTrace.city,
    receiverAddress: endTrace.address || receiverFromTitle,
    receiverName,
    receiverPhone,
    // 取件码：淘宝这页目前不返回（只有 facilityCode=柜机编号），有就取，没有交给关键词兜底
    pickupCode: firstMatch(html, /"(?:pickupCode|takeCode|pickup_code|take_code)":"([A-Za-z0-9-]{3,20})"/),
    station,
    // 官方说签收就直接用官方文案，不管节点停在哪儿（驿站不回传新节点就会卡在「到达代收点」）
    latest: statusFromCode(statusCode) === "delivered" ? (statusDesc || "已签收") : first,
  }
}

/** 从 HTML 里把 "multiStage":[...] 这段 JSON 完整括出来并解析（括号计数，跳过字符串内的括号） */
function parseMultiStages(html: string): any[] {
  const key = '"multiStage":['
  const at = html.indexOf(key)
  if (at < 0) return []
  const start = at + key.length - 1
  let depth = 0
  let inStr = false
  let esc = false
  let end = -1
  for (let i = start; i < html.length; i++) {
    const ch = html[i]
    if (inStr) {
      if (esc) { esc = false; continue }
      if (ch === "\\") { esc = true; continue }
      if (ch === '"') inStr = false
      continue
    }
    if (ch === '"') { inStr = true; continue }
    if (ch === "[" || ch === "{") depth++
    else if (ch === "]" || ch === "}") {
      depth--
      if (depth === 0) { end = i + 1; break }
    }
  }
  if (end < 0) return []
  try {
    const arr = JSON.parse(html.slice(start, end))
    return Array.isArray(arr) ? arr : []
  } catch {
    return []
  }
}



async function fetchText(url: string): Promise<string> {
  const res = await fetch(url, {
    headers: {
      Cookie: cookieHeader(),
      "User-Agent": UA,
      Referer: "https://h5.m.taobao.com/mlapp/olist.html",
    },
  })
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  return await res.text()
}

/** 用登录态拉一条订单的物流（不依赖 WebView，小组件里也能跑） */
export async function fetchPackage(orderId: string, prev?: Pkg): Promise<Pkg> {
  const logisticsHtml = await fetchText(LOGISTICS_URL(orderId))
  const info = parseLogistics(logisticsHtml)

  let itemTitle = prev?.itemTitle || ""
  let shopName = prev?.shopName || ""
  let orderStatus = ""
  // 退款后的物流页仍会显示原发货节点，所以每次都要回订单详情页核交易状态
  try {
    const orderHtml = await fetchText(ODETAIL_URL(orderId))
    const meta = parseOrder(orderHtml)
    itemTitle = itemTitle || meta.itemTitle
    shopName = shopName || meta.shopName
    orderStatus = meta.orderStatus
  } catch { }
  const closed = closedOrderStatus(orderStatus)

  return {
    orderId,
    source: "taobao",
    itemTitle,
    shopName,
    company: info.company || prev?.company || "",
    mailNo: info.mailNo || prev?.mailNo || "",
    latest: closed ? orderStatus : (info.latest || prev?.latest || ""),
    // 订单关闭优先：退款成功的单不能再按物流节点当在途
    status: closed ?? statusFromCode(info.statusCode) ?? classify(info.latest || prev?.latest || ""),
    tracks: info.tracks.length > 0 ? info.tracks : prev?.tracks,
    lastTrackAt: timeOfTrack(info.tracks[0]?.time || "") || prev?.lastTrackAt,
    city: info.city || prev?.city,
    stationName: info.station || prev?.stationName,
    pickupCode: info.pickupCode || prev?.pickupCode,
    receiverCity: info.receiverCity || prev?.receiverCity,
    receiverAddress: info.receiverAddress || prev?.receiverAddress,
    receiverName: info.receiverName || prev?.receiverName,
    receiverPhone: info.receiverPhone || prev?.receiverPhone,
    updatedAt: Date.now(),
  }
}

// 淘宝订单页经常被登录引导/领券弹层、“请选择”页头盖住，DOM 里就抓不到订单号。
// 这里把 fixed/absolute 的遮罩类元素隐藏掉、把滚动恢复，再读内容（不点任何业务按钮，只清遮挡）。
/** 淘宝拦截页词表：只有真滑块/验证才值得弹页给人，限流类等一下自己就过 */
const TB_VERIFY_RE = /滑动验证|请完成验证|安全验证|人机验证|滑块验证|验证码|captcha/i

/**
 * 淘宝人机验证：和京东 humanVerify 同构——把页面弹给用户过滑块，
 * 过了（Ultron 数据里重新出现订单）自动收起并返回 true。
 */
export async function taobaoHumanVerify(): Promise<boolean> {
  const controller = new WebViewController()
  try {
    for (const cookie of getCookies()) {
      try { await controller.setCookie(cookie) } catch { }
    }
    try {
      await controller.loadURL("https://h5.m.taobao.com/mlapp/olist.html")
      try { await pageTimeout(controller.waitForLoad(), 15000) } catch { }
    } catch { }
    let presented = true
    const p = controller.present({ fullscreen: true, navigationTitle: "淘宝需要验证" })
      .then(() => { presented = false })
      .catch(() => { presented = false })
    const deadline = Date.now() + 3 * 60_000
    let ok = false
    while (presented && Date.now() < deadline) {
      await delay(1500)
      if (!presented) break
      const raw = String(await controller.evaluateJavaScript<string>(`return (function(){
        try{
          var s = window.currentUltronData ? JSON.stringify(window.currentUltronData) : ''
          var t = document.body ? document.body.innerText.slice(0, 500) : ''
          return JSON.stringify({
            has: /bizOrderId|\\"orderId\\"/.test(s),
            bad: /滑动验证|请完成验证|安全验证|人机验证|滑块验证|验证码|captcha/i.test(t)
          })
        }catch(e){ return '{}' }
      })()`) || "{}")
      let info: any = {}
      try { info = JSON.parse(raw) } catch { }
      if (info.has && !info.bad) { ok = true; break }
    }
    if (presented) { try { await controller.dismiss() } catch { } }
    try { await p } catch { }
    await delay(400)
    return ok
  } finally {
    try { controller.dispose() } catch { }
  }
}

/** 页面内正则，只回订单号列表（逗号分隔）。整页 HTML 过 JS 桥会失败，绝不能取 outerHTML 回来 */
const IDS_ONLY = `return (function(){
  try{
    var d = document.documentElement ? document.documentElement.outerHTML : ''
    var re = /bizOrderId/g, m, cnt = 0, s = []
    while ((m = re.exec(d))) { cnt++; if (s.length < 3) s.push(d.substr(m.index, 36)) }
    var ids = []
    try {
      var as = document.querySelectorAll('a[href*="bizOrderId"]')
      for (var i = 0; i < as.length; i++) {
        var mm = /(\\d{10,})/.exec(as[i].getAttribute('href') || '')
        if (mm && ids.indexOf(mm[1]) < 0) ids.push(mm[1])
      }
    } catch (x) { }
    var emp = false
    try {
      var it = document.body ? document.body.innerText : ''
      emp = /没有找到|暂无订单|还没有订单|无相关订单|没有相关订单/.test(it)
    } catch (e) { }
    return JSON.stringify({ len: d.length, t: (document.title||'').slice(0,20), cnt: cnt, s: s, a: ids.length, emp: emp, ids: ids.slice(0, 60).join(',') })
  } catch (e) { return JSON.stringify({ err: String((e && e.message) || e) }) }
})()`

/** 抓页面自己发出去的请求：点 tab 时列表是异步拉的，把 URL 记下来就能拿到真接口。*/
const HOOK_XHR = `return (function(){
  try{
    if (window.__ppHooked) return 1
    window.__ppHooked = 1
    window.__ppReq = []
    var XO = XMLHttpRequest.prototype.open
    XMLHttpRequest.prototype.open = function(m,u){
      try{ window.__ppReq.push(String(m)+' '+String(u).slice(0,240)) }catch(e){}
      return XO.apply(this, arguments)
    }
    if (window.fetch) {
      var of = window.fetch
      window.fetch = function(u){
        try{ window.__ppReq.push('FETCH '+String(u).slice(0,240)) }catch(e){}
        return of.apply(this, arguments)
      }
    }
    return 1
  }catch(e){ return 0 }
})()`

const CLEAR_OVERLAYS = `return (function(){
  try{
    var sels=['[class*="mask"]','[class*="Mask"]','[class*="modal"]','[class*="Modal"]','[class*="popup"]','[class*="Popup"]','[class*="dialog"]','[id*="J_MIDDLEWARE"]','.ks-overlay','.tb-ext-mask'];
    var n=0;
    sels.forEach(function(sel){
      try{ [].slice.call(document.querySelectorAll(sel)).forEach(function(e){
        try{ var st=getComputedStyle(e); if(st.position==='fixed'||st.position==='absolute'){ e.style.display='none'; n++ } }catch(x){}
      }) }catch(x){}
    });
    try{ if(document.documentElement) document.documentElement.style.overflow='auto' }catch(x){}
    try{ if(document.body) document.body.style.overflow='auto' }catch(x){}
    return n
  }catch(e){ return -1 }
})()`

/**
 * 等订单列表真的渲染出来：每 700ms 看一眼 DOM，没列表就顺手清一次遮挡并滚到底。
 * 思路同 handycode 的 login-ready.js——先确认页面就绪再取数据，而不是加载完就硬抓。
 */
async function waitForOrders(controller: WebViewController, maxMs: number): Promise<boolean> {
  const end = Date.now() + maxMs
  while (Date.now() < end) {
    try {
      const rv: any = await controller.evaluateJavaScript(
        "return (function(){try{var h=document.documentElement?document.documentElement.outerHTML:'';return /bizOrderId[=:\\\"%]+\\d{10,}/.test(h)?1:0}catch(e){return -1}})()")
      const ok = rv === 1 || rv === true || String(rv) === "1" || String(rv) === "true"
      if (ok) { diag("taobao-wait", { ok: true }); return true }
    } catch { }
    try { await controller.evaluateJavaScript(CLEAR_OVERLAYS) } catch { }
    try { await controller.evaluateJavaScript("window.scrollTo(0, document.body.scrollHeight)") } catch { }
    await delay(700)
  }
  diag("taobao-wait", { ok: false })
  return false
}

/** 诊断：把网页实际返回的线索写进 cc/syncDiag.log，用户跑一次同步就能回看 */
export function diag(tag: string, obj: any): void {
  try {
    const dir = `${FileManager.appGroupDocumentsDirectory}/cc`
    if (!FileManager.existsSync(dir)) FileManager.createDirectorySync(dir, true)
    const p = `${dir}/syncDiag.log`
    const line = `${new Date().toISOString()} ${tag} ${JSON.stringify(obj).slice(0, 900)}\n`
    const prev = FileManager.existsSync(p) ? FileManager.readAsStringSync(p) : ""
    FileManager.writeAsStringSync(p, (prev + line).slice(-20000))
  } catch { }
}

/** 当前页面是不是被踢回登录页了 */
async function atLoginPage(controller: WebViewController): Promise<boolean> {
  try {
    const host = String(await controller.evaluateJavaScript<string>("return location.host") || "")
    return /^login[\d.]*\.(taobao|tmall)\.com$/.test(host) || /login\.m\.taobao\.com/.test(host)
  } catch { return false }
}

/**
 * 发现账号下的订单号。
 * 主线路：PC 版「已买到的宝贝」，DOM 里直接带 bizOrderId。
 * 兜底：H5 订单页是 Ultron 渲染，读 window.currentUltronData。
 */
/** 上一轮淘宝订单页是否真的渲染出来了。
 *  订单为 0 有两种可能：页面没加载（故障）和用户确实没买东西（正常）。
 *  只有页面没就绪才算失败，否则会把“空订单”永远报成错误。*/
let lastTaobaoPageOk = false

export async function discoverOrderIds(): Promise<string[]> {
  lastTaobaoPageOk = false
  const controller = new WebViewController()
  try {
    for (const cookie of getCookies()) {
      try { await controller.setCookie(cookie) } catch { }
    }

    // 主线路：PC 版「已买到的宝贝」。H5 olist 会先弹「请选择」页头，列表根本不渲染。
    // 淘宝 PC 订单页的 tab 参数（tab=wait_buyer_receive）实测不生效，页面仍返回全量列表；
    // 所以改成「进页面后点自带的『待收货』tab」真正用平台筛选，再限量取最近的单。
    // 主线路：H5 Ultron。快递聚合3.0 实测稳定（同一账号拿到 15 单，含历史单），
    // 我们之前把它当“兜底”又把体积限制加坏了，才让 PC 页成为唯一线路。
    let needVerify = false
    try {
      await controller.loadURL("https://h5.m.taobao.com/mlapp/olist.html")
      try { await pageTimeout(controller.waitForLoad(), 12000) } catch { }
      if (!await atLoginPage(controller)) {
        let blob = ""
        for (let i = 0; i < 15; i++) {
          blob = String(await controller.evaluateJavaScript<string>(
            "return window.currentUltronData ? JSON.stringify(window.currentUltronData) : ''") || "")
          if (blob.includes("bizOrderId") || blob.includes("orderId")) break
          try { await controller.evaluateJavaScript("window.scrollTo(0, document.body.scrollHeight)") } catch { }
          await delay(600)
        }
        const h5Ids: string[] = []
        const pushH5 = (v: string) => { if (v && !h5Ids.includes(v)) h5Ids.push(v) }
        for (const m of blob.matchAll(/bizOrderId=(\d{10,})/g)) pushH5(m[1])
        for (const m of blob.matchAll(/"orderId":"(\d{10,})"/g)) pushH5(m[1])
        diag("taobao-h5", { len: blob.length, n: h5Ids.length })
        if (h5Ids.length > 0) {
          lastTaobaoPageOk = true
          return h5Ids.slice(0, 40)
        }
        // 一条都没拿到：先别急着下结论，看看是不是弹了滑块
        const vt = String(await controller.evaluateJavaScript(
          "return document.body ? document.body.innerText.slice(0,500) : ''") || "")
        if (TB_VERIFY_RE.test(vt)) needVerify = true
      }
    } catch { }
    if (needVerify) throw new Error("淘宝需要人机验证")

    const pcIds: string[] = []
    const pushPc = (v: string) => { if (v && !pcIds.includes(v)) pcIds.push(v) }
    let needLogin = false
    let pageOk = false
    try {
      await controller.loadURL("https://buyertrade.taobao.com/trade/itemlist/list_bought_items.htm")
      try { await pageTimeout(controller.waitForLoad(), 15000) } catch { }
      try { await controller.evaluateJavaScript(CLEAR_OVERLAYS) } catch { }
      try { await controller.evaluateJavaScript(HOOK_XHR) } catch { }
      // 被踢到登录页就别再猜「遮挡」——直接报登录失效，交给用户重新授权
      if (await atLoginPage(controller)) needLogin = true
      try {
        const raw = String(await controller.evaluateJavaScript(`return JSON.stringify({href:location.href,title:document.title,len:(document.documentElement?document.documentElement.outerHTML.length:0),hasOrder:/bizOrderId[=":%]+\\d{10,}/.test(document.documentElement?document.documentElement.outerHTML:''),text:(document.body?document.body.innerText.slice(0,200):'')})`) || "")
        const pinfo: any = JSON.parse(raw || "{}")
        pageOk = String(pinfo.title || "").includes("已买到的宝贝") && Number(pinfo.len || 0) > 40000
        diag("taobao-pc", { title: pinfo.title, len: pinfo.len, has: pinfo.hasOrder, ok: pageOk })
      } catch { }
      // 页面就绪再动手：被弹层盖住/懒加载时先等列表出现，还没出现就重载一次再等
      if (!needLogin && !await waitForOrders(controller, 8000)) {
        try {
          await controller.loadURL("https://buyertrade.taobao.com/trade/itemlist/list_bought_items.htm")
          try { await pageTimeout(controller.waitForLoad(), 15000) } catch { }
          await controller.evaluateJavaScript(CLEAR_OVERLAYS)
          if (await atLoginPage(controller)) needLogin = true
        } catch { }
        if (!needLogin) await waitForOrders(controller, 6000)
      }
      // 点页面自带的「待收货」筛选；点不到就用全量列表但限量
      let clickedPending = false
      try {
        const hit = String(await controller.evaluateJavaScript(`return (function(){
          var t=[].slice.call(document.querySelectorAll('a,span,div,li')).find(function(e){
            var s=(e.textContent||'').trim(); return (s==='待收货'||s==='待收货订单')&&e.children.length<3 });
          if(t){ t.click(); return 'clicked'; } return 'no';
        })()`) || "")
        clickedPending = hit.indexOf("clicked") >= 0
        // 点 tab 会触发列表重渲染，必须等新列表出来再取号。
        // 不等就会在页面已经空了的时候去拿，取回 0 条（曾经连续 11 次“取不到订单”的真因）。
        if (clickedPending) await waitForOrders(controller, 6000)
        else await delay(1500)
      } catch { }
      // 待收货筛选：全拿（最多 40 条保险）。没筛到就是全量列表（按时间倒序），
      // 只取前 20 条——后面的都是几个月前的历史单，多拿只会多开网页、多撞风控。
      const cap = clickedPending ? 40 : 20
      let stable = 0
      let emptyConfirmed = false
      for (let i = 0; i < 10 && stable < 3 && pcIds.length < cap; i++) {
        const raw = String(await controller.evaluateJavaScript<string>(IDS_ONLY) || "")
        let info: any = {}
        try { info = JSON.parse(raw) } catch { }
        diag("taobao-ids", { cnt: info.cnt, a: info.a, len: info.len, t: info.t, emp: info.emp })
        // 页面明确写了「没有找到相关订单」：这就是空态，立刻结束，不用等满 5 秒
        if (info.emp && pcIds.length === 0) { emptyConfirmed = true; break }
        const got = String(info.ids || "")
        const beforeN = pcIds.length
        for (const v of got.split(",")) if (v) pushPc(v)
        stable = pcIds.length === beforeN ? stable + 1 : 0
        try { await controller.evaluateJavaScript("window.scrollTo(0, document.body.scrollHeight)") } catch { }
        await delay(700)
      }
      // 页面明确告诉「没有订单」—— 这也是一种「就绪」，不是故障
      if (emptyConfirmed) pageOk = true
      try {
        const reqs = String(await controller.evaluateJavaScript<string>(
          "return JSON.stringify((window.__ppReq||[]).slice(-14))") || "[]")
        diag("taobao-xhr", { reqs: JSON.parse(reqs) })
      } catch { }
    } catch { }
    if (needLogin) throw new Error("淘宝登录已失效，请重新授权")
    if (pcIds.length > 0) { lastTaobaoPageOk = true; return pcIds }

    // 兜底：H5 订单列表（页面正常时仍可用）
    await controller.loadURL("https://h5.m.taobao.com/mlapp/olist.html")
    try { await pageTimeout(controller.waitForLoad(), 15000) } catch { }
    try { await controller.evaluateJavaScript(CLEAR_OVERLAYS) } catch { }
    if (await atLoginPage(controller)) throw new Error("淘宝登录已失效，请重新授权")

    let blob = ""
    for (let i = 0; i < 15; i++) {
      // 直接取整块 Ultron 数据。快递聚合3.0 就是这么拿的，实测能拿到 15 单，
      // 之前我加的「超过 600KB 就不取」把这条唯一能用的线路直接挂死了。
      blob = String(await controller.evaluateJavaScript<string>(
        "return window.currentUltronData ? JSON.stringify(window.currentUltronData) : ''"
      ) || "")
      if (blob.includes("bizOrderId")) break
      // 列表是懒加载的，滚到底部催一下，再等一轮
      try { await controller.evaluateJavaScript("window.scrollTo(0, document.body.scrollHeight)") } catch { }
      await delay(600)
    }

    const ids: string[] = []
    const push = (v: string) => { if (v && !ids.includes(v)) ids.push(v) }
    for (const m of blob.matchAll(/bizOrderId=(\d{10,})/g)) push(m[1])
    // 「查看物流」按钮才带 bizOrderId；本身不需要物流的单只能靠 orderId 字段抽
    for (const m of blob.matchAll(/"orderId":"(\d{10,})"/g)) push(m[1])
    // 兜底：Ultron 数据没拿到时，从 DOM 里找订单链接
    if (ids.length === 0) {
      try {
        const raw = String(await controller.evaluateJavaScript<string>(IDS_ONLY) || "")
        let info: any = {}
        try { info = JSON.parse(raw) } catch { }
        for (const v of String(info.ids || "").split(",")) if (v) push(v)
      } catch { }
    }
    if (ids.length > 0 || pageOk) lastTaobaoPageOk = true
    return ids
  } finally {
    controller.dispose()
  }
}

/* ---------------- 同步 ---------------- */

/** 历史已签收的判定在 model.ts（isHistoricalPkg），三个平台共用 */
export async function syncAll(onProgress?: (done: number, total: number) => void, deadline?: number, skipOrderIds?: Set<string>): Promise<Snapshot> {
  if (!hasLogin()) throw new Error("请先登录淘宝")
  const discovered = await discoverOrderIds()
  // 增量：已签收且近 3 天更新过的单不再重拉物流，状态不会变，省一轮往返
  const ids = skipOrderIds ? discovered.filter(id => !skipOrderIds.has(id)) : discovered
  // 注意：这句话里不能出现「登录/过期/风控/验证」——handleError 靠关键词判定登录失效，
  // 页面没加载出来也会被误标成“登录已失效”（用户实测就是这个坑）。
  if (ids.length === 0) {
    // 页面正常但账号里确实没订单：这是一次成功的同步，不能报错
    if (lastTaobaoPageOk) return { packages: [], syncedAt: Date.now() }
    throw new Error("淘宝订单页未就绪，本轮跳过")
  }
  // 并发 4 路拉物流：单路串行时 10 单要 10 个往返，用户体感就是“同步好久”
  const packages: Pkg[] = []
  let next = 0
  let done = 0
  const worker = async () => {
    while (next < ids.length) {
      if (deadline && Date.now() > deadline) return
      const i = next++
      let pkg: Pkg | null = null
      try { pkg = await fetchPackage(ids[i]) } catch { pkg = null }
      if (pkg && !isHistoricalPkg(pkg)) packages.push(pkg)
      done++
      onProgress?.(done, ids.length)
    }
  }
  // 并发 6 路拉物流（原 4 路）：单个运单一次跳转约 0.3～1 秒，6 路同时跑能把 20 单拉到 4～5 秒
  await Promise.all([worker(), worker(), worker(), worker(), worker(), worker()])
  const snapshot: Snapshot = { packages, syncedAt: Date.now() }
  return snapshot
}

