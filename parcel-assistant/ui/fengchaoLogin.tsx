// 丰巢授权：原生表单（手机号 + 短信验证码），不走 WebView。
// 丰巢的登录接口需要 RSA 签名，页面本身没有可复用的登录页，所以这里直接用接口登录，
// 界面完全由我们绘制，不存在页面排版问题。token 存 Keychain，之后长期复用。
import { Text, VStack, HStack, TextField, Button, Spacer, useState, useEffect } from "scripting"
import { C } from "../theme"
import { Section, SubPage } from "./kit"
import { fcLogin, fcMobile, fcSendCode } from "../utils/fengchao"
import { notify } from "./notify"

export function FengchaoLoginPage({ close, bump, onDone }: { close: () => void; bump: () => void; onDone?: () => void }) {
  const [phone, setPhone] = useState(fcMobile())
  const [code, setCode] = useState("")
  const [busy, setBusy] = useState<"" | "send" | "login">("")
  const [tip, setTip] = useState("")
  const [left, setLeft] = useState(0)

  useEffect(() => {
    if (left <= 0) return
    const t = setTimeout(() => setLeft(v => (v > 0 ? v - 1 : 0)), 1000)
    return () => clearTimeout(t)
  }, [left])

  const phoneOk = /^1\d{10}$/.test(phone.replace(/\D/g, ""))

  async function send() {
    if (busy || !phoneOk) return
    setBusy("send")
    setTip("")
    try {
      await fcSendCode(phone)
      setLeft(60)
      setTip("验证码已发送")
    } catch (e: any) {
      setTip(String(e?.message ?? e))
    } finally {
      setBusy("")
    }
  }

  async function doLogin() {
    if (busy || !phoneOk) return
    if (!/^\d{4,8}$/.test(code.trim())) { setTip("请输入短信验证码"); return }
    setBusy("login")
    setTip("")
    try {
      await fcLogin(phone, code.trim())
      notify("丰巢授权成功")
      bump()
      // 只同步刚授权的这一路，别把其它平台一起拉一遍
      onDone?.()
      close()
    } catch (e: any) {
      setTip(String(e?.message ?? e))
    } finally {
      setBusy("")
    }
  }

  return (
    <SubPage title="授权丰巢" onClose={close}
      save={{ title: busy === "login" ? "登录中…" : "登录", disabled: busy !== "" || !phoneOk, action: doLogin }}>
      <Section
        title="手机号登录"
        footer="用丰巢绑定的手机号登录，授权后可读取在柜待取件与真实取件码。在柜件会自动合并到已有包裹上，不会重复显示。">
          <VStack spacing={0} padding={{ vertical: 2 }}>
            <HStack spacing={10} frame={{ maxWidth: "infinity" }} padding={{ vertical: 4 }}>
              <Text font={16} foregroundStyle={C.text} frame={{ width: 66, alignment: "leading" }}>手机号</Text>
              <TextField title="" prompt="11 位手机号" value={phone}
                onChanged={(v: string) => setPhone(v.replace(/[^\d]/g, "").slice(0, 11))}
                multilineTextAlignment="leading" keyboardType="numberPad"
                frame={{ maxWidth: "infinity" }} />
            </HStack>
            <VStack frame={{ height: 0.5, maxWidth: "infinity" }} background={C.separator} />
            <HStack spacing={8} frame={{ maxWidth: "infinity" }} padding={{ vertical: 4 }}>
              <Text font={16} foregroundStyle={C.text} frame={{ width: 66, alignment: "leading" }}>验证码</Text>
              <TextField title="" prompt="短信验证码" value={code}
                onChanged={(v: string) => setCode(v.replace(/[^\d]/g, "").slice(0, 8))}
                multilineTextAlignment="leading" keyboardType="numberPad"
                frame={{ maxWidth: 150 }} />
              <Spacer />
              <Button
                title={left > 0 ? `${left}s` : busy === "send" ? "发送中…" : "获取验证码"}
                buttonStyle="bordered"
                disabled={busy !== "" || left > 0 || !phoneOk}
                action={send}
              />
            </HStack>
          </VStack>
        </Section>

      {tip ? (
        <Text font={13} foregroundStyle={C.secondary} padding={{ horizontal: 16, vertical: 6 }}>
          {tip}
        </Text>
      ) : null}
    </SubPage>
  )
}
