import { classify, closedOrderStatus, Pkg, statusFromCode, timeOfTrack } from "./model"
import { etaInObject, etaInText, etaTimeInText } from "./eta"

export const PDD_COOKIE_KEY = "pdd.cookies"
const PDD_LS_KEY = "pdd.localStorage"
// 老版本（platforms.ts）把同一份 localStorage 存在 `pdd.ls`，两个 key 都读，别再各存一份
const PDD_LS_ALIAS = "pdd.ls"

/**
 * 拼多多登录的 UA 策略：用户实测「平板方式登录不会挤掉手机 App 的登录」。
 * 拼多多把手机/平板/PC 视为不同设备端，平板会话与手机 App 会话可并存；
 * 所以 WebView 登录一律伪装成 iPad Safari，登录一次后长期复用 cookie，不再重复登录。
 */
const SAFARI_UA = "Mozilla/5.0 (iPad; CPU OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1"

const LOGIN_URL = "https://mobile.yangkeduo.com/login.html"
const ORDERS_URL = "https://mobile.yangkeduo.com/orders.html"

declare const fetch: any
const delay = (ms: number) => new Promise<void>(resolve => (setTimeout as any)(resolve, ms))

/* ---------------- 登录态 ---------------- */


export function pddCookies(): any[] {
  const raw = Keychain.get(PDD_COOKIE_KEY)
  if (!raw) return []
  try { const v = JSON.parse(raw); return Array.isArray(v) ? v : [] } catch { return [] }
}

function pddLocalStorage(): Record<string, string> {
  for (const key of [PDD_LS_KEY, PDD_LS_ALIAS]) {
    const raw = Keychain.get(key)
    if (!raw) continue
    try {
      const v = JSON.parse(String(raw))
      if (v && typeof v === "object" && Object.keys(v).length > 0) return v as Record<string, string>
    } catch { }
  }
  return {}
}

/** localStorage 里像登录 token 的 key：名字含 token/access 且值够长（匿名 key / user_agreement 之类不会误判，避免弹窗闪退） */
function looksLikeToken(key: string, value: any): boolean {
  return /token|access/i.test(key) && typeof value === "string" && value.length >= 8
}

export function pddHasLogin(): boolean {
  const list = pddCookies()
  if (list.length > 0) {
    const names = list.map((c: any) => String(c.name))
    if (names.includes("PDDAccessToken")) return true
    // 兼容：有的版本 token 只落在 localStorage，或 Cookie 名改过。
    // 只要有保存下来的拼多多 Cookie 就先当已授权；真失效时接口会回 40001，界面再提示重新授权。
    // 这里拦得太死就会出现「已经授权了，身份码页还要登录」。
    if (list.length >= 2) return true
  }
  const ls = pddLocalStorage()
  return Object.keys(ls).some(k => looksLikeToken(k, ls[k]))
}

export function pddCookieHeader(): string {
  return pddCookies().map((c: any) => `${c.name}=${c.value}`).join("; ")
}

export function pddClearLogin(): void {
  Keychain.remove(PDD_COOKIE_KEY)
  // localStorage 两个 key 都清：新版本写 pdd.localStorage，老版本（platforms）写 pdd.ls，
  // 只清一个的话另一个里的登录 token 还在，pddHasLogin() 仍会认为已授权
  Keychain.remove(PDD_LS_KEY)
  Keychain.remove(PDD_LS_ALIAS)
  // 同时清掉 WebView 持久 Cookie 仓库里的拼多多会话：
  // 否则旧登录态还活在仓库里，下次打开登录页会被自动登录顶掉（登录界面闪一下就没）
  try {
    const c = new WebViewController()
    c.getAllCookies().then((cookies: any[]) => {
      try {
        const pdd = (cookies || []).filter((ck: any) => /yangkeduo|pinduoduo|pddpic/.test(String(ck.domain || "")))
        for (const ck of pdd) { try { c.deleteCookie(ck) } catch { } }
      } catch { }
      try { c.dispose() } catch { }
    }).catch(() => { try { c.dispose() } catch { } })
  } catch { }
}

/**
 * 登录页修版脚本。
 *
 * 拼多多的手机号登录表单是 `#login .container { position: fixed; top: 100% }`，点「手机登录」后 JS 把 top 改成 0，
 * 于是表单正好贴在 WebView 的顶部。而 WebViewController 顶部有半透明导航栏（约 116pt），表单被它盖住，
 * 表现就是「页面显示不全、手机号输入框看不见也点不到」。
 *
 * 这里把表单改成「垂直居中的卡片」：不管顶部有多少安全区/导航栏，卡片都落在可视区中间，键盘弹出也不会被顶没。
 * 顺带隐藏「打开拼多多App」启动页，直接进入手机号登录。
 */
