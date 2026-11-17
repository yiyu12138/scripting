// 快递鸟登录页：登录/注册（滑块和短信由用户本人完成）。
// 手机版把访问令牌存在 localStorage["token"]（前端请求头就是 Authorization: token），
// 轮询到这个 key 就换密钥、落盘并自动收起本页。
import { Text, VStack, WebView, useEffect, useState, Toolbar, ToolbarItem, Button } from "scripting"
import { C } from "../theme"
import { credentialFromWebView, readLocalStorage, tokenFromLocalStorage } from "../kdniao"

const LOGIN_URL = "https://m.kdniao.com/#/register"  // 手机版注册页，右下角「已有账号，马上登录」可切登录

export function KdniaoLoginPage({ close, bump }: { close: () => void; bump: () => void }) {
  // ephemeral：重新授权时不带旧 Cookie/localStorage，否则旧 token 还在会秒判登录成功、窗口秒退
  const [wv] = useState(() => new WebViewController({ ephemeral: true }))
  const [msg, setMsg] = useState("登录或注册后窗口会自动关闭")

  useEffect(() => {
    let alive = true
    let done = false
    void (async () => {
      // m.kdniao.com 的路由守卫：本地有 userInfo 时访问 /login 会被 replace("/") 弹回首页。
      // 先清残留的 userInfo 再进登录页，「已有账号，马上登录」才能正常跳转。
      const clearUserInfo = "try{localStorage.removeItem('userInfo')}catch(e){}"
      try { await wv.loadURL(LOGIN_URL) } catch { }
      try { await wv.evaluateJavaScript(clearUserInfo) } catch { }
      try { await wv.loadURL(LOGIN_URL) } catch (e: any) {
        if (alive) setMsg("页面加载失败：" + String(e?.message ?? e))
      }
    })()

    // 轮询：手机版写 localStorage["token"]，PC 版写 app-sso.state.accessToken，
    // 统一交给 tokenFromLocalStorage 判断；拿到就换密钥关窗
    const timer = setInterval(async () => {
      if (!alive || done) return
      const ls = await readLocalStorage(wv)
      const token = tokenFromLocalStorage(ls)
      if (!token) return
      done = true
      if (alive) setMsg("登录成功，正在读取账号密钥…")
      try {
        await credentialFromWebView(wv)
        if (alive) { bump(); close() }
      } catch (e: any) {
        // 账号下还没建 API 密钥之类：留在页面上，让用户看到原因
        done = false
        if (alive) setMsg(String(e?.message ?? e))
      }
    }, 800)

    return () => {
      alive = false
      clearInterval(timer)
      try { wv.dispose() } catch { }
    }
  }, [])

  return (
    <VStack spacing={0} frame={{ maxWidth: "infinity", maxHeight: "infinity" }} background={C.bg}
      navigationTitle="登录快递鸟" navigationBarTitleDisplayMode="inline"
      // 隐藏系统返回按钮同时会禁用本页侧滑返回（避免和滑块验证码手势冲突）；
      // 返回按钮用同位置的 Toolbar 按钮补回，观感不变
      navigationBarBackButtonHidden={true}
      toolbar={
        <Toolbar>
          <ToolbarItem placement="cancellationAction">
            <Button title="" systemImage="chevron.left" action={close} />
          </ToolbarItem>
        </Toolbar>
      }>
      <WebView controller={wv} />
      <Text font={12} foregroundStyle={C.secondary} padding={{ horizontal: 16, vertical: 8 }}
        frame={{ maxWidth: "infinity", alignment: "leading" }}>
        {msg}
      </Text>
    </VStack>
  )
}
