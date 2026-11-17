import { classify, closedOrderStatus, Pkg, timeOfTrack } from "./model"
import { normalizePickupCode } from "./codes"
import { etaInText, etaTimeInText } from "./eta"
import { diag } from "./net"

export const JD_COOKIE_KEY = "jd.cookies"

/** 与淘宝/拼多多保持一致的 Safari UA */
const SAFARI_UA = "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1"

const LOGIN_URL = "https://plogin.m.jd.com/login/login?appid=0&returnurl=https%3A%2F%2Fhome.m.jd.com%2FmyJd%2Fnewhome.action"

/** 页面加载加超时：京东页会挂很久不报错，不设超时会把整轮同步拖死 */
function pageTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = (setTimeout as any)(() => reject(new Error("页面超时")), ms)
    p.then(v => { clearTimeout(t); resolve(v) }, e => { clearTimeout(t); reject(e) })
  })
}
// 京东订单中心首页（my_order_entrance 里点「全部订单」进入全量列表）；
// 订单列表页 URL 自带 state 参数可直达「待收货」，但拦截判定依赖首页入口元素，保留首页入口再点全部
const MY_URL = "https://my.m.jd.com/index.html?sceneval=2"

/** 订单跟踪页：真正带承运人 / 运单号 / 物流节点的地方 */
const TRACK_URL = (o: { orderId: string; skuId?: string; shopId?: string }) =>
  `https://trade.m.jd.com/order/deal_wuliu_jdm.shtml?from=orderdetail&dealState=7&dealId=${o.orderId}` +
  `&orderType=22&skuid=${o.skuId || ""}&shopid=${o.shopId || ""}&source=m_inner_orderList.track_orderTrack`

/**
 * 登录页修版脚本。
 *
 * WebViewController 顶部导航栏是半透明毛玻璃，盖住了网页最上面约 116pt。
 * 京东登录页的 logo/标题区就在这块区域里，输入框贴着它，表现为「显示不全 + 点不到手机号」。
 * 这里用 body 上顶 padding（取真实安全区高度）把整页推下去，并允许页面滚动，键盘弹出也能滚到输入框。
 */
const JD_LOGIN_FIX = `(function(){
  var CSS = [
    'html,body{height:auto!important;min-height:100%!important;overflow-y:auto!important;',
    '-webkit-overflow-scrolling:touch!important;background:#fff!important;}',
    'body{padding-top:calc(max(env(safe-area-inset-top, 0px), 96px) + 8px)!important;box-sizing:border-box!important;}',
    '#app,.page{min-height:0!important;}',
    'input{font-size:16px!important;}'
  ].join('');
  function apply(){
    var st = document.getElementById('agent-jd-fix');
    if(!st){ st = document.createElement('style'); st.id='agent-jd-fix'; (document.head||document.documentElement).appendChild(st); }
    if(st.textContent !== CSS) st.textContent = CSS;
  }
  apply();
  var n = 0, iv = setInterval(function(){ apply(); if(++n > 40) clearInterval(iv) }, 300);
})()`

declare const fetch: any
const delay = (ms: number) => new Promise<void>(resolve => (setTimeout as any)(resolve, ms))

/* ---------------- 登录态 ---------------- */

export function jdCookies(): any[] {
  const raw = Keychain.get(JD_COOKIE_KEY)
  if (!raw) return []
  try { const v = JSON.parse(raw); return Array.isArray(v) ? v : [] } catch { return [] }
}

export function jdHasLogin(): boolean {
  return jdCookies().some((c: any) => c.name === "pt_key" && !!c.value)
}

export function jdClearLogin(): void {
  Keychain.remove(JD_COOKIE_KEY)
  // 连带清掉 WebView 持久仓库里的 jd cookie：只删 keychain 的话，
  // 下次打开登录页会被旧会话自动登录（而且京东的 __jda 设备指纹还在）
  try {
    const c = new WebViewController()
    c.getAllCookies().then((cookies: any[]) => {
      try {
        for (const ck of (cookies || [])) {
          const dom = String(ck.domain || "")
          if (/(^|\.)jd\.com$|360buy|jd\.local/i.test(dom)) { try { c.deleteCookie(ck) } catch { } }
        }
      } catch { }
      try { c.dispose() } catch { }
    }).catch(() => { try { c.dispose() } catch { } })
  } catch { }
}

const JD_UA_KEY = "jd.ua"

/** 当前生效的京东 UA。
 *  指纹轮换已停用（实测“限流”是空态误判，没必要换身份）：固定用默认 Safari UA，
 *  并把之前轮换留下的 jd.ua 清掉，恢复到原始指纹。*/
export function jdUA(): string {
  try { Storage.remove(JD_UA_KEY) } catch { }
  return SAFARI_UA
}