const PDD_LOGIN_FIX = `(function(){
  var CSS = [
    'html,body{height:100%!important;overflow:hidden!important;background:#fff!important;}',
    '#login{background:#fff!important;}',
    '#login .main{display:none!important;}',
    '#login .container{position:fixed!important;top:0!important;bottom:0!important;left:0!important;right:0!important;',
    'height:auto!important;width:auto!important;max-width:none!important;overflow:visible!important;padding:0 0 110px!important;',
    'z-index:2!important;transform:none!important;opacity:1!important;display:flex!important;flex-direction:column!important;',
    'align-items:center!important;justify-content:center!important;background:#fff!important;}',
    '#login .container .login-ui-form{width:100%!important;max-width:430px!important;margin:0!important;padding:0!important;background:transparent!important;}',
    '#login .container .login-ui-form::before{content:"手机号登录";display:block;text-align:center;font-size:20px;font-weight:700;color:#151516;margin:0 16px 18px;}',
    '#login .container .login-ui-form .login-input{background:transparent!important;}',
    '#login .container .login-ui-form .login-input .input-group{background:#f5f5f5!important;border-radius:12px!important;margin:0 16px 12px!important;height:54px!important;padding:0 14px!important;width:auto!important;}',
    '#login .container .login-ui-form .login-input .input-group input{margin-left:28px!important;height:54px!important;font-size:17px!important;color:#151516!important;-webkit-text-fill-color:#151516!important;}',
    '#login .container .login-ui-form .login-input .input-group input::placeholder{color:#b8b8b8!important;-webkit-text-fill-color:#b8b8b8!important;}',
    '#login .container .login-ui-form .login-input .input-group #code-button{width:104px!important;height:34px!important;border-radius:17px!important;font-size:14px!important;}',
    '#login .container .login-ui-form .login-input hr{display:none!important;}',
    '#login .container .login-ui-form .footer-buttons-wrap{padding:6px 16px 0!important;}',
    '#login .container .login-ui-form #submit-button{width:100%!important;height:48px!important;border-radius:24px!important;font-size:17px!important;font-weight:600!important;}',
    '#login .container .login-ui-form .submit-button-login{display:none!important;}',
    '#login .container .login-ui-form .agreement-wrap{margin-top:14px!important;font-size:12px!important;}'
  ].join('');
  function apply(){
    var st = document.getElementById('agent-pdd-fix');
    if(!st){ st = document.createElement('style'); st.id='agent-pdd-fix'; (document.head||document.documentElement).appendChild(st); }
    if(st.textContent !== CSS) st.textContent = CSS;
    var ctn = document.querySelector('#login .container');
    if(ctn && ctn.getAttribute('style')) ctn.removeAttribute('style');
    if(!window.__pddFixClicked){
      var all = [].slice.call(document.querySelectorAll('button,div,span,a'));
      var b = all.filter(function(e){ var t=(e.textContent||'').trim(); return /^(手机登录|手机号登录)$/.test(t) && e.children.length<3 })[0];
      if(b){ window.__pddFixClicked = 1; try{ b.click() }catch(e){} }
    }
  }
  apply();
  if(!window.__pddFixObserver){
    window.__pddFixObserver = new MutationObserver(function(){ if(!window.__pddFixTimer) window.__pddFixTimer=setTimeout(function(){ window.__pddFixTimer=0; apply() }, 100) });
    window.__pddFixObserver.observe(document.documentElement, { childList:true, subtree:true });
  }
  var n = 0, iv = setInterval(function(){ apply(); if(++n > 80) clearInterval(iv) }, 250);
})()`

/** 每次打开 WebView 前：设置 UA、还原 Cookie 与 localStorage（拼多多会把登录 token 放在 localStorage 里） */
async function prepare(controller: WebViewController, loginFix = false): Promise<void> {
  try { await controller.setCustomUserAgent(SAFARI_UA) } catch { }
  if (loginFix) { try { await controller.addUserScript({ source: PDD_LOGIN_FIX, injectionTime: "documentEnd" }) } catch { } }
  const ls = pddLocalStorage()
  if (Object.keys(ls).length > 0) {
    try {
      await controller.addUserScript({
        source: `try{var m=${JSON.stringify(ls)};Object.keys(m).forEach(function(k){try{localStorage.setItem(k,String(m[k]))}catch(e){}})}catch(e){}`,
        injectionTime: "documentStart",
      })
    } catch { }
  }
  for (const c of pddCookies()) { try { await controller.setCookie(c) } catch { } }
}

/**
 * 登录页自己的跳转守卫：拼多多 H5 检测到不在 App 里时会尝试
 *  - 自定义 scheme / 通用链接唤起拼多多App（app1.yangkeduo.com）
 *  - 跳到下载页 / 应用市场
 * 这些导航一旦发生，登录弹窗会被顶掉，表现就是「登录界面闪退」。
 * 这里拦掉非 http(s) 和唤起 App / 下载页的请求，让用户安心留在登录页。
 */
const BLOCKED_NAV = /(pinduoduo|yangkeduo|ddmc):\/\/|app1\.yangkeduo\.com|download\.html|market_download|itms-apps|apps\.apple\.com|market:\/\//i

function shouldAllowNav(url: string): boolean {
  if (!url) return true
  if (!/^https?:/i.test(url)) return false
  if (BLOCKED_NAV.test(url)) return false
  return true
}

async function saveSession(controller: WebViewController): Promise<number> {
  const cookies = await controller.getAllCookies().catch(() => [])
  const usable = (cookies || []).filter((c: any) => /yangkeduo|pinduoduo|pddpic/.test(String(c.domain || "")))
  if (usable.length > 0) Keychain.set(PDD_COOKIE_KEY, JSON.stringify(usable))
  try {
    const json = String(await controller.evaluateJavaScript<string>(
      "return (function(){try{var o={};for(var i=0;i<localStorage.length;i++){var k=localStorage.key(i);o[k]=localStorage.getItem(k)}return JSON.stringify(o)}catch(e){return ''}})()"
    ) || "")
    if (json) Keychain.set(PDD_LS_KEY, json)
  } catch { }
  return usable.length
}


/** 判断登录是否已完成：Cookie 或 localStorage 里出现登录 token 就算登录成功 */
async function sessionReady(controller: WebViewController): Promise<boolean> {
  const cookies = await controller.getAllCookies().catch(() => [])
  if ((cookies || []).some((c: any) => c && c.name === "PDDAccessToken" && !!c.value)) return true
  // 拼多多有时把登录 token 放 localStorage（未登录时 localStorage 只有 pdd_ban_report_domains/_nano_fp/h_* 等匿名 key，不会误判）
  try {
    const json = String(await controller.evaluateJavaScript<string>(
      "return (function(){try{var o={};for(var i=0;i<localStorage.length;i++){var k=localStorage.key(i);o[k]=localStorage.getItem(k)}return JSON.stringify(o)}catch(e){return ''}})()"
    ) || "")
    if (json) {
      const ls = JSON.parse(json)
      if (ls && typeof ls === "object") {
        for (const k of Object.keys(ls)) {
          if (looksLikeToken(k, ls[k])) return true
        }
      }
    }
  } catch { }
  return false
}

