// 拼多多 anti-content 的取用方式：加载官方 mdkd 页面，让官方 webpack 里的反爬模块自己算一个令牌出来。
//
// 边界（用户 2026-11-14 明确定义）：单账号、本人实时操作、只在 WebView 里加载官方页面，
// 我们只提供「容器」——不计算、不重放、不伪造任何 token，也没有无人值守与批量。
// 生成过程完全由拼多多官方 JS 执行，等价于用 Safari 打开同一个 H5 页面操作。
//
// 机制：官方页的 webpack 运行时里，模块 89320 导出生成器（SuperXD 的 express_anti_content.dart 逆向结论）。
// 首次 push 一个占位 chunk 把它的引用抓进 window.__pddGen，之后调它取令牌。
// 令牌有时效，所以每次请求现生成、不缓存；同时只跑一个页面，并发请求排队。
const PAGE = "https://m.pinduoduo.net/mdkd/package?pr_page_from=scheme"
const UA = "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1"

declare const WebViewController: any

function delay(ms: number): Promise<void> {
  return new Promise<void>(r => setTimeout(r, ms))
}

let ctrl: any = null
let chain: Promise<any> = Promise.resolve()

// 只许主框架停在官方 mdkd 页：这个页面没有登录态，几秒后可能自己跳去 login.html 再想拉起拼多多 App，
// 一跳走 window 全局（含生成器）就没了。
function staysOnPage(url: string): boolean {
  if (!/^https?:/i.test(url)) return false
  try {
    const u = new URL(url)
    return u.host === "m.pinduoduo.net" && u.pathname.startsWith("/mdkd")
  } catch { return false }
}

const CAPTURE = [
  "window.__pddGen=null;",
  "try{self.webpackChunk_N_E.push([[990099],{990099:function(t,e,n){window.__pddGen=function(){return n(89320).a()}}},function(n){n(990099)}])}catch(e){}",
].join("")

async function openPage(): Promise<any> {
  if (ctrl) { try { ctrl.dispose() } catch { } ctrl = null }
  const c = new WebViewController({ preferredContentMode: "mobile" })
  try { await c.setCustomUserAgent(UA) } catch { }
  c.shouldAllowRequest = async (req: any) => staysOnPage(String(req && req.url || ""))
  await c.loadURL(PAGE)
  try { await c.waitForLoad() } catch { }
  await delay(1200)
  try { await c.evaluateJavaScript(CAPTURE) } catch { }
  ctrl = c
  return c
}

async function current(): Promise<any> {
  if (ctrl) {
    try {
      const t = String(await ctrl.evaluateJavaScript("return typeof window.__pddGen") ?? "")
      if (t === "function") return ctrl
    } catch { }
  }
  return await openPage()
}

// 调一次生成器：拿到就返回，超时或报错返回空串（交给上层重载一次再试）
async function invoke(c: any): Promise<string> {
  const slot = "__pddAc" + Math.random().toString(36).slice(2)
  try {
    await c.evaluateJavaScript(
      `window.${slot}="";` +
      `try{window.__pddGen().then(function(v){window.${slot}=v||""}).catch(function(e){window.${slot}=""})}` +
      `catch(e){window.${slot}=""}`
    )
  } catch { return "" }
  for (let i = 0; i < 80; i++) {
    await delay(100)
    let v = ""
    try { v = String(await c.evaluateJavaScript(`return window.${slot}`) ?? "") } catch { v = "" }
    if (v && v !== "null" && v !== "undefined") return v
  }
  return ""
}

/** 现取一个 anti-content。只用于本人实时操作触发的绑定/解绑类请求。 */
export async function pddAntiContent(): Promise<string> {
  const run = async (): Promise<string> => {
    let c = await current()
    let v = await invoke(c)
    if (v) return v
    // 生成器不在（页面被重置或刚跳走）：重建一次
    c = await openPage()
    v = await invoke(c)
    if (!v) throw new Error("拼多多风控令牌生成失败，请稍后重试")
    return v
  }
  const p = chain.then(run, run)
  chain = p.catch(() => { })
  return p
}

/** 用完页面就释放（管理页关闭时调用） */
export function pddAntiCleanup() {
  if (!ctrl) return
  try { ctrl.dispose() } catch { }
  ctrl = null
}