/** 重置设备身份：已停用。保留函数只为了以后真撞风控时有地方扩。 */
export function jdResetDevice(): void {
  jdClearLogin()
}

/** 把 WebView 里的 jd.com Cookie 存进钥匙串（pt_key 是 HttpOnly，只有 getAllCookies 能拿到） */
async function saveSession(controller: WebViewController): Promise<number> {
  const cookies = await controller.getAllCookies().catch(() => [])
  const usable = (cookies || []).filter((c: any) => /(^|\.)jd\.com$|(^|\.)360buy\.com$/i.test(String(c.domain || "")))
  if (usable.length === 0) return 0
  // 同名同域只留最新一条，避免反复 setCookie 时相互覆盖
  const map = new Map<string, any>()
  for (const c of usable) map.set(`${c.name}|${c.domain}|${c.path || "/"}`, c)
  const dedup = Array.from(map.values())
  Keychain.set(JD_COOKIE_KEY, JSON.stringify(dedup))
  return dedup.length
}

const hasPtKey = (cookies: any[]) =>
  (cookies || []).some((c: any) => c && c.name === "pt_key" && !!c.value)


/* ---------------- 页面抓取 ---------------- */

async function prepare(controller: WebViewController): Promise<void> {
  try { await controller.setCustomUserAgent(jdUA()) } catch { }
  // WebView 持久仓库里本来就有登录会话时不要重复注入，否则会产生同名重复 Cookie 反而干扰
  const existing = await controller.getAllCookies().catch(() => [])
  if (hasPtKey(existing as any[])) return
  const seen = new Set<string>()
  for (const c of jdCookies()) {
    const k = `${c.name}|${c.domain}`
    if (seen.has(k)) continue
    seen.add(k)
    try { await controller.setCookie(c) } catch { }
  }
}

/** 轮询等待某个元素出现（Taro 页面渲染时间不固定） */
async function waitForSelector(controller: WebViewController, selector: string, timeoutMs = 12000): Promise<boolean> {
  const js = `return document.querySelectorAll('${selector.replace(/'/g, "\\'")}').length`
  const end = Date.now() + timeoutMs
  while (Date.now() < end) {
    const n = Number(await controller.evaluateJavaScript<number>(js).catch(() => 0) || 0)
    if (n > 0) return true
    await delay(400)
  }
  return false
}

/** 打开页面，返回可见文本（京东是 Taro 自定义元素，innerText 为空，只能取 textContent） */
async function openPage(url: string, waitMs = 2600): Promise<{ text: string; html: string; url: string }> {
  const controller = new WebViewController({ preferredContentMode: "mobile" })
  try {
    await prepare(controller)
    await controller.loadURL(url)
    try { await pageTimeout(controller.waitForLoad(), 15000) } catch { }
    await delay(waitMs)
    const text = String(await controller.evaluateJavaScript<string>(`return (function(){
      if (!document.body) return '';
      var clone = document.body.cloneNode(true);
      [].slice.call(clone.querySelectorAll('script,style,noscript')).forEach(function(s){ s.parentNode && s.parentNode.removeChild(s) });
      return (clone.textContent || '').replace(/\\s+/g, ' ').trim();
    })()`).catch(() => "") || "")
    const html = String((await controller.getHTML().catch(() => "")) || "")
    return { text, html, url: String(controller.url || url) }
  } finally {
    controller.dispose()
  }
}

/* ---------------- 解析 ---------------- */

export interface JdOrder {
  orderId: string
  itemTitle: string
  shopName: string
  statusHint: string
  /** 列表卡片上那行物流概要，例如「预计11月9日发货，11月11日送达」 */
  delivery?: string
  skuId?: string
  shopId?: string
  /** 下单时间（卡片文案里的日期，解析成毫秒）；抽不到就是 undefined */
  orderTime?: number
}

/**
 * 从文案里抠取件码（同 handycode 的正则）：京东自提/快递柜的码不一定单独给字段，
 * 多数时候就在「取件码 1234」「提货码：A1B2」这种句子里。
 */
const PICKUP_CODE_RE = /(?:取件码|提货码|取货码|凭码|自提码)[:：\s]*([A-Za-z0-9-]{3,12})(?![A-Za-z0-9-])/

function pickupCodeOf(...texts: string[]): string {
  for (const t of texts) {
    if (!t) continue
    const m = PICKUP_CODE_RE.exec(t)
    if (m) return normalizePickupCode(m[1])
  }
  return ""
}

