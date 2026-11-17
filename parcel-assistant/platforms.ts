/**
 * 平台授权：把「快递聚合」里已验证的三平台登录方案搬过来。
 *  - 淘宝：官方登录页 → 存 Cookie（Keychain `taobao.tracking.cookies`，跨脚本共用）
 *  - 京东：登录页（顶部修版）→ 等 pt_key + 回到 my.jd.com → 存 Cookie（`jd.cookies`）
 *  - 拼多多：手机号登录页（居中修版）→ 轮询 Cookie+localStorage → 存 Keychain（`pdd.cookies` / `pdd.ls`）
 * 授权后的「同步包裹」在 sync.ts（复用聚合脚本的解析逻辑，同一套 Keychain key）。
 */
declare const fetch: any
const delay = (ms: number) => new Promise<void>(resolve => (setTimeout as any)(resolve, ms))

// 解除授权用各平台自己的清理函数：它们除了删 Keychain，还会清 WebView 持久 Cookie 仓库，
// 只删 Keychain 的话下次授权会被旧会话自动登录。
import { jdClearLogin } from "./utils/jd"
import { pddClearLogin } from "./utils/pdd"
import { clearIdentityCaches } from "./utils/identity"

// 登录页用 iPhone UA + 手机版 CSS 重画。实测结论：iPad UA 不会避免挤掉手机 App，
// 挤下线是账号级会话替换，与设备端无关；既然无收益就回到已验证可用的手机形态。
const SAFARI_UA = "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1"

export type PlatformId = "taobao" | "cainiao" | "jd" | "pdd" | "fengchao" | "kdniao" | "mi"

// 快递鸟凭证 key（与 kdniao.ts 一致，避免循环导入）
const CRED_KEY_KD = "kdniao.credential"
const TOKEN_KEY_KD = "kdniao.token"

function loadCredentialSafe(): boolean {
  try { return !!Keychain.get(CRED_KEY_KD) } catch { return false }
}

export interface PlatformMeta {
  id: PlatformId
  name: string
  /** 本地 App 图标路径（assets/identity/ 下） */
  icon: string
}

export const PLATFORMS: PlatformMeta[] = [
  { id: "taobao", name: "淘宝", icon: "identity/taobao.png" },
  // 菜鸟单独列出：登录态就是淘宝会话（复用 TB_KEY），点「授权」弹的也是淘宝登录页；
  // 但它是一个独立平台（有自己的接口/身份码），用户要求它单独显示授权状态
  { id: "cainiao", name: "菜鸟", icon: "identity/cainiao.png" },
  { id: "jd", name: "京东", icon: "identity/jd.png" },
  { id: "pdd", name: "拼多多", icon: "identity/pdd.jpg" },
  // 丰巢：快递柜的真实取件码来源，手机号+短信登录（原生表单，不走 WebView）
  { id: "fengchao", name: "丰巢", icon: "logos64/hive.png" },
  // 小米快递：小米账号扫码登录（智能助理「我的快递」聚合，需再绑手机号）
  { id: "mi", name: "小米快递聚合", icon: "identity/mi.png" },
]

/* ---------------- 登录态存取（与聚合脚本同 key，可直接互认） ---------------- */

const TB_KEY = "taobao.tracking.cookies"
const JD_KEY = "jd.cookies"
const PDD_KEY = "pdd.cookies"
const PDD_LS_KEY = "pdd.ls"
// 新代码（utils/pdd.ts）读的是这个 key，两份都写，避免「授权成功但身份码页还要登录」
const PDD_LS_KEYS = ["pdd.ls", "pdd.localStorage"]

/** localStorage 里有没有像登录 token 的项（匿名页面也有 localStorage，不能只看非空） */
function hasPddTokenLS(): boolean {
  for (const key of PDD_LS_KEYS) {
    const raw = Keychain.get(key)
    if (!raw) continue
    try {
      const v = JSON.parse(String(raw))
      if (!v || typeof v !== "object") continue
      for (const k of Object.keys(v)) {
        const val = (v as any)[k]
        if (/token|access/i.test(k) && typeof val === "string" && val.length >= 8) return true
      }
    } catch { }
  }
  return false
}

function readCookies(key: string): any[] {
  const raw = Keychain.get(key)
  if (!raw) return []
  try { const v = JSON.parse(raw); return Array.isArray(v) ? v : [] } catch { return [] }
}

