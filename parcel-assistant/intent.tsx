/**
 * 快捷指令入口：收图片或文字 → 本地 OCR / 正则解析 → 写进识别收件箱，
 * App 下次启动时落库（补取件码或新建运单号包裹）。
 *
 * 截图不在这里做：脚本在后台拿不到前台 App 的屏幕（实测
 * `ScreenCapture.capture()` 直接报 "requires this script's foreground App interface"），
 * 所以由快捷指令里的系统「截屏」动作把图传进来。
 */
import { Intent, Notification, Script } from "scripting"
import { parseDeliveryText, summarizeParsed } from "./utils/smsParse"
import { loadSharedPickups, pickIntentTarget, pushIntentItem } from "./utils/intentInbox"
import type { SourceApp } from "./utils/appBrand"

/** 快捷指令带来的元数据前缀（不是要识别的正文） */
const META = /^(app|appname):/i

/**
 * 当前是哪个 App：快捷指令用 CurrentApp 魔法变量取，
 * 通过 RunScriptIntent 的 texts（app:<bundleId>）/ urls（appname:<名字>）传进来。
 * 拿不到就返回空对象，不影响识别。
 */
function readSourceApp(): SourceApp {
  const out: SourceApp = {}
  const pick = (arr: any, prefix: string): string => {
    try {
      // 有的动作把参数当单个文本给我，不一定是数组，两种都接
      const list = Array.isArray(arr) ? arr : arr == null ? [] : [arr]
      for (const v of list) {
        const s = String(v ?? "").trim()
        if (!s.toLowerCase().startsWith(prefix)) continue
        let val = s.slice(prefix.length).trim()
        if (val.includes("%")) { try { val = decodeURIComponent(val) } catch { } }
        if (val) return val
      }
    } catch { }
    return ""
  }
  const id = pick(Intent.textsParameter, "app:")
  const name = pick(Intent.urlsParameter, "appname:")
  if (id) out.id = id
  if (name) out.name = name
  return out
}

function collectText(): string {
  const parts: string[] = []
  const push = (x: any) => {
    const s = String(x ?? "").trim()
    // app: / appname: 是来源 App 元数据，不能混进要识别的正文
    if (s && !META.test(s)) parts.push(s)
  }
  try {
    const sp: any = Intent.shortcutParameter
    if (sp && sp.type === "text") push(sp.value)
    if (sp && sp.type === "url") push(sp.value)
  } catch { }
  try {
    const ts: any = Intent.textsParameter
    if (Array.isArray(ts)) for (const t of ts) push(t)
  } catch { }
  return parts.join("\n").trim()
}

async function notifyFail(title: string, body: string, iid?: string) {
  try {
    // 点通知直接回 App 并弹出「关联到包裹」——不带这个，点开只是启动 Scripting
    let tapAction: any
    try {
      tapAction = {
        type: "openURL",
        url: Script.createRunURLScheme("包裹助手", iid ? { intent: "1", iid } : { intent: "1" }),
      }
    } catch { }
    await Notification.schedule({ title, body, threadIdentifier: "cc.ocr", ...(tapAction ? { tapAction } : {}) })
  } catch { }
}

function loadImageFromPath(p: string, force = false): UIImage | null {
  try {
    let s = String(p ?? "").trim()
    if (!s) return null
    if (s.toLowerCase().startsWith("file://")) { try { s = decodeURIComponent(s.slice(7)) } catch { s = s.slice(7) } }
    // 普通文本不当文件读；但 type=fileURL 时系统给的就是文件，扩展名不一定规范
    if (!force && !/\.(png|jpe?g|heic|heif|webp|tiff?)$/i.test(s)) return null
    if (!FileManager.existsSync(s)) return null
    return UIImage.fromFile(s) ?? null
  } catch { return null }
}

/**
 * 取图。AppIntent 把截图传进来时有四种可能的形状，一种一种试：
 *   ① images 参数（分享/多图）
 *   ② imagePaths 参数（大图不解码，给路径）
 *   ③ shortcutParameter.value 是 UIImage
 *   ④ shortcutParameter.type === "fileURL"（截图最常见就是这种），值是临时文件路径
 * 以前只试了 ①②③，④ 直接落到「快捷指令未传递内容」—— 就是用户报的那个错。
 */