/* ---------------- 解析 ---------------- */

const BOILERPLATE = /^(http|https|\{|\[)|\d{11}$/

function text(v: any): string {
  return typeof v === "string" ? v : typeof v === "number" ? String(v) : ""
}

function walk(node: any, visit: (obj: any) => void, depth = 0) {
  if (!node || depth > 12) return
  if (Array.isArray(node)) { for (const item of node) walk(item, visit, depth + 1); return }
  if (typeof node !== "object") return
  visit(node)
  for (const key of Object.keys(node)) walk(node[key], visit, depth + 1)
}

export interface PddOrder {
  orderSn: string
  itemTitle: string
  shopName: string
  statusHint: string
  /** 快递单号（页面给的 tracking_number），有就不必再开物流页取一次 */
  trackingNumber?: string
  /** 快递公司编号，物流页 shipping_id 需要 */
  shippingId?: string
  /** 下单时间（毫秒）；rawData 没给就从单号日期前缀推 */
  orderTime?: number
}

/** 拼多多单号两种形态：261004-000000000000000（日期前缀+横杠）或纯数字 */
const SN_OK = (v: string) => /^\d{6,}-\d{6,}$/.test(v) || /^\d{8,}$/.test(v)

/** 单号里的日期前缀：261004-xxx → 2026-10-04 00:00（比订单页文案可靠，历史单就靠它筛掉） */
function snDateMs(sn: string): number | undefined {
  const m = sn.match(/^(\d{2})(\d{2})(\d{2})-\d{6,}/)
  if (!m) return undefined
  const y = 2000 + Number(m[1]), mo = Number(m[2]), d = Number(m[3])
  if (mo < 1 || mo > 12 || d < 1 || d > 31) return undefined
  const t = new Date(y, mo - 1, d).getTime()
  // 合理性：不能晚于明天、不能早于 3 年前。否则前缀不是日期，宁可当"无时间"保留，
  // 也不能拿它把当天的新单误杀。
  const now = Date.now()
  if (t > now + 86_400_000 || t < now - 3 * 365 * 86_400_000) return undefined
  return t
}

/** 订单时间统一成毫秒（字段可能是秒/毫秒时间戳，也可能是 "2026-10-04 12:30"） */
function timeMs(v: any): number | undefined {
  if (v == null) return undefined
  if (typeof v === "number") return v > 1e12 ? v : v > 1e9 ? v * 1000 : undefined
  const s = String(v).trim()
  if (!s) return undefined
  if (/^\d{13}$/.test(s)) return Number(s)
  if (/^\d{10}$/.test(s)) return Number(s) * 1000
  const m = s.match(/(\d{4})[-/](\d{1,2})[-/](\d{1,2})(?:[ T](\d{1,2}):(\d{1,2}))?/)
  if (!m) return undefined
  return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4] ?? 0), Number(m[5] ?? 0)).getTime()
}

export function extractOrders(raw: any): PddOrder[] {
  const byId = new Map<string, PddOrder>()
  const put = (sn: string, o: Partial<PddOrder>) => {
    const prev = byId.get(sn) || { orderSn: sn, itemTitle: "", shopName: "", statusHint: "", orderTime: snDateMs(sn) }
    if (o.itemTitle && !prev.itemTitle) prev.itemTitle = o.itemTitle
    if (o.shopName && !prev.shopName) prev.shopName = o.shopName
    if (o.statusHint && !prev.statusHint) prev.statusHint = o.statusHint
    if (o.trackingNumber && !prev.trackingNumber) prev.trackingNumber = o.trackingNumber
    if (o.shippingId && !prev.shippingId) prev.shippingId = o.shippingId
    if (o.orderTime && !prev.orderTime) prev.orderTime = o.orderTime
    byId.set(sn, prev)
  }

  // 主路径：订单页 window.rawData.ordersStore.orders[] —— 服务端预渲染的完整订单对象，
  // 字段全是驼峰（orderSn / trackingNumber / shippingId / orderStatusPrompt / orderGoods / mall）。
  const list = raw?.ordersStore?.orders
  if (Array.isArray(list)) {
    for (const o of list) {
      const sn = text(o?.orderSn || o?.order_sn)
      if (!SN_OK(sn)) continue
      const goods = Array.isArray(o.orderGoods) ? o.orderGoods[0] : null
      put(sn, {
        itemTitle: text(goods?.goodsName) || text(o.goodsName),
        shopName: text(o.mall?.mallName) || text(o.mallName),
        statusHint: text(o.orderStatusPrompt) || text(o.orderStatusDesc) || text(o.statusDesc),
        trackingNumber: text(o.trackingNumber),
        shippingId: text(o.shippingId),
        orderTime: timeMs(o.orderTime ?? o.order_time ?? o.createTime ?? o.create_time ?? o.payTime ?? o.pay_time),
      })
    }
  }
  if (byId.size > 0) return [...byId.values()]

  // 兜底：通用遍历（兼容其它页面形态/旧字段名）
  walk(raw, obj => {
    const sn = text(obj.orderSn || obj.order_sn || obj.orderSnStr)
    if (!SN_OK(sn)) return
    const goods = Array.isArray(obj.orderGoods) ? obj.orderGoods[0]
      : (Array.isArray(obj.order_goods) ? obj.order_goods[0] : (obj.order_goods || {}))
    put(sn, {
      itemTitle: text(goods?.goodsName) || text(goods?.goods_name) || text(obj.goodsName) || text(obj.goods_name),
      shopName: text(obj.mall?.mallName) || text(goods?.mallName) || text(obj.mall_name) || text(obj.mallName),
      statusHint: text(obj.orderStatusPrompt) || text(obj.order_status_desc) || text(obj.order_status_str),
      trackingNumber: text(obj.trackingNumber) || text(obj.tracking_number),
      shippingId: text(obj.shippingId) || text(obj.shipping_id),
      orderTime: timeMs(obj.orderTime ?? obj.order_time ?? obj.createTime ?? obj.create_time ?? obj.payTime),
    })
  })
  return [...byId.values()]
}