/** 京东的状态词比淘宝/拼多多多，先归一化再分类 */
function classifyJd(hint: string): Pkg["status"] {
  const t = (hint || "").trim()
  if (!t) return "none"
  // 退款/退货/取消/交易关闭：终态（原来归成 none，结果退款单挂在包裹页里）
  const closed = closedOrderStatus(t)
  if (closed) return closed
  if (/待付款|待支付/.test(t)) return "none"
  if (/已完成|已签收|已送达|交易完成|已评价|^完成$/.test(t)) return "delivered"
  if (/待发货|未发货|待出库|正在出库|准备出库|等待发货|仓库处理中/.test(t)) return "unshipped"
  if (/待收货|运输|派送|揽收|已发货|待取件|配送/.test(t)) return "transit"
  return classify(t)
}

/** 在「我的」页里点开「全部订单」，等待 Taro 渲染，然后把每张订单卡片抠出来 */
const DISCOVER_JS = `return (function(){
  function txt(el){ return el ? (el.textContent || '').replace(/\\s+/g, ' ').trim() : ''; }
  function cardOf(el){
    var n = el;
    while (n && n.parentElement) {
      n = n.parentElement;
      if (n.querySelector && n.querySelector('[class*="order_item"]')) return n;
    }
    return null;
  }
  var out = [], seen = {};
  [].slice.call(document.querySelectorAll('[class*="order_state"]')).forEach(function(st){
    var card = cardOf(st) || st.parentElement;
    if (!card) return;
    var ep = card.querySelector('[data-eparam]');
    var json = {};
    if (ep) {
      var raw = ep.getAttribute('data-eparam') || '';
      try { json = JSON.parse(raw) } catch (e) { try { json = JSON.parse(raw.replace(/&quot;/g, '"')) } catch (e2) {} }
    }
    var id = String(json.orderid || '');
    if (!/^\\d{8,}$/.test(id) || seen[id]) return;
    seen[id] = 1;
    var sku = (json.orderSkus && json.orderSkus[0]) || {};
    // 卡片文案里一定带下单时间（2026-11-10 12:22），历史单就靠它筛
    var cardTxt = txt(card);
    var tm = cardTxt.match(/20\\d{2}[-\/]\\d{1,2}[-\/]\\d{1,2}(?:\\s+\\d{1,2}:\\d{1,2}(?::\\d{1,2})?)?/);
    out.push({
      orderId: id,
      statusHint: txt(st),
      shopName: txt(card.querySelector('[class*="shop_title"]')),
      itemTitle: txt(card.querySelector('[class*="desc"]')),
      delivery: txt(card.querySelector('[class*="order_wuliubar"]')),
      timeText: tm ? tm[0] : '',
      skuId: String(sku.skuid || json.skuid || ''),
      shopId: String(json.shopId || sku.shopid || '')
    });
  });
  return JSON.stringify(out);
})()`

/**
 * 钩住 fetch/XHR，把京东自己的接口响应存下来。
 * 实测：「我的」页会调一个返回 waitReceiveCount / waitPayCount / waitCommentCount 的计数接口，
 * 这是平台自己的分类数字——先用它决定要不要开订单列表页，能少挨一次风控（列表接口会回 601「大促异常火爆」）。
 */
const JD_NET_HOOK = `(function(){
  if (window.__jdHooked) return;
  window.__jdHooked = 1;
  window.__jdCounts = null;
  function grab(t){
    try {
      if (!window.__jdCounts && String(t).indexOf('waitReceiveCount') >= 0) window.__jdCounts = String(t).slice(0, 4000);
    } catch(e){}
  }
  var of = window.fetch;
  if (of) {
    window.fetch = function(input, init){
      var p = of.apply(this, arguments);
      try {
        var u = typeof input === 'string' ? input : (input && input.url) || '';
        if (/api\\.m\\.jd\\.com|client\\.action/.test(u)) {
          p.then(function(r){ try { r.clone().text().then(grab).catch(function(){}) } catch(e){} }).catch(function(){});
        }
      } catch(e){}
      return p;
    };
  }
  var op = XMLHttpRequest.prototype.open, sd = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.open = function(m,u){ try{ this.__u = String(u||'') }catch(e){}; return op.apply(this, arguments) };
  XMLHttpRequest.prototype.send = function(b){
    var self = this;
    try {
      if (/api\\.m\\.jd\\.com|client\\.action/.test(self.__u||'')) {
        self.addEventListener('load', function(){ try { grab(String(self.responseText||'')) } catch(e){} });
      }
    } catch(e){}
    return sd.apply(this, arguments);
  };
})()`

/** 京东「我的」页自己的订单计数（平台口径） */
export interface JdCounts {
  /** 待付款 */
  waitPay: number
  /** 待收货 */
  waitReceive: number
  /** 待评价 */
  waitComment: number
}

