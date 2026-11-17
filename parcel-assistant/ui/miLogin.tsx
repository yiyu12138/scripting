// 小米账号登录：照抄 Halo0sama/ExpressAssistant 的 XiaomiLoginActivity 流程：
// ① GET account.xiaomi.com/pass/serviceLogin?sid=assistant&_json=true → 解析 location
// ② WebView loadUrl(location)（桌面 Chrome UA）
// ③ onPageFinished 轮询：URL 到登录完成页/account 页/api.assistant.miui.com/sts 就取 Cookie
//    · 先看 api.assistant.miui.com 域有没有 assistant_serviceToken/serviceToken（新版直出）
//    · 没有就用 account.xiaomi.com 的 passToken+userId+deviceId 走 miMintToken() 服务端兑换
// ④ 成功自动 dismiss。参照原版：桌面 Chrome UA、登录完成判定三选一。
import { Button, Text, VStack } from "scripting"
import { SubPage, Section } from "./kit"
declare const fetch: any
import { notify } from "./notify"
import { miHasLogin, miMintToken, miReadUser, miSaveSession } from "../utils/mi"

const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"

/** 参考项目 getLoginUrl()：先 serviceLogin 拿 location，失败退回 authStart */
async function resolveLoginUrl(): Promise<string> {
  try {
    const resp = await fetch("https://account.xiaomi.com/pass/serviceLogin?sid=assistant&_json=true", {
      headers: { "User-Agent": UA },
    })
    const text = await resp.text()
    const json = text.slice(text.indexOf("{"))
    const obj = JSON.parse(json)
    if (obj.location) return String(obj.location)
  } catch { }
  return "https://account.xiaomi.com/fe/service/identity/authStart?sid=assistant"
}

export function MiLoginPage({ close, bump }: { close: () => void; bump?: () => void }) {
  return (
    <SubPage title="登录小米账号" onClose={close}>
      <Section footer="在页面里完成登录（密码或扫码），成功后弹窗会自动关闭。登录凭证只存本机钥匙串。">
        <Button title="打开小米登录页" buttonStyle="borderedProminent" frame={{ maxWidth: "infinity" }}
          action={() => {
            void (async () => {
              const controller = new WebViewController({ ephemeral: true, preferredContentMode: "desktop" })
              let presented = true
              try {
                controller.present({ fullscreen: true, navigationTitle: "登录小米账号" })
                  .then(() => { presented = false })
                  .catch(() => { presented = false })
                // 参考项目顺序：先 getLoginUrl() 再 loadUrl(location)
                const url = await resolveLoginUrl()
                try { await controller.loadURL(url) } catch { }

                const deadline = Date.now() + 10 * 60 * 1000
                let ok = false
                while (presented && Date.now() < deadline) {
                  await new Promise<void>(r => (setTimeout as any)(r, 2000))
                  if (!presented) break
                  const cur = String((controller as any).url || "")
                  // 原版 tryLogin 触发条件：登录完成页 / account 页 / STS 跳转
                  const done = cur.includes("fe/service/account")
                    || cur.includes("passInfo=login-end")
                    || cur.startsWith("https://api.assistant.miui.com/sts")
                  if (!done) continue

                  // 新版：STS 已直接把令牌写进 api.assistant.miui.com 域 Cookie
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
                  // 旧版兜底：用 passToken 三件套服务端兑换（原版 XiaomiPassport.mint）
                  if (passToken && userId && deviceId) {
                    miSaveSession("", { passToken, userId, deviceId })
                    try {
                      const mint = await miMintToken()
                      miSaveSession(mint.token, { ...miReadUser(), cUserId: mint.cUserId, passToken, userId, deviceId })
                      ok = true
                      break
                    } catch (e: any) {
                      notify(String(e?.message ?? e).slice(0, 40), "error")
                      // 不关弹窗：用户可以重试登录
                    }
                  }
                }
                if (presented) { try { controller.dismiss() } catch { } await new Promise<void>(r => (setTimeout as any)(r, 400)) }
                if (ok && miHasLogin()) {
                  notify("小米账号登录成功", "info")
                  bump?.()
                  close()
                } else if (!presented) {
                  // 用户手动关了弹窗且没拿到登录态
                  if (!miHasLogin()) notify("小米登录未完成，请重试", "warn")
                }
              } finally {
                try { controller.dispose() } catch { }
              }
            })()
          }} />
      </Section>
    </SubPage>
  )
}