export function extractLogistics(raw: any): { mailNo: string; company: string; latest: string; latestTime: string; tracks: { time: string; text: string }[]; statusCode: string; statusDesc: string; pickupCode: string; receiverName?: string; receiverAddress?: string; receiverPhone?: string; stationName?: string; city?: string; postman?: string; postmanPhone?: string; eta?: string } {
  let mailNo = ""
  let company = ""
  let statusCode = ""
  let statusDesc = ""
  let pickupCode = ""
  let receiverName: string | undefined
  let receiverAddress: string | undefined
  let receiverPhone: string | undefined
  let stationName: string | undefined
  let city: string | undefined
  let postman: string | undefined
  let postmanPhone: string | undefined
  const tracks: { time: string; text: string }[] = []

  // 主路径：goods_express.html 的 window.rawData.store.traceData.shipping（实测结构）
  //   shippingName=快递公司 trackingNumber=运单号 shippingStatus=状态码 address=收货地址
  //   traces[]={info,time,status,statusTag} 新→旧；timeForecast.traceStatusDesc=官方状态文案
  //   cabinetData={code 取件码, address 代收点地址, companyName 驿站名, contactPhone 驿站电话}
  // 预计送达：拼多多的 timeForecast 里有官方文案（字段名不同版本不一致），
  // 只在浅层里找「预计…送达」，不猜具体 key。
  let eta: string | undefined
  const store = raw?.store
  const sh = store?.traceData?.shipping
  if (sh && typeof sh === "object") {
    eta = etaInObject(sh.timeForecast)
    mailNo = text(sh.trackingNumber) || mailNo
    company = text(sh.shippingName) || company
    receiverAddress = text(sh.address) || receiverAddress
    postman = text(sh.postmanInfo).replace(/^快递员[:：]\s*/, "") || undefined
    postmanPhone = text(sh.postmanContact) || undefined
    statusDesc = text(sh.timeForecast?.traceStatusDesc) || text(sh.timeForecast?.orderDetailStatusDesc) || statusDesc
    const st = sh.shippingStatus
    if (typeof st === "number") statusCode = String(st)
    const list = Array.isArray(sh.traces) ? sh.traces : []
    for (const t of list) {
      const info = text(t?.info)
      const time = text(t?.displayTime) || text(t?.time)
      if (info && !BOILERPLATE.test(info)) tracks.push({ time, text: info })
    }
    // 快递公司电话不是收货人手机，不当收货人电话用
  }
  const cab = store?.cabinetData
  if (cab && typeof cab === "object") {
    const code = text(cab.code)
    if (code && !pickupCode) pickupCode = code
    stationName = text(cab.companyName) || stationName
    if (!receiverAddress) receiverAddress = text(cab.address) || undefined
  }
  // 城市：从轨迹节点里的 province/city 取（节点自带 district/city/province）
  const list = Array.isArray(sh?.traces) ? sh.traces : []
  for (const t of list) {
    const c = text(t?.city)
    if (c && !city) { city = c; break }
  }

  // 兜底：没有实测结构时通用遍历（其它页面形态）
  if (!mailNo || tracks.length === 0) {
    walk(raw, obj => {
      if (!receiverName) {
        const n = text(obj.receiver_name || obj.receiverName)
        if (n && n.length >= 1 && n.length <= 12) receiverName = n
      }
      if (!receiverPhone) {
        const ph = text(obj.receiver_phone || obj.receiverPhone)
        if (/^1\d{10}$/.test(ph)) receiverPhone = ph
      }
      if (!mailNo) {
        const m = text(obj.tracking_number || obj.trackingNumber || obj.waybill_no || obj.mail_no)
        if (/^[A-Za-z0-9-]{8,}$/.test(m) && /\d{6,}/.test(m)) mailNo = m
      }
      if (!company) {
        const c = text(obj.shipping_name || obj.shippingName || obj.express_company_name || obj.logistics_name)
        if (c && c.length <= 20) company = c
      }
      if (tracks.length === 0) {
        const desc = text(obj.status_desc) || text(obj.trace_desc) || text(obj.desc) || text(obj.context)
        const time = text(obj.status_time) || text(obj.time) || text(obj.trace_time)
        if (desc && desc.length <= 200 && !BOILERPLATE.test(desc) && desc !== receiverAddress) tracks.push({ time, text: desc })
      }
    })
  }

  return {
    mailNo,
    company,
    latest: tracks.length > 0 ? tracks[0].text : "",
    latestTime: tracks.length > 0 ? tracks[0].time : "",
    tracks,
    statusCode,
    statusDesc,
    pickupCode,
    receiverName,
    receiverAddress,
    receiverPhone,
    stationName,
    city,
    postman,
    postmanPhone,
    eta,
  }
}

/* ---------------- 抓取 ---------------- */

function rawDataFromHtml(html: string): any {
  const m = html.match(/window\.rawData\s*=\s*(\{[\s\S]*?\});?\s*(?:window\.|<\/script>)/)
  if (!m) return null
  try { return JSON.parse(m[1].replace(/;\s*$/, "")) } catch { return null }
}

/** 从渲染后的页面文本里挖：页面上没有 rawData 时靠它 */
function parseOrderText(text: string): any[] {
  const cuts = text.split(/\n+/).map(s => s.trim()).filter(Boolean)
  const out: any[] = []
  for (let i = 0; i < cuts.length; i++) {
    const line = cuts[i]
    if (/^(已签收|已送达|待收货|待发货|待付款|运输中|派送中|已发货|交易成功|待评价)/.test(line)) {
      // 状态行上方几行通常是商品名 / 店铺
      const title = cuts.slice(Math.max(0, i - 3), i).filter(s => s.length > 6).pop() || ""
      const shop = cuts.slice(Math.max(0, i - 5), i).filter(s => /店|旗舰|专卖|官方/.test(s)).pop() || ""
      out.push({ statusHint: line, itemTitle: title, shopName: shop })
    }
  }
  return out
}