/** 已存的淘宝 Cookie 里是否真的登录过（unb / tracknick） */
export function taobaoCookiesLoggedIn(): boolean {
  return readCookies(TB_KEY).some((c: any) => ["unb", "tracknick"].includes(String(c.name)) && !!c.value)
}

import { fcClearLogin, fcHasLogin } from "./utils/fengchao"
import { miClearLogin, miHasLogin } from "./utils/mi"

/* ---------------- 淘宝 / 菜鸟的独立启停 -------------
 * 登录可以复用（同一个淘宝会话），但「解除授权」要各自独立：
 * 解菜鸟只是不再拉菜鸟驿站数据，淘宝订单照旧；反过来也一样。
 * 两个都解除时才删 Cookie（否则下次还要重新登录）。 */
const EN_KEY = "cc.platform.enabled"

function readEnabled(): Record<string, boolean> {
  // 共享域优先：开关状态影响后台同步，小组件进程必须读到跟 App 一样的一份
  let raw = ""
  try { raw = String(Storage.get<string>(EN_KEY, { shared: true }) ?? "") } catch { }
  if (!raw) { try { raw = String(Storage.get<string>(EN_KEY) ?? "") } catch { } }
  if (!raw) return {}
  try { const v = JSON.parse(raw); return v && typeof v === "object" ? v : {} } catch { return {} }
}

/** 默认开启：只记录「被显式关掉」的平台 */
export function platformEnabled(id: PlatformId): boolean {
  if (id !== "taobao" && id !== "cainiao") return true
  return readEnabled()[id] !== false
}

export function setPlatformEnabled(id: PlatformId, on: boolean) {
  const m = readEnabled()
  m[id] = on
  const raw = JSON.stringify(m)
  try { Storage.set(EN_KEY, raw, { shared: true }) } catch { }
  try { Storage.set(EN_KEY, raw) } catch { }
}

/** 自愈：登录页的匿名 cookie 曾被当成登录态存下来（重新授权时直接关掉弹窗就会这样），
 *  没有 unb/tracknick 的一律清掉，避免「显示已授权、接口全 SESSION_EXPIRED」。 */
export function sanitizeTaobaoAuth(): void {
  try {
    if (!Keychain.get(TB_KEY)) return
    if (taobaoCookiesLoggedIn()) return
    Keychain.remove(TB_KEY)
  } catch { }
}

export function hasAuth(id: PlatformId): boolean {
  if (id === "kdniao") return !!loadCredentialSafe()
  if (id === "fengchao") return fcHasLogin()
  if (id === "mi") return miHasLogin()
  // 菜鸟与淘宝共用淘宝登录态（同一套 Cookie 调 mtop）；淘宝已登录且没被单独关掉才算已授权
  // 光有 cookie 不算：登录页的匿名 cookie 会让人以为已授权，实际接口全是 SESSION_EXPIRED
  if (id === "cainiao") return taobaoCookiesLoggedIn() && platformEnabled("cainiao")
  if (id === "taobao") return taobaoCookiesLoggedIn() && platformEnabled("taobao")
  if (id === "jd") return readCookies(JD_KEY).some((c: any) => c.name === "pt_key" && !!c.value)
  return readCookies(PDD_KEY).length > 0 || hasPddTokenLS()
}

export function clearAuth(id: PlatformId) {
  if (id === "kdniao") { try { Keychain.remove(CRED_KEY_KD); Keychain.remove(TOKEN_KEY_KD) } catch { } return }
  if (id === "fengchao") { fcClearLogin(); return }
  if (id === "mi") { miClearLogin(); return }
  // 淘宝 / 菜鸟：只关掉自己那路，不删 Cookie（另一路还要用）。
  // 两个都被关掉时才清 Cookie，避免残留登录态。
  if (id === "taobao" || id === "cainiao") {
    setPlatformEnabled(id, false)
    const other = id === "taobao" ? "cainiao" : "taobao"
    if (!platformEnabled(other)) {
      Keychain.remove(TB_KEY)
      // Cookie 没了，缓存里的身份码（带真实姓名与证件号）也就不能留着
      clearIdentityCaches()
    }
    return
  }
  if (id === "jd") { jdClearLogin(); return }
  if (id === "pdd") { pddClearLogin(); return }
}

function saveCookies(key: string, cookies: any[]) {
  Keychain.set(key, JSON.stringify(cookies))
}