async function intakeImage(): Promise<{ img: UIImage | null; seen: string }> {
  const seen: string[] = []
  const note = (s: string) => { if (!seen.includes(s)) seen.push(s) }
  try {
    const imgs: any[] = (Intent.imagesParameter as any[]) ?? []
    if (imgs.length > 0 && imgs[0]) { note("images"); return { img: imgs[0], seen: "images" } }
  } catch { note("images:err") }
  try {
    const paths: any[] = ((Intent as any).imagePathsParameter as any[]) ?? []
    for (const p of paths) { const im = loadImageFromPath(String(p)); if (im) return { img: im, seen: "imagePaths" } }
    if (paths.length) note("imagePaths:noFile")
  } catch { note("imagePaths:err") }
  try {
    const sp: any = Intent.shortcutParameter
    note(`sp:${sp?.type ?? "none"}`)
    const v: any = sp?.value
    if (v && typeof v === "object" && (v.cgImage || v.size)) return { img: v as UIImage, seen: "sp:image" }
    if (typeof v === "string") {
      const im = loadImageFromPath(v, sp?.type === "fileURL")
      if (im) return { img: im, seen: `sp:${sp?.type}:file` }
    }
  } catch { note("sp:err") }
  return { img: null, seen: seen.join(",") || "none" }
}

async function run() {
  let text = ""
  let kind: "image" | "text" = "text"

  const intake = await intakeImage()
  const img = intake.img

  // ① 有图片就本地 OCR（Vision，不联网）
  if (img) {
    kind = "image"
    // 分两档：先 fast（定位快很多），认不出单号/取件码再上 accurate 重试。
    // 绝大多数快递截图 fast 就够——这一档省下来的就是「收起控制中心后还要等」的那几秒。
    const read = async (level: "fast" | "accurate"): Promise<string> => {
      try {
        const r = await Vision.recognizeText(img, {
          recognitionLanguages: ["zh-Hans", "en-US"],
          recognitionLevel: level,
          usesLanguageCorrection: true,
        })
        return String((r as any)?.text ?? "")
      } catch { return "" }
    }
    let fastText = await read("fast")
    let use = fastText
    if (fastText.trim()) {
      const probe = parseDeliveryText(fastText)
      if (!probe.mailNo && !probe.code) {
        const acc = await read("accurate")
        if (acc.trim()) use = acc
      }
    } else {
      use = await read("accurate")
    }
    text = use
    if (!text.trim()) {
      void notifyFail("识别失败", "请重新截屏")
      Script.exit(Intent.text("截图识别失败"))
    }
  }

  // ② 没图就用文本
  if (!text.trim()) {
    const t = collectText()
    if (t) { text = t; kind = "text" }
  }

  if (!text.trim()) {
    // 不是让用户手手动去截图：截图是快捷指令里的一步动作，自动的。
    // 出现这个提示只有一个原因——快捷指令没把内容接到本动作上。
    if (kind === "image") {
      void notifyFail("未识别到文字", "请重新截屏")
      Script.exit(Intent.text("截图里没有文字"))
    } else {
      // 把实际收到的参数形状写进通知：这条链路没有日志可查，只能靠它定位
      void notifyFail("未识别到包裹", `未收到图片（${intake.seen}）`)
      Script.exit(Intent.text(`快捷指令没传内容（${intake.seen}）`))
    }
    return
  }

  const parsed = parseDeliveryText(text)
  const ok = !!(parsed.mailNo || parsed.code)

  const item = pushIntentItem(kind, parsed, readSourceApp())

  if (!ok) {
    // 识别不到也要说清楚是"没认出"，不能静默成功——用户在别的页面误触时要能发现
    const preview = text.replace(/\s+/g, " ").trim().slice(0, 30)
    const msg = `未识别到包裹：${preview}`
    void notifyFail(kind === "image" ? "图片未识别到包裹" : "短信未识别到包裹", preview, item.id)
    Script.exit(Intent.text(msg))
    return
  }

  // 只有取件码的要提前判一次能不能对上包裹：对不上就发一条可点通知（点开直达关联页）。
  // 对得上、或有运单号（会新建包裹）都保持静默，不打扰。
  if (!parsed.mailNo && parsed.code) {
    const shared = loadSharedPickups()
    if (shared && shared.length > 0) {
      // 候选集必须跟 App 落库时一致（status=1 且未关闭），否则会出现
      // 「通知说对不上，打开 App 却自动关联上了」
      const cands = shared.filter(x => x.status === 1 && !x.closed)
      if (!pickIntentTarget(parsed, cands)) {
        const preview = summarizeParsed(parsed)
        await notifyFail("取件码待关联", `${preview}。点按选择包裹`, item.id)
      }
    }
  }

  const summary = summarizeParsed(parsed)
  Script.exit(Intent.text(`已收录：${summary}`))
}

void run()