async function fetchRaw(url: string): Promise<string> {
  const res = await fetch(url, {
    headers: { Cookie: pddCookieHeader(), "User-Agent": SAFARI_UA, Referer: ORDERS_URL },
  })
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  return await res.text()
}

/** 给可能卡住的 WebView 调用加超时：物流页地图瓦片会持续请求，waitForLoad 可能永远等不到 */
function withTimeout<T>(p: Promise<T>, ms: number, fallback: T): Promise<T> {
  return Promise.race([p, delay(ms).then(() => fallback) as unknown as Promise<T>])
}

/** 打开页面并同时拿回：渲染后文本 / 所有 order_sn 链接 / rawData */
async function openPage(url: string): Promise<{ text: string; html: string; raw: any; orderSns: string[] }> {
  const controller = new WebViewController()
  try {
    await prepare(controller)
    await withTimeout(controller.loadURL(url), 12000, undefined as any)
    await withTimeout(controller.waitForLoad(), 12000, undefined as any)
    await delay(2200)
    const text = String(await withTimeout(controller.evaluateJavaScript("return document.body?document.body.innerText:''"), 6000, "") || "")
    const html = String((await withTimeout(controller.getHTML(), 8000, "")) || "")
    let raw: any = null
    try {
      const json = String(await withTimeout(
        controller.evaluateJavaScript("return window.rawData ? JSON.stringify(window.rawData) : ''"), 8000, "") || "")
      if (json) raw = JSON.parse(json)
    } catch { }
    const orderSns: string[] = []
    // 单号带日期前缀和横杠（261004-000000000000000）或纯数字，两种都要收
    const SN_RE = /order_sn=([0-9]{6,}-?[0-9]{6,})/g
    for (const m of html.matchAll(SN_RE)) if (!orderSns.includes(m[1])) orderSns.push(m[1])
    for (const m of text.matchAll(SN_RE)) if (!orderSns.includes(m[1])) orderSns.push(m[1])
    return { text, html, raw, orderSns }
  } finally {
    controller.dispose()
  }
}

export interface PddExpressTabs {
  /** 已签收 */ sign?: number
  /** 待取件 */ got?: number
  /** 派件中 */ send?: number
  /** 运输中 */ onroad?: number
  /** 其他 */ others?: number
}

export interface PddDiscoverResult {
  orders: PddOrder[]
  html: string
  logged: boolean
  blocked: boolean
  text: string
  humanNeeded?: boolean
  /** 平台「待收货」tab 的真实结果：pending=有单 / empty=确认没单 / unknown=接口没拿到 */
  pendingTab?: "pending" | "empty" | "unknown"
  /** 平台物流 tab 的数量（已签收/待取件/派件中/运输中/其他） */
  expressTabs?: PddExpressTabs
  /** 本次订单来源：api=平台筛选接口 / all=接口没拿到单时兜底全量 */
  scope?: "pending" | "all"
}

/** 点页面自带的订单筛选 tab，返回 'ok' 表示点中 */
const clickTabJs = (label: string) => `return (function(){
  var t=[].slice.call(document.querySelectorAll('.fixed-nav-item-orders span,.fixed-nav-item-orders,span,div,a')).find(function(e){
    var s=(e.textContent||'').trim(); return s==='${label}' && e.children.length<3 });
  if(t){ t.click(); return 'ok'; } return 'no';
})()`

/**
 * 钩住 XHR，把 order_list_v4 的响应体存进 window.__ol。
 * 拼多多列表走 XHR（不是 fetch）；请求带 anti_content 风控签名，我们不去算它，只拿页面自己请求回来的结果。
 * 必须在 documentStart 注入，首屏那次请求才能捕到。
 */
const PDD_XHR_HOOK = `(function(){
  if (window.__pddOlHooked) return;
  window.__pddOlHooked = 1;
  window.__ol = [];
  var op = XMLHttpRequest.prototype.open, sd = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.open = function(m, u){ try{ this.__u = String(u||'') }catch(e){}; return op.apply(this, arguments) };
  XMLHttpRequest.prototype.send = function(body){
    var self = this;
    try {
      if (/order_list_v4/.test(self.__u || '')) {
        var ty = '';
        try { ty = JSON.parse(String(body||'{}')).type || '' } catch(e){}
        self.addEventListener('load', function(){
          try { window.__ol.push({ type: ty, text: String(self.responseText||'') }) } catch(e){}
        });
      }
    } catch(e){}
    return sd.apply(this, arguments);
  };
})()`

/** 取指定 type 的最后一条响应原文（页面自己发起的请求） */
const getRespJs = (type: string) => `return (function(){
  var a=(window.__ol||[]).filter(function(o){return o.type==='${type}'});
  return a.length ? a[a.length-1].text : '';
})()`

/**
 * 解析 order_list_v4 响应。
 * 实测结构：{server_time, orders:[...], extra_info, ...}，订单字段是蛇形：
 *   order_sn / tracking_number / shipping_id / order_status_prompt / order_goods[].goods_name / mall.mall_name
 * 待收货响应还带 express_tab.tab_list（已签收/待取件/派件中/运输中/其他，每项有 tab_num）。
 */
