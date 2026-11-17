// 小米登录辅助：照抄 ExpressAssistant getLoginUrl() —— 先 serviceLogin 拿 location
declare const fetch: any
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"

export async function resolveMiLoginUrl(): Promise<string> {
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