export function parseJdCounts(raw: string): JdCounts | null {
  if (!raw || raw.indexOf("waitReceiveCount") < 0) return null
  const num = (k: string) => {
    const m = new RegExp(`"${k}"\\s*:\\s*"?([0-9]+)`).exec(raw)
    return m ? Number(m[1]) : undefined
  }
  const wr = num("waitReceiveCount")
  if (wr === undefined) return null
  return { waitReceive: wr, waitPay: num("waitPayCount") ?? 0, waitComment: num("waitCommentCount") ?? 0 }
}

/** 点「我的」页自带的「待收货」入口（data-eparam 里带 type=待收货） */
const CLICK_WAIT_RECEIVE_JS = `return (function(){
  var els = [].slice.call(document.querySelectorAll('[data-eparam]'));
  var t = els.filter(function(e){ return (e.getAttribute('data-eparam')||'').indexOf('待收货') >= 0 })[0];
  if (!t) return 'no';
  try { t.click() } catch(e){}
  return 'ok';
})()`

export async function jdDiscoverOrders(opts?: { wantHistory?: boolean }): Promise<{ orders: JdOrder[]; text: string; html: string; logged: boolean; blocked: boolean; counts?: JdCounts | null; scope?: "pending" | "all"; noPending?: boolean }> {
  const controller = new WebViewController({ preferredContentMode: "mobile" })
  try {
    await prepare(controller)
    // 钩子要在页面脚本之前注入，才能在「我的」页就捕到订单计数
    try { await controller.addUserScript({ source: JD_NET_HOOK, injectionTime: "documentStart" }) } catch { }
    await controller.loadURL(MY_URL)
    try { await pageTimeout(controller.waitForLoad(), 15000) } catch { }

    // 自愈：会话其实在 WebView 的 Cookie 仓库里，顺手存回钥匙串
    const cookieCount = await saveSession(controller)

    const loggedDom = await waitForSelector(controller, ".my_order_entrance", 14000)
    if (!loggedDom) {
      const html = String(await controller.getHTML().catch(() => "") || "")
      return { orders: [], text: "", html, logged: false, blocked: false }
    }

    let orders: JdOrder[] = []
    let text = ""
    let blocked = false
    let scope: "pending" | "all" = "all"

    // 平台的分类计数（待付款/待收货/待评价）：它比订单列表接口晚一点回来，轮询等一会
    let counts: JdCounts | null = null
    for (let i = 0; i < 10 && !counts; i++) {
      counts = parseJdCounts(String(await controller.evaluateJavaScript("return window.__jdCounts||''").catch(() => "") || ""))
      if (!counts) await delay(600)
    }

    // 待收货计数为 0 **不能**直接当成功：京东限流时页面什么都不显示，
    // 计数也可能是空值。唯一可靠的判据是——进「全部订单」，只要能看到历史单，
    // 就说明没被拦；全部订单也空且命中拦截词，才是真限流。
    // 这里不再短路，直接走下面的列表页流程（counts 为 0 时会自动点「全部订单」）。

    // 待收货计数 = 0 就是「真的没包裹」：这是京东页面自己给的分类数字，
    // 比解析文本可靠得多（空态页会带推荐商品，很容易被误判成风控页）。
    if (counts && counts.waitReceive === 0) {
      const html0 = String(await controller.getHTML().catch(() => "") || "")
      return { orders: [], text: "", html: html0, logged: true, blocked: false, counts, scope: "pending", noPending: true }
    }

    // 京东排队/限流拦截：只自动重试 1 次（用户要求：重试一次不行就跳过，下次同步自然恢复）；
    // 滑块/验证页另走 humanVerify
    for (let attempt = 0; attempt < 2; attempt++) {
      if (attempt > 0) {
        await delay(8000)
        await controller.loadURL(MY_URL)
        try { await pageTimeout(controller.waitForLoad(), 15000) } catch { }
        await waitForSelector(controller, ".my_order_entrance", 10000)
      }
      // 筛选优先：计数显示有待收货单 → 点「待收货」入口，只拉进行中的单（少开一次列表页）
      let usedFilter = false
      if (counts && counts.waitReceive > 0) {
        const r = String(await controller.evaluateJavaScript(CLICK_WAIT_RECEIVE_JS).catch(() => "") || "")
        usedFilter = r.indexOf("ok") >= 0
        if (usedFilter) await delay(1800)
      }
      if (!usedFilter) await clickAllOrders(controller)
      scope = usedFilter ? "pending" : "all"
      await waitForSelector(controller, '[class*="order_state"]', 12000)
      await delay(1500)
      orders = parseCards(await controller.evaluateJavaScript<string>(DISCOVER_JS).catch(() => "") || "")
      // 订单列表是懒加载：只读一次 DOM 只能拿到首屏那十来条。
      // 滚到底把剩下的催出来（连续两轮没新增就停，最多 8 轮）。
      {
        let stable = 0
        for (let i = 0; i < 8 && stable < 2; i++) {
          try { await controller.evaluateJavaScript("window.scrollTo(0, document.body.scrollHeight)") } catch { }
          await delay(800)
          const more = parseCards(await controller.evaluateJavaScript<string>(DISCOVER_JS).catch(() => "") || "")
          const before = orders.length
          const seen = new Set(orders.map(o => o.orderId))
          for (const o of more) if (!seen.has(o.orderId)) { orders.push(o); seen.add(o.orderId) }
          stable = orders.length === before ? stable + 1 : 0
        }
      }
      text = await readListText(controller)
      blocked = orders.length === 0 && !EMPTY_RE.test(text) && BLOCKED_RE.test(text)
      diag("jd-list", { scope, counts, cards: orders.length, blocked, empty: EMPTY_RE.test(text), hit: (text.match(BLOCKED_RE) || [""])[0], text: text.slice(0, 200) })
      diag("jd-list", { scope, counts, cards: orders.length, blocked, text: text.slice(0, 220) })
      if (orders.length > 0 || !blocked) break
      // 移动版被风控：试一次 PC 订单页（实测 order.jd.com 无 PC 登录态，会跳登录页，故不再探测）
      // 待收货筛选没拿到单 → 下一轮回「全部订单」兜底（历史单也在这里）
      // 只有真正的滑块/人机验证页才弹窗给人：排队页（大促火爆/稍后再试）等一下自动过，
      // 弹窗反而打断用户（用户实测：点个重试也弹窗很烦）
      const humanNeeded = HUMAN_VERIFY_RE.test(text)
      if (attempt === 1 && blocked && humanNeeded) {
        const ok = await humanVerify(controller, MY_URL)
        if (ok) {
          await clickAllOrders(controller)
          await waitForSelector(controller, '[class*="order_state"]', 12000)
          await delay(1500)
          orders = parseCards(await controller.evaluateJavaScript<string>(DISCOVER_JS).catch(() => "") || "")
          text = await readListText(controller)
          blocked = orders.length === 0 && !EMPTY_RE.test(text) && BLOCKED_RE.test(text)
      diag("jd-list", { scope, counts, cards: orders.length, blocked, empty: EMPTY_RE.test(text), hit: (text.match(BLOCKED_RE) || [""])[0], text: text.slice(0, 200) })
      diag("jd-list", { scope, counts, cards: orders.length, blocked, text: text.slice(0, 220) })
        }
      }
    }

    const html = String(await controller.getHTML().catch(() => "") || "")
    if (orders.length === 0) dumpDebug(text, html, cookieCount)
    return { orders, text, html, logged: true, blocked, counts, scope }
  } finally {
    controller.dispose()
  }
}

