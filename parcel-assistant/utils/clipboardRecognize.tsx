/**
 * 快捷指令 → 剪贴板 → 本应用。
 *
 * 为什么绕剪贴板：快捷指令可以把「截屏」拷进剪贴板，再用
 * `scripting://run/包裹助手?ocr=1` 把 App 拉起来；这里就能拿到那张图做本地 OCR。
 * 比依赖 AppIntent 传图更稳（intent 的动作标识随 App 版本变，写死在快捷指令里容易失效）。
 */
import { Navigation, Notification, ScrollView, Text, VStack } from "scripting"
import { consumeIntentInbox, pushIntentItem } from "./intentInbox"
import { parseDeliveryText, summarizeParsed } from "./smsParse"

export interface RecognizeResult {
  ok: boolean
  title: string
  detail: string
}

async function notifyFail(body: string) {
  try { await Notification.schedule({ title: "未识别到包裹", body, threadIdentifier: "cc.ocr" }) } catch { }
}

export async function recognizeFromClipboard(mode: "image" | "text"): Promise<RecognizeResult> {
  let text = ""

  if (mode === "image") {
    let img: any = null
    try { img = await Pasteboard.getImage() } catch { }
    if (!img) {
      const r = { ok: false, title: "未识别到包裹", detail: "快捷指令未传递截图" }
      void notifyFail(r.detail)
      return r
    }
    try {
      const res = await Vision.recognizeText(img, {
        recognitionLanguages: ["zh-Hans", "en-US"],
        recognitionLevel: "accurate",
        usesLanguageCorrection: true,
      })
      text = String(res?.text ?? "")
    } catch (e) {
      const r = { ok: false, title: "截图识别失败", detail: String((e as any)?.message ?? e).slice(0, 60) }
      void notifyFail(r.title)
      return r
    }
    if (!text.trim()) {
      const r = { ok: false, title: "未识别到文字", detail: "请重新截屏" }
      void notifyFail(r.title)
      return r
    }
  } else {
    try { text = (await Pasteboard.getString()) ?? "" } catch { }
    if (!text.trim()) {
      const r = { ok: false, title: "未识别到包裹", detail: "剪贴板无文字" }
      void notifyFail(r.detail)
      return r
    }
  }

  const parsed = parseDeliveryText(text)
  if (!parsed.mailNo && !parsed.code) {
    const preview = text.replace(/\s+/g, " ").trim().slice(0, 30)
    const r = { ok: false, title: "未识别到包裹", detail: preview }
    void notifyFail(preview)
    return r
  }

  pushIntentItem(mode, parsed)
  const res = consumeIntentInbox()
  return {
    ok: true,
    title: res.applied > 0 ? "已更新包裹列表" : "已记录",
    detail: summarizeParsed(parsed) + (res.applied === 0 ? "\n（打开包裹页可确认）" : ""),
  }
}

/** 识别结果小卡片：只告诉用户这一次拿到了什么 */
export function ResultCard({ result }: { result: RecognizeResult }) {
  const dismiss = Navigation.useDismiss()
  return (
    <ScrollView>
      <VStack alignment="leading" spacing={10} padding={24} frame={{ maxWidth: "infinity", alignment: "leading" }}>
        <Text font={22} fontWeight="bold">{result.title}</Text>
        <Text font={15} foregroundStyle="secondaryLabel">{result.detail}</Text>
      </VStack>
    </ScrollView>
  )
}

export async function presentRecognizeResult(mode: "image" | "text"): Promise<void> {
  const result = await recognizeFromClipboard(mode)
  await Navigation.present({
    element: <ResultCard result={result} />,
    modalPresentationStyle: "pageSheet",
  } as any)
}