export function parseOrderListResponse(json: string): { orders: PddOrder[]; expressTabs?: PddExpressTabs } {
  let d: any = null
  try { d = JSON.parse(json || "") } catch { return { orders: [] } }
  const out: PddOrder[] = []
  const raw = Array.isArray(d?.orders) ? d.orders
    : (d?.orders && typeof d.orders === "object" ? Object.values(d.orders) : [])
  for (const o of raw as any[]) {
    if (!o || typeof o !== "object") continue
    const sn = text(o.order_sn || o.orderSn)
    if (!SN_OK(sn)) continue
    const g = Array.isArray(o.order_goods) ? o.order_goods[0]
      : (Array.isArray(o.orderGoods) ? o.orderGoods[0] : null)
    out.push({
      orderSn: sn,
      itemTitle: text(g?.goods_name) || text(g?.goodsName) || text(o.goods_name),
      shopName: text(o.mall?.mall_name) || text(o.mall?.mallName) || text(o.mall_name),
      statusHint: text(o.order_status_prompt) || text(o.order_status_desc) || text(o.orderStatusPrompt),
      trackingNumber: text(o.tracking_number) || text(o.trackingNumber),
      shippingId: text(o.shipping_id) || text(o.shippingId),
    })
  }
  let expressTabs: PddExpressTabs | undefined
  const tabs = d?.express_tab?.tab_list
  if (Array.isArray(tabs) && tabs.length) {
    expressTabs = {}
    for (const t of tabs) {
      const id = text(t?.tab_id)
      const n = Number(t?.tab_num) || 0
      if (id === "sign") expressTabs.sign = n
      else if (id === "got") expressTabs.got = n
      else if (id === "send") expressTabs.send = n
      else if (id === "onroad") expressTabs.onroad = n
      else if (id === "others") expressTabs.others = n
    }
  }
  return { orders: out, expressTabs }
}

/**
 * 读拼多多订单。
 *
 * 主线路：用平台自己的筛选接口。拼多多订单页点 tab 时会发 `POST /proxy/api/api/aristotle/order_list_v4`，
 * body 里的 type 就是筛选条件（all / unshipping 待发货 / unreceived 待收货）。请求带 anti_content 风控签名，
 * 我们不去算，而是在 documentStart 钩住 XHR 把页面自己请求回来的响应收下来。
 *   1) 先点「待收货」——有单就用它（真正的平台筛选）；
 *   2) 没单或接口没拿到 → 兜底「全部」（rawData 预渲染全量，含历史单），跟淘宝/京东一致。
 */
export async function pddDiscoverOrders(): Promise<PddDiscoverResult> {
  const c = new WebViewController()
  try {
    await prepare(c)
    // 钩子必须在页面脚本之前注入，首屏那次 order_list_v4 才捕得到
    try { await withTimeout(c.addUserScript({ source: PDD_XHR_HOOK, injectionTime: "documentStart" }), 3000, undefined as any) } catch { }
    // 无参数 orders.html 是实测能跑通的入口；tab 只能点，不能靠 URL 参数
    await withTimeout(c.loadURL(ORDERS_URL), 12000, undefined as any)
    await withTimeout(c.waitForLoad(), 12000, undefined as any)
    await delay(2600)
    const text = String(await withTimeout(c.evaluateJavaScript("return document.body?document.body.innerText:''"), 6000, "") || "")
    const html = String((await withTimeout(c.getHTML(), 8000, "")) || "")
    let raw: any = null
    try {
      const j = String(await withTimeout(
        c.evaluateJavaScript("return window.rawData?JSON.stringify(window.rawData):''"), 8000, "") || "")
      if (j) raw = JSON.parse(j)
    } catch { }
    const orderSns: string[] = []
    const SN_RE = /order_sn=([0-9]{6,}-?[0-9]{6,})/g
    for (const m of html.matchAll(SN_RE)) if (!orderSns.includes(m[1])) orderSns.push(m[1])

    const result: PddDiscoverResult = { ...discoverFrom({ text, html, raw, orderSns }), pendingTab: "unknown" }
    if (result.blocked || !result.logged) return result

    // ① 平台筛选：点「待收货」，读页面自己请求回来的那份响应
    let pending: PddOrder[] = []
    let gotResp = false
    try {
      const clicked = String(await withTimeout(c.evaluateJavaScript(clickTabJs("待收货")), 6000, "") || "")
      if (clicked.indexOf("ok") >= 0) {
        await delay(3500)
        const resp = String(await withTimeout(c.evaluateJavaScript(getRespJs("unreceived")), 8000, "") || "")
        if (resp) {
          gotResp = true
          const parsed = parseOrderListResponse(resp)
          pending = parsed.orders
          result.expressTabs = parsed.expressTabs
        }
      }
    } catch { }

    if (pending.length > 0) {
      // 用全量里的富字段补全（同名单号优先），接口没给的字段保留空
      const bySn = new Map(result.orders.map(o => [o.orderSn, o]))
      result.orders = pending.map(p => {
        const rich = bySn.get(p.orderSn)
        return {
          orderSn: p.orderSn,
          itemTitle: p.itemTitle || rich?.itemTitle || "",
          shopName: p.shopName || rich?.shopName || "",
          statusHint: p.statusHint || rich?.statusHint || "",
          trackingNumber: p.trackingNumber || rich?.trackingNumber,
          shippingId: p.shippingId || rich?.shippingId,
        }
      })
      result.pendingTab = "pending"
      result.scope = "pending"
    } else {
      // ② 兜底：待收货没单（接口明确返回空）或接口没拿到 → 用全量（历史单也算）
      result.pendingTab = gotResp ? "empty" : "unknown"
      result.scope = "all"
      try { await withTimeout(c.evaluateJavaScript(clickTabJs("全部")), 6000, "") } catch { }
    }

    // 诊断落盘（小体积，供排查登录墙/空态/改版）
    if (result.orders.length === 0) {
      try {
        const dir = `${FileManager.appGroupDocumentsDirectory}/cc`
        if (!FileManager.existsSync(dir)) FileManager.createDirectorySync(dir, true)
        FileManager.writeAsStringSync(`${dir}/pddOrdersDump.txt`,
          `textLen=${text.length} htmlLen=${html.length} pendingTab=${result.pendingTab} scope=${result.scope}\n${text.slice(0, 800)}`)
      } catch { }
    }
    return result
  } finally {
    try { c.dispose() } catch { }
  }
}