const PC_ORDER_URL = "https://order.jd.com/center/list.action"

/**
 * 京东 PC 订单页探测：淘宝的稳定线路就是 PC 版，京东一直只用移动版 my.m.jd.com。
 * 这里只探测不猜 DOM：被风控时开一次 PC 页，把标题/长度/orderId 样例写进日志，
 * 拿到真实结构再写解析。
 */
async function probePcOrders(controller: WebViewController): Promise<{ orderIds: string[] }> {
  try {
    await controller.loadURL(PC_ORDER_URL)
    try { await pageTimeout(controller.waitForLoad(), 12000) } catch { }
    await delay(1200)
    const raw = String(await controller.evaluateJavaScript<string>(`return (function(){
      try{
        var h = document.documentElement ? document.documentElement.outerHTML : ''
        var ids = [], re = /(?:orderId|orderid)=(\\d{6,})/g, m
        while ((m = re.exec(h))) { if (ids.indexOf(m[1]) < 0) ids.push(m[1]) }
        return JSON.stringify({
          href: location.href,
          title: document.title,
          len: h.length,
          n: ids.length,
          ids: ids.slice(0, 8),
          text: (document.body ? document.body.innerText.slice(0, 200) : '')
        })
      }catch(e){ return JSON.stringify({err:String((e&&e.message)||e)}) }
    })()`) || "{}")
    let info: any = {}
    try { info = JSON.parse(raw) } catch { }
    diag("jd-pc", info)
    return { orderIds: Array.isArray(info.ids) ? info.ids : [] }
  } catch { return { orderIds: [] } }
}

/** 拦截页分两类：滑块/验证页（需要人） vs 排队页（等一下自己就过）——只对人脸弹窗 */
const BLOCKED_RE = /大促异常火爆|为您找到以下相似商品|快速通道|稍后再试|快速验证|验证一下|滑动验证/
/** 京东空列表的原文：「下拉刷新 您暂时没有相关订单！」。
 *  这是页面功能完整（tab、刷新都在）的空态，不是风控。
 *  风控页不会写这句话——要么整页只剩「大促异常火爆」，要么直接空白。*/
