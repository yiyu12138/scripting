// 淘宝扫码登录页：原生渲染二维码，手机淘宝扫一下确认即可，不输密码。
// 成功后 cookie 已由 utils/qrlogin.ts 落盘，这里只负责收尾提示与关闭。
import { Button, Image, Text, VStack, useEffect, useState } from "scripting"
import { C, RR } from "../theme"
import { Icon, Row, Section, SubPage } from "./kit"
import { notify } from "./notify"
import { qrLoginFlow, type QrStatus } from "../utils/qrlogin"
import { loginTaobao } from "../utils/net"

const TIPS: Record<string, string> = {
  LOADING: "正在获取二维码…",
  NEW: "打开手机淘宝，扫一扫",
  SCANED: "已扫码，请在手机上点确认",
  CONFIRMED: "登录成功",
  EXPIRED: "二维码已过期，点右上角刷新",
  CANCELED: "已取消登录",
  ERROR: "获取二维码失败，点右上角重试",
}

export function QrLoginPage({ close, bump }: { close: () => void; bump?: () => void }) {
  const [qr, setQr] = useState<any>(null)
  const [status, setStatus] = useState<string>("LOADING")
  const [rev, setRev] = useState(0)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    let on = true
    setQr(null)
    setStatus("LOADING")
    void (async () => {
      const ok = await qrLoginFlow(
        (content) => {
          void (async () => {
            try {
              const img = await QRCode.generate(content)
              if (on) setQr(img)
            } catch { }
          })()
        },
        (s: QrStatus) => { if (on) setStatus(s) },
        () => on,
      )
      if (!on) return
      if (ok) {
        notify("淘宝登录成功", "info")
        bump?.()
        close()
      }
    })()
    return () => { on = false }
  }, [rev])

  const failed = status === "EXPIRED" || status === "ERROR" || status === "CANCELED"

  return (
    <SubPage title="扫码登录" onClose={close}
      trailing={
        <Button buttonStyle="plain" action={() => setRev(rev + 1)}>
          <Image systemName="arrow.triangle.2.circlepath" font={17} fontWeight="semibold" foregroundStyle={C.text} />
        </Button>
      }>
      <Section>
        <VStack spacing={12} frame={{ maxWidth: "infinity" }} padding={{ vertical: 10 }}>
          {qr ? (
            <VStack padding={10} background={{ style: "#FFFFFF", shape: RR(14) }} clipShape={RR(14)}
              frame={{ width: 250, height: 250 }}>
              <Image image={qr} resizable antialiased interpolation="high"
                frame={{ width: 230, height: 230 }} />
            </VStack>
          ) : (
            <VStack frame={{ width: 250, height: 250 }}>
              <Icon name="qrcode" size={120} color={C.text} />
            </VStack>
          )}
          <Text font={14} foregroundStyle={failed ? C.red : C.secondary}>
            {TIPS[status] ?? status}
          </Text>
        </VStack>
      </Section>

      <Section footer="扫码登录不会保存密码，只保存淘宝下发的登录凭证，存在本机钥匙串。">
        <Row icon="keyboard" title={busy ? "正在打开…" : "改用密码登录"} chevron
          onTap={() => {
            if (busy) return
            setBusy(true)
            void (async () => {
              const ok = await loginTaobao()
              setBusy(false)
              if (ok) { notify("淘宝登录成功", "info"); bump?.(); close() }
            })()
          }} />
      </Section>
    </SubPage>
  )
}