/** 当前页面主机名（拿不到返回空串） */
function hostOf(u: any): string {
  const s = String(u || "")
  if (!s) return ""
  try { return new URL(s).host.toLowerCase() } catch { }
  const m = s.match(/^https?:\/\/([^/?#]+)/i)
  return m ? m[1].toLowerCase() : ""
}

/* ---------------- 登录页修版脚本（照搬聚合脚本的已验证版） ---------------- */

/** 京东：顶部导航栏盖住 116pt，把整页推下去 */
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

/** 拼多多：表单贴顶被导航栏盖住，改成垂直居中卡片 */
// 用户实测结论（2026-11-14）：iPad UA / 平板指纹并不能避免挤掉手机 App——
// 挤下线是账号级会话替换（网页登录 = 新会话，旧会话作废），与设备端无关。
// 所以登录页只保留这一套已验证可用的手机版重画，不再区分形态。
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

/* ---------------- 三平台登录 ---------------- */

async function loginTaobao(): Promise<string> {
  // ephemeral：不预置旧 Cookie。否则重新授权时旧 unb 还在，一进页面就误判登录成功、弹窗秒退
  const controller = new WebViewController({ ephemeral: true, preferredContentMode: "mobile" })
  let presented = true
  try {
    // 照搬「快递聚合」的做法：不预置旧 Cookie、不比对 unb，登录后直接读全部 Cookie。
    // （之前那版比对新旧 unb 值，同账号重新授权时永远不命中 → 明明登上了却报“没有拿到登录态”）
    try { await controller.setCustomUserAgent(SAFARI_UA) } catch { }
    controller.present({ fullscreen: true, navigationTitle: "登录淘宝" })
      .then(() => { presented = false })
      .catch(() => { presented = false })
    try { await controller.loadURL("https://login.taobao.com/member/login.jhtml") } catch { }

    const deadline = Date.now() + 8 * 60 * 1000
    while (presented && Date.now() < deadline) {
      await delay(900)
      if (!presented) break
      // 只有出现真登录凭证（unb/tracknick）才自动关；_tb_token_ 这类匿名 cookie 不算
      if (await taobaoLoggedIn(controller)) break
    }

    const cookies = await controller.getAllCookies().catch(() => [])
    const usable = (cookies || []).filter((c: any) => /taobao|tmall|alibaba/.test(String(c.domain || "")))
    // 只认真正登录凭证：登录页本身就会下 _tb_token_/cookie2/cna 这类匿名 cookie，
    // 拿「有 cookie」当成功会在用户直接关掉弹窗时误判（之后 mtop 一律 FAIL_SYS_SESSION_EXPIRED）。
    const logged = await taobaoLoggedIn(controller)
    if (presented) { try { controller.dismiss() } catch { } await delay(300) }
    if (!logged) return "没有完成淘宝登录，请重新授权"
    if (usable.length === 0) return "没有拿到淘宝 Cookie，登录可能没完成"
    saveCookies(TB_KEY, usable)
    return ""
  } finally {
    controller.dispose()
  }
}

/** 淘宝是否真的登录了：unb（用户 id）/ tracknick（昵称）出现即算 */
async function taobaoLoggedIn(controller: WebViewController): Promise<boolean> {
  const cookies = await controller.getAllCookies().catch(() => [])
  return (cookies || []).some((c: any) => ["unb", "tracknick"].includes(String(c.name)) && !!c.value)
}

async function loginJd(): Promise<string> {
  // ephemeral：不预置旧 Cookie（旧 pt_key 预置进去会让页面直接当已登录，弹窗秒退 = 用户实测的 bug）
  const controller = new WebViewController({ ephemeral: true, preferredContentMode: "mobile" })
  let presented = true
  try {
    try { await controller.setCustomUserAgent(SAFARI_UA) } catch { }
    try { await controller.addUserScript({ source: JD_LOGIN_FIX, injectionTime: "documentEnd" }) } catch { }
    // 不再预置旧 Cookie（ephemeral 已隔离）
    // 先弹窗再加载，避免点了没反应
    controller
      .present({ fullscreen: true, navigationTitle: "登录京东" })
      .then(() => { presented = false })
      .catch(() => { presented = false })
    try {
      await controller.loadURL("https://plogin.m.jd.com/login/login?appid=0&returnurl=https%3A%2F%2Fhome.m.jd.com%2FmyJd%2Fnewhome.action")
    } catch { }

    const deadline = Date.now() + 8 * 60 * 1000
    while (presented && Date.now() < deadline) {
      await delay(800)
      if (!presented) break
      const cs = await controller.getAllCookies().catch(() => [])
      const host = hostOf((controller as any).url)
      // 登录成功 = 页面回到了 jd.com 的普通页（不再是 plogin/passport），且拿到了 pt_key。
      // 登录后的落地页是 home.m.jd.com/myJd，不是 my.m.jd.com——只认 my.m.jd.com 永远收不到（之前就卡在这）
      const onJd = !!host && /(^|\.)jd\.com$/.test(host) && !/^(plogin|passport)\./.test(host)
      const pt = cs.find((c: any) => c.name === "pt_key" && !!c.value)
      if (pt && onJd) break
    }

    const cookies = await controller.getAllCookies().catch(() => [])
    const pt = cookies.find((c: any) => c.name === "pt_key" && !!c.value)
    // 有 pt_key 就算登录成功（同账号重授权时值和之前一样，不能拿“值变了”当成功条件）
    const ok = !!pt
    if (ok) saveCookies(JD_KEY, cookies)
    if (presented) { try { controller.dismiss() } catch { } await delay(600) }
    return ok ? "" : "没有拿到京东登录态（新设备常要滑块或短信验证），请重试"
  } finally {
    controller.dispose()
  }
}

async function pddSessionReady(controller: WebViewController): Promise<boolean> {
  // 只认真正的登录凭证：PDDAccessToken 或 localStorage 里的用户 token。
  // 不能拿「域是 pinduoduo|yangkeduo 的任意 Cookie」当登录成功——匿名页面也有一堆（api_uid 等），
  // 那样一进登录页就判成功，弹窗会立刻关掉。
  try {
    const js = "return (function(){try{var ks=['pdd_user_token','token','PDDAccessToken','access_token'];for(var i=0;i<ks.length;i++){var v=localStorage.getItem(ks[i]);if(v&&v.length>8)return v}return ''}catch(e){return ''}})()"
    const r = String(await controller.evaluateJavaScript<string>(js) || "")
    if (r) return true
  } catch { }
  const cookies = await controller.getAllCookies().catch(() => [])
  return (cookies || []).some((c: any) => c && c.name === "PDDAccessToken" && !!c.value)
}

async function savePddSession(controller: WebViewController): Promise<number> {
  const cookies = await controller.getAllCookies().catch(() => [])
  const usable = cookies.filter((c: any) => /pinduoduo|yangkeduo|pdd/.test(String(c.domain || "")))
  if (usable.length > 0) saveCookies(PDD_KEY, usable)
  try {
    const json = String(await controller.evaluateJavaScript<string>(
      "return (function(){try{var o={};for(var i=0;i<localStorage.length;i++){var k=localStorage.key(i);o[k]=localStorage.getItem(k)}return JSON.stringify(o)}catch(e){return ''}})()"
    ) || "")
    if (json) for (const key of PDD_LS_KEYS) Keychain.set(key, json)
  } catch { }
  return usable.length
}

async function loginPdd(): Promise<string> {
  // ephemeral：不预置旧 Cookie，重新授权时不会因为旧 token 还在而一进页面就误判成功
  const controller = new WebViewController({ ephemeral: true, preferredContentMode: "mobile" })
  let presented = true
  const oldAuthed = hasAuth("pdd")
  let saved = false
  try {
    // 平板形态：仅 setCustomUserAgent 不一定影响页面 JS 读到的 navigator.userAgent，
    // 再用 documentStart 注入脚本强行覆盖一次，拼多多前端按 UA 分支渲染平板版登录页
    try { await controller.setCustomUserAgent(SAFARI_UA) } catch { }
    try { await controller.addUserScript({ source: PDD_LOGIN_FIX, injectionTime: "documentEnd" }) } catch { }
    controller.present({ fullscreen: true, navigationTitle: "登录拼多多" })
      .then(() => { presented = false })
      .catch(() => { presented = false })
    try { await controller.loadURL("https://mobile.yangkeduo.com/login.html") } catch {
      // 只在页面真的没渲染出来时重试：已经能看到输入框就别重载，
      // 否则用户刚点进输入框就被刷一下（原来固定 1.2 秒重载一次）
      const rendered = String(await controller.evaluateJavaScript(
        "return document.querySelectorAll('input').length").catch(() => "0") || "0")
      if (rendered === "0") {
        await delay(1500)
        try { await controller.loadURL("https://mobile.yangkeduo.com/login.html") } catch { }
      }
    }

    const deadline = Date.now() + 10 * 60 * 1000
    while (presented && Date.now() < deadline) {
      await delay(1200)
      if (!presented) break
      const host = hostOf((controller as any).url)
      const leftLogin = !!host && /(yangkeduo|pinduoduo)\.(com|net)$/.test(host) && !/^login\./.test(host)
      // 必须「确实拿到了登录凭证」才存、才关，不要在匿名页面边轮询边存（会把垃圾 Cookie 存成已授权）
      if (leftLogin && await pddSessionReady(controller)) {
        try { await savePddSession(controller) } catch { }
        if (hasAuth("pdd")) { saved = true; break }
      }
    }

    // 只有真的拿到登录凭证才落盘。之前这里无条件 savePddSession，匿名页面的
    // Cookie 也会被存成「已授权」——用户解除授权后点授权、不登录直接关，立刻又显示已授权
    if (saved) { try { await savePddSession(controller) } catch { } }
    saved = saved && (readCookies(PDD_KEY).length > 0 || hasPddTokenLS())
    if (presented) { try { controller.dismiss() } catch { } await delay(400) }
    return saved && !oldAuthed ? "" : saved ? "" : "没有拿到拼多多登录态：输完验证码后等弹窗自动关闭，不要手动关"
  } finally {
    controller.dispose()
  }
}

export async function authorize(id: PlatformId): Promise<string> {
  // 菜鸟没有自己的登录页：弹淘宝登录页，登完淘宝菜鸟自然已授权
  if (id === "taobao" || id === "cainiao") {
    // 已经有可用的淘宝身份（有 unb/tracknick 且上次不是“登录已失效”）→ 只当开关打开，不再弹登录
    const stale = platformState(id)?.ok === false
    if (taobaoCookiesLoggedIn() && !stale) {
      setPlatformEnabled(id, true)
      return ""
    }
    const err = await loginTaobao()
    // 登录成功后只重新打开这一次授权的平台；被用户单独关掉的另一路保持关闭
    if (!err) setPlatformEnabled(id, true)
    return err
  }
  if (id === "jd") return loginJd()
  // 丰巢是原生表单（手机号 + 验证码），由授权页直接 open("fengchaoLogin")，不走这里
  if (id === "fengchao") return ""
  // 小米：登录页是独立 sheet（弹 WebView 扫码），由授权页直接 open("miLogin")，不走这里
  if (id === "mi") return ""
  return loginPdd()
}


/* ---------------- 授权有效性状态 ---------------- */

const STATE_KEY = "cc.platform.state"

export interface PlatformState {
  ok: boolean
  /** 最近一次验证时间 */
  at: number
  reason?: string
}

function readStates(): Record<string, PlatformState> {
  const raw = Storage.get<string>(STATE_KEY)
  if (!raw) return {}
  try { const v = JSON.parse(raw); return v && typeof v === "object" ? v : {} } catch { return {} }
}

/** 最近一次同步时这个平台的登录态是否还活着；没有记录返回 null */
export function platformState(id: PlatformId): PlatformState | null {
  return readStates()[id] ?? null
}

/** 同步成功/失败后记一笔，授权列表据此显示「已失效」 */
export function markPlatform(id: PlatformId, ok: boolean, reason?: string) {
  const all = readStates()
  all[id] = { ok, at: Date.now(), reason: ok ? undefined : reason }
  try { Storage.set(STATE_KEY, JSON.stringify(all)) } catch { }
}

/** 有 Cookie 但上次同步报登录失效 */
export function needsReauth(id: PlatformId): boolean {
  if (!hasAuth(id)) return false
  const s = platformState(id)
  return !!s && s.ok === false
}

/**
 * 拉取平台包裹的实现在 utils/platformSync.ts（后台刷新 = refreshPlatformParcels，
 * 全量发现新单 = syncPlatformParcels）。这里只重新导出，保持调用方不变。
 */
export { refreshPlatformParcels, syncPlatformParcels } from "./utils/platformSync"
export type { PlatformSyncReport } from "./utils/platformSync"