const EMPTY_RE = /暂时没有相关订单|暂无相关订单|没有找到相关订单/
const HUMAN_VERIFY_RE = /快速验证|验证一下|滑动验证|人机验证|安全验证|captcha/i

/**
 * 自动重试不过时把验证页弹给用户：展示 WebView（带着会话 Cookie）让人过滑块，
 * 检测到页面回到正常订单入口自动收起并继续。同登录页交互，最多等 3 分钟。
 */
async function humanVerify(controller: WebViewController, url: string): Promise<boolean> {
  try {
    await controller.loadURL(url)
    try { await pageTimeout(controller.waitForLoad(), 15000) } catch { }
  } catch { }
  let presented = true
  const p = controller.present({ fullscreen: true, navigationTitle: "京东需要验证" })
    .then(() => { presented = false })
    .catch(() => { presented = false })
  const deadline = Date.now() + 3 * 60_000
  let ok = false
  while (presented && Date.now() < deadline) {
    await delay(1200)
    if (!presented) break
    // 验证过了 = 订单入口出现（拦截页没有这个元素）
    if (await waitForSelector(controller, ".my_order_entrance", 800)) { ok = true; break }
  }
  if (presented) { try { await controller.dismiss() } catch { } }
  try { await p } catch { }
  await delay(400)
  return ok
}

async function clickAllOrders(controller: WebViewController): Promise<void> {
  // 优先点「待收货」筛选 tab：只拉进行中的单，数据量小、也免了自己丢弃已完成订单；
  // 找不到 tab 时退回「全部订单」
  await controller.evaluateJavaScript<string>(`return (function(){
    var t = [].slice.call(document.querySelectorAll('div,span,a')).find(function(e){
      var s=(e.textContent||'').trim(); return (s==='待收货'||s==='进行中') && e.children.length<3 });
    if (t) { t.click(); return 'filter'; }
    var d = document.querySelector('.my_order_entrance.type_orders');
    if (d) { d.click(); return 'ok'; }
    var all = [].slice.call(document.querySelectorAll('div,span,a'));
    var hit = all.filter(function(e){ return (e.textContent||'').trim() === '全部订单' && e.children.length < 3 }).pop();
    if (hit) { hit.click(); return 'ok2'; }
    return 'no';
  })()`).catch(() => "")
}

/** 只取可见文本（去掉 script/style，京东页面里正文前面堆了一大堆脚本） */
async function readListText(controller: WebViewController): Promise<string> {
  return String(await controller.evaluateJavaScript<string>(`return (function(){
    if (!document.body) return '';
    var clone = document.body.cloneNode(true);
    [].slice.call(clone.querySelectorAll('script,style,noscript')).forEach(function(s){ s.parentNode && s.parentNode.removeChild(s) });
    return (clone.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 6000);
  })()`).catch(() => "") || "")
}

function jdTimeMs(s: string): number | undefined {
  const m = (s || "").match(/(\d{4})[-/](\d{1,2})[-/](\d{1,2})(?:\s+(\d{1,2}):(\d{1,2}))?/)
  if (!m) return undefined
  return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4] ?? 0), Number(m[5] ?? 0)).getTime()
}

function parseCards(raw: string): JdOrder[] {
  let list: any[] = []
  try { list = JSON.parse(raw || "[]") } catch { }
  if (!Array.isArray(list)) return []
  return list.map(o => ({
    orderId: String(o.orderId || ""),
    itemTitle: String(o.itemTitle || ""),
    shopName: String(o.shopName || ""),
    statusHint: String(o.statusHint || ""),
    delivery: String(o.delivery || ""),
    skuId: String(o.skuId || ""),
    shopId: String(o.shopId || ""),
    orderTime: jdTimeMs(String(o.timeText || "")),
  })).filter(o => o.orderId)
}

/** 解析不到订单时只记线索，不落整页：
 *  以前把整页 html 写到 iCloud/脚本/_agent_tmp，一是会无限变大，
 *  二是抓取内容里带着页面上的收货信息，没必要长期留在磁盘上。
 *  cc/syncDiag.log 自带 20KB 上限，足够看出是登录墙还是改版。 */
function dumpDebug(text: string, html: string, cookies: number): void {
  try {
    diag("jd-parse", {
      cookies,
      textLen: text.length,
      htmlLen: html.length,
      head: text.replace(/\s+/g, " ").slice(0, 600),
    })
  } catch { }
}