function discoverFrom(page: { text: string; html: string; raw: any; orderSns: string[] }): { orders: PddOrder[]; html: string; logged: boolean; blocked: boolean; text: string; humanNeeded?: boolean } {
  const { text, html, raw, orderSns } = page
  let orders: any[] = []
  if (raw) orders = extractOrders(raw)

  // 页面 HTML 里的按钮 URL 直接带 order_sn / tracking_number / goods_name（历史单也在）。
  // 拼多多单号是 261004-000000000000000 这种带横杠的，rawData 遍历经常吃不到，这里按 URL 兜底抽取。
  if (orders.length === 0) {
    const bySn = new Map<string, any>()
    for (const m of html.matchAll(/order_sn=([0-9]{6,}-?[0-9]{6,})/g)) {
      const sn = m[1]
      if (!bySn.has(sn)) bySn.set(sn, { orderSn: sn, itemTitle: "", shopName: "", statusHint: "" })
      // 就近找同一条 goods_express / 评价 URL 里的运单号与商品名
      const at = html.indexOf(m[0])
      const seg = html.slice(Math.max(0, at - 400), at + 400)
      const o = bySn.get(sn)!
      if (!o.trackingNumber) {
        const t = seg.match(/tracking_number=([A-Za-z0-9]{8,})/)
        if (t) o.trackingNumber = t[1]
      }
      if (!o.itemTitle) {
        const g = seg.match(/goods_name=([^&"\\]+)/)
        if (g) { try { o.itemTitle = decodeURIComponent(g[1]) } catch { o.itemTitle = g[1] } }
      }
    }
    orders = [...bySn.values()]
  }
  if (orders.length === 0 && orderSns.length > 0) {
    const fromText = parseOrderText(text)
    orders = orderSns.map((sn, i) => ({
      orderSn: sn,
      itemTitle: fromText[i] && fromText[i].itemTitle || "",
      shopName: fromText[i] && fromText[i].shopName || "",
      statusHint: fromText[i] && fromText[i].statusHint || "",
    }))
  }
  if (orders.length === 0) {
    const fromText = parseOrderText(text)
    if (fromText.length > 0) orders = fromText.map((o, i) => ({ orderSn: "", ...o }))
  }
  const looksLogin = /登录后查看|请登录|手机登录/.test(text.slice(0, 400)) || /login\.html/.test(String(html.slice(0, 2000)))
  // 风控/验证页不是登录墙但也不是订单页：不认成"已登录 0 单"，否则会把旧拼多多数据清掉
  const blocked = !looksLogin && orders.length === 0 && (
    /访问过于频繁|请求过于频繁|操作太频繁|稍后再试|安全验证|安全校验|滑块验证|验证码|人机验证|风控|异常访问|请先完成验证/.test(text.slice(0, 600))
    || /captcha|risk|verify/.test(String(html.slice(0, 3000)))
  )
  // 只有真滑块/验证码页才值得弹窗给人；频繁限流类等一下自己就过，弹窗反而打断用户
  const humanNeeded = blocked && /滑块验证|验证码|人机验证|安全验证|请先完成验证|captcha/i.test(text.slice(0, 600))
  return { orders, html, logged: !looksLogin && !blocked, blocked, text, humanNeeded }
}

/** 解析物流页文本：运单号 / 快递公司 / 最新节点 */
export function parseLogisticsText(text: string): { mailNo: string; company: string; latest: string } {
  const lines = text.split(/\n+/).map(s => s.trim()).filter(Boolean)
  let mailNo = ""
  let company = ""
  let latest = ""
  const mail = text.match(/(?:运单号|快递单号)[:：\s]*([A-Za-z0-9-]{8,})/)
  if (mail) mailNo = mail[1]
  const comp = text.match(/(顺丰|中通|圆通|韵达|申通|邮政|EMS|极兔|百世|德邦|京东|宅急送|天天|优速|丰网|菜鸟)/)
  if (comp) company = comp[1] + (/快递|速递|快运|物流/.test(text) ? "快递" : "")
  const node = lines.find(l => /签收|派送|运输|到达|发出|揽收|投递|派件/.test(l) && l.length > 6)
  if (node) latest = node
  return { mailNo, company, latest }
}

export async function pddFetchPackage(order: { orderSn: string; itemTitle: string; shopName: string; statusHint: string; trackingNumber?: string; shippingId?: string }): Promise<Pkg> {
  if (!order.orderSn) return { orderId: `pdd:${Date.now()}`, source: "pdd", itemTitle: order.itemTitle, shopName: order.shopName, company: "", mailNo: "", latest: order.statusHint, status: classify(order.statusHint), updatedAt: Date.now() }

  const base = {
    orderId: `pdd:${order.orderSn}`,
    source: "pdd" as const,
    itemTitle: order.itemTitle,
    shopName: order.shopName,
    company: "",
    mailNo: order.trackingNumber || "",
    latest: order.statusHint,
    status: classify(order.statusHint),
    updatedAt: Date.now(),
  }
  // 退款成/已取消：不是快递流程，不开页（开了只会拿回订单级「拣货」伪轨迹）
  // 清掉 mailNo，upsert 的「无运单号不入库」会把它们挡在外面
  if (closedOrderStatus(order.statusHint)) {
    return { ...base, mailNo: "", status: "cancelled", stale: true }
  }
  // 无运单号（话费充值/虚拟商品等）：也没有快递可查
  const ship = String(order.shippingId ?? "")
  if (!order.trackingNumber && (!ship || ship === "0" || ship === "999")) return base

  // 实测：旧代码写死的 logistics.html 是废页（只有「正在加载中」，无 rawData）；
  // 真页是订单页里「查看物流」按钮指向的 goods_express.html，只带 order_sn 也能出完整 rawData。
  const q = [`order_sn=${encodeURIComponent(order.orderSn)}`]
  if (order.trackingNumber) q.push(`tracking_number=${encodeURIComponent(order.trackingNumber)}`)
  if (order.shippingId) q.push(`shipping_id=${encodeURIComponent(order.shippingId)}`)
  const url = `https://mobile.yangkeduo.com/goods_express.html?${q.join("&")}`
  const page = await openPage(url)
  const info = page.raw ? extractLogistics(page.raw) : extractLogistics({})
  const textInfo = parseLogisticsText(page.text)
  // 官方状态码优先（statusFromCode），没有就退回关键词
  const latest = info.statusDesc || textInfo.latest || info.latest || order.statusHint || ""
  const status = statusFromCode(info.statusCode) ?? classify(latest)
  const etaSrc = [info.eta, latest, textInfo.latest].filter(Boolean).join(" ")
  return {
    orderId: `pdd:${order.orderSn}`,
    source: "pdd",
    itemTitle: order.itemTitle,
    shopName: order.shopName,
    company: info.company || textInfo.company,
    mailNo: info.mailNo || order.trackingNumber || textInfo.mailNo,
    latest,
    status,
    tracks: info.tracks,
    lastTrackAt: timeOfTrack(info.tracks[0]?.time || "") || undefined,
    pickupCode: info.pickupCode || undefined,
    receiverName: info.receiverName,
    receiverAddress: info.receiverAddress,
    receiverPhone: info.receiverPhone,
    stationName: info.stationName,
    city: info.city,
    eta: etaInText(etaSrc),
    etaAt: etaTimeInText(etaSrc)?.at,
    updatedAt: Date.now(),
  }
}

export async function pddSyncAll(
  onProgress?: (done: number, total: number) => void,
  options?: { deadline?: number },
): Promise<Pkg[]> {
  const deadline = options?.deadline ?? Number.POSITIVE_INFINITY
  let res = await pddDiscoverOrders()
  // 限流/排队类自己再试一次（隔 8 秒）；还不行就本轮跳过，下次同步自然恢复
  if (res.blocked && !res.humanNeeded) {
    await delay(8000)
    res = await pddDiscoverOrders()
    if (res.blocked && !res.humanNeeded) throw new Error("拼多多访问频繁被限流，本轮跳过，下次同步再试")
  }
  const { orders, logged, humanNeeded } = res
  if (humanNeeded) throw new Error("拼多多需要人机验证，请手动完成")
  if (!logged) throw new Error("拼多多登录态无效，请重新登录")
  if (orders.length === 0) return []
  // 只做近 20 天的单。退回全量时（接口没抓到）会把几个月前的历史单一起拿出来，
  // 每单一个物流网页，既费时间也容易被风控。有单号日期前缀/订单时间就按它筛。
  const RECENT_MS = 20 * 86_400_000
  const cutoff = Date.now() - RECENT_MS
  let picked = orders.filter(o => !o.orderTime || o.orderTime >= cutoff)
  // 条数闸：正常待收货不会超过 30 条，超过说明拿的是全量，只取最新的 30 条
  const MAX_ORDERS = 30
  if (picked.length > MAX_ORDERS) {
    picked = [...picked].sort((a, b) => (b.orderTime ?? 0) - (a.orderTime ?? 0)).slice(0, MAX_ORDERS)
  }
  const out: Pkg[] = []
  // 已完成 / 已关闭的订单：订单状态本身就说完了，**不再开物流页**（否则几十个历史单每单一个网页），
  // 只产出一条精简记录，让 upsert 能更新已有条目（mailNo 为空 → 新单不入库）。
  const isDone = (h: string) => /已完成|交易完成|已关闭|交易关闭|已取消|退款成功|已退款/.test(h || "")
  const doneOrders = picked.filter(o => isDone(o.statusHint))
  const liveOrders = picked.filter(o => !isDone(o.statusHint))
  for (const o of doneOrders) {
    out.push({
      orderId: `pdd:${o.orderSn}`,
      source: "pdd",
      itemTitle: o.itemTitle,
      shopName: o.shopName,
      company: "",
      mailNo: "",
      latest: o.statusHint,
      status: classify(o.statusHint),
      updatedAt: Date.now(),
    })
  }
  // 还没完成的：每单要开一个网页，页间留间隔，到时间就先收尾（组件里只有 18 秒预算）
  // 一轮最多 12 单，超出用指针轮换，否则待收货多的用户永远只看得到前 12 条。
  const MAX_LIVE = 12
  let livePicked = liveOrders
  if (liveOrders.length > MAX_LIVE) {
    let cur = 0
    try { cur = Number(Storage.get<number>("cc.pddOrderCursor") ?? 0) || 0 } catch { }
    cur = ((cur % liveOrders.length) + liveOrders.length) % liveOrders.length
    livePicked = [...liveOrders.slice(cur), ...liveOrders.slice(0, cur)].slice(0, MAX_LIVE)
    try { Storage.set("cc.pddOrderCursor", (cur + MAX_LIVE) % liveOrders.length) } catch { }
  }
  for (let i = 0; i < livePicked.length; i++) {
    if (Date.now() > deadline) break
    try { out.push(await pddFetchPackage(livePicked[i])) } catch { }
    onProgress?.(i + 1, livePicked.length)
    if (i < livePicked.length - 1) await delay(600)
  }
  return out
}


export async function pddHumanVerify(): Promise<boolean> {
  const controller = new WebViewController()
  try {
    await prepare(controller)
    await controller.loadURL(ORDERS_URL)
    await controller.waitForLoad()
    let presented = true
    const pr = controller.present({ fullscreen: true, navigationTitle: "拼多多需要验证" })
      .then(() => { presented = false }).catch(() => { presented = false })
    const deadline = Date.now() + 3 * 60_000
    let ok = false
    while (presented && Date.now() < deadline) {
      await delay(1200)
      if (!presented) break
      // 过了 = 订单列表出现 order_sn 链接（验证页没有）
      const html = String(await controller.evaluateJavaScript<string>("return document.documentElement ? document.documentElement.outerHTML.slice(0, 500000) : ''") || "")
      if (/order_sn=\d{8,}/.test(html)) { ok = true; break }
    }
    if (presented) { try { await controller.dismiss() } catch { } }
    try { await pr } catch { }
    await delay(400)
    if (ok) {
      // 会话已更新，顺手存回钥匙串
      try { await saveSession(controller) } catch { }
    }
    return ok
  } finally {
    controller.dispose()
  }
}