/** 订单跟踪页文本 → 运单号 / 承运人 / 最新节点 / 商品名 / 收货人信息 */
export function parseTrack(text: string): { mailNo: string; company: string; itemTitle: string; latest: string; tracks: { time: string; text: string }[]; receiverName?: string; receiverPhone?: string; receiverAddress?: string } {
  const cut = (text || "").split("可能您还想要")[0]

  const mailNo = (cut.match(/(?:运单号|快递单号|物流单号)\s*[:：]?\s*([A-Za-z0-9-]{8,})/) || [])[1] || ""
  const carrier = cut.match(/(?:国内承运人|承运人|配送方)\s*[:：]?\s*([^\s]{2,12})/)
  const company = (carrier ? carrier[1] : "").replace(/(?:预计|运单|单号|签收|已|待).*$/, "").trim()

  let itemTitle = ""
  const t = cut.match(/我要催单\s*([\s\S]{4,160}?)\s*(?:\d+\s*件|国内承运人|承运人|运单号|$)/)
  if (t) itemTitle = t[1].trim()

  // 收货人信息：跟踪页可见文本里若有「收货人信息：张三 138****1234 …」段就从那里挖；
  // 抓不到就留空不猜（页面结构变过多次，不硬编码容器）
  let receiverName: string | undefined
  let receiverPhone: string | undefined
  let receiverAddress: string | undefined
  if (cut.includes("收货人")) {
    const seg = cut.split(/收货人/)[1] || ""
    const line = seg.split("\n")[0] || ""
    const phone = line.match(/1\d{2}[\*]{2,4}\d{4}|1\d{2}\*{5}\d{3}|1[3-9]\d{9}/)
    if (phone) receiverPhone = phone[0]
    const name = line.match(/^\s*[:：]?\s*([^\s\d\*]{1,8})/)
    if (name && name[1].length >= 1) receiverName = name[1]
    const a = seg.match(/[\u4e00-\u9fa5]{2,10}(?:省|市)[\u4e00-\u9fa5]{0,12}(?:区|县|镇|街道)[^\n]{2,60}/)
    if (a) receiverAddress = a[0].trim()
  }

  // 时间轴：2026-11-09 09:35:34 您的订单已进入第三方卖家仓库，准备出库
  const nodes: { time: string; desc: string }[] = []
  const re = /(\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}:\d{2})\s*([\s\S]*?)(?=\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}:\d{2}|$)/g
  let m: RegExpExecArray | null
  while ((m = re.exec(cut))) {
    const desc = m[2].replace(/\s+/g, " ").trim()
    if (desc) nodes.push({ time: m[1], desc })
  }

  let latest = nodes.length > 0 ? nodes[0].desc : ""
  if (!latest) {
    const eta = cut.match(/(预计[^，。]{0,20}(?:发货|送达)[^，。]{0,30})/)
    if (eta) latest = eta[1]
  }

  return { mailNo, company, itemTitle, latest, tracks: nodes.map(n => ({ time: n.time.slice(5, 16), text: n.desc })), receiverName, receiverPhone, receiverAddress }
}

/** 已完成这类状态不需要再开跟踪页，省一次请求（京东很容易限流） */
function needTrackPage(hint: string): boolean {
  const t = (hint || "").trim()
  if (!t) return true
  return !/已完成|已取消|已关闭|交易完成|^完成$|退款成功|已退款/.test(t)
}

/** 从「【西安市】您的快件已送达 xxx店」这类文案里抠城市与驿站名 */
function placeOf(text: string): { city?: string; station?: string } {
  const t = (text || "").trim()
  const cityM = /【([^】]{2,12})】/.exec(t)
  const stM = /(?:送达|到达|已放于|存放于|已暂存)\s*([\u4e00-\u9fa5A-Za-z0-9·\-]{2,22}(?:店|驿站|快递柜|代理点|服务点|自提柜))/.exec(t)
  return { city: cityM ? cityM[1] : undefined, station: stM ? stM[1] : undefined }
}

/** 单笔订单 → 包裹（只在未完成时才走「订单跟踪」页拿承运人、运单号、最新节点） */
export async function jdFetchPackage(order: JdOrder, opts?: { forceTrack?: boolean }): Promise<Pkg> {
  let mailNo = ""
  let company = ""
  let recvName: string | undefined
  let recvPhone: string | undefined
  let recvAddr: string | undefined
  let latest = order.delivery || order.statusHint || ""
  let itemTitle = order.itemTitle || ""
  let tracks: { time: string; text: string }[] = []
  let lastTrackAt = 0
  // 已完成/已关闭这类默认不开跟踪页；但历史单要展示物流详情时，可由调用方用 forceTrack 破例（有限额）
  const terminal = !needTrackPage(order.statusHint)
  const wantTrack = !terminal || !!opts?.forceTrack

  if (order.orderId && wantTrack) {
    try {
      const page = await openPage(TRACK_URL(order), 4200)
      const info = parseTrack(page.text)
      mailNo = info.mailNo
      company = info.company
      if (info.latest) latest = info.latest
      if (!itemTitle && info.itemTitle) itemTitle = info.itemTitle
      tracks = info.tracks
      lastTrackAt = timeOfTrack(tracks[0]?.time || "")
      // 收货人信息（同淘宝口径：有才填，不猜）
      if (info.receiverName) recvName = info.receiverName
      if (info.receiverPhone) recvPhone = info.receiverPhone
      if (info.receiverAddress) recvAddr = info.receiverAddress
    } catch { }
  }

  const status = classifyJd(latest)
  const place = placeOf(latest)
  // 京东的预计时间只在列表卡片文案里（如「预计11月9日发货，11月11日送达」），
  // 有轨迹节点时 latest 会被节点覆盖，所以要在 order.delivery 上也扫一遍。
  const etaSrc = [order.delivery, order.statusHint, latest].filter(Boolean).join(" ")
  const eta = etaInText(etaSrc)
  const etaAt = etaTimeInText(etaSrc)?.at
  return {
    orderId: `jd:${order.orderId}`,
    source: "jd",
    itemTitle,
    shopName: order.shopName,
    company,
    mailNo,
    latest,
    status,
    pickupCode: pickupCodeOf(latest, order.delivery || "", ...tracks.map(t => t.text)) || undefined,
    tracks,
    receiverName: recvName,
    receiverPhone: recvPhone,
    receiverAddress: recvAddr,
    lastTrackAt: lastTrackAt || undefined,
    city: place.city,
    stationName: place.station,
    eta,
    etaAt,
    stale: terminal && status === "delivered" ? true : undefined,
    updatedAt: Date.now(),
  }
}

/** 订单批次轮换指针：待收货单超出一批时，下次从上次停下的位置继续，避免总卡在前几条 */
const JD_ROT_KEY = "cc.jdOrderCursor"
function rotateBatch<T>(list: T[], size: number): T[] {
  if (list.length <= size) return list
  let cur = 0
  try { cur = Number(Storage.get<number>(JD_ROT_KEY) ?? 0) || 0 } catch { }
  cur = ((cur % list.length) + list.length) % list.length
  const batch = [...list.slice(cur), ...list.slice(0, cur)].slice(0, size)
  try { Storage.set(JD_ROT_KEY, (cur + size) % list.length) } catch { }
  return batch
}

export async function jdSyncAll(
  onProgress?: (done: number, total: number) => void,
  opts?: { wantHistory?: boolean; deadline?: number },
): Promise<Pkg[]> {
  const deadline = opts?.deadline ?? Number.POSITIVE_INFINITY
  const { orders, logged, blocked, text } = await jdDiscoverOrders(opts)
  if (!logged) throw new Error("京东登录态已失效，请重新登录")
  if (blocked) {
    // 排队/限流类（自动重试 2 次已耗尽）本轮跳过，下次同步自然恢复；滑块类才需要人
    const human = HUMAN_VERIFY_RE.test(text || "")
    throw new Error(human ? "京东需要人机验证，请手动完成" : "京东排队限流，本轮跳过，下次同步再试")
  }
  if (orders.length === 0) return []

  // 只做近 20 天的单：退回「全部订单」时首屏可能挂着几个月前的历史单。
  // 卡片上抽不到日期的保留（宁可多跑一条，也不能把当天的新单误杀）。
  const cutoff = Date.now() - 20 * 86_400_000
  const recent = orders.filter(o => !o.orderTime || o.orderTime >= cutoff)
  if (recent.length === 0) return []

  // 未完成的单优先；最多 12 单（每单一个网页），超出部分下次同步从指针位置继续
  const sorted = [...recent]
    .sort((a, b) => Number(needTrackPage(b.statusHint)) - Number(needTrackPage(a.statusHint)))
  const targets = rotateBatch(sorted, 12)

  const out: Pkg[] = []
  // 已完成/已关闭的单不再破例开跟踪页（原来的 historyBudget=2）：
  // 这种单不会新建入库（upsert 会拦），本地已有记录靠 statusHint 就能把状态改成已签收/已退款，
  // 多开两个页只会白白撞限流。
  for (let i = 0; i < targets.length; i++) {
    if (Date.now() > deadline) break
    const terminal = !needTrackPage(targets[i].statusHint)
    try { out.push(await jdFetchPackage(targets[i])) } catch { }
    onProgress?.(i + 1, targets.length)
    if (!terminal && i < targets.length - 1) await delay(800)
  }
  return out
}
