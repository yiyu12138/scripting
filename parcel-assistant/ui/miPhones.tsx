// 小米取件手机号（内嵌在平台详情页，结构跟 PddMobileSection 一致）：
// 号码列表始终显示，点绑定后在列表下方就地展开表单，收起后列表还在。
// 小米接口没有「备注」概念，所以没有备注行——这是与拼多多唯一的差异。
import { Button, HStack, Image, Menu, Text, TextField, VStack, useEffect, useState, Section as NativeSection } from "scripting"
import { C } from "../theme"
import { FormActions, InputLine, Row, Section, SectionHeader } from "./kit"
import { notify } from "./notify"
import { miSendCode, miCheckCode, miBindPhone } from "../utils/mi"
import { miPhones, miSetPhones } from "../utils/platformSync"

const digits = (v: string, n: number) => v.replace(/[^0-9]/g, "").slice(0, n)

export function MiPhoneSection({ authed, bump }: {
  authed: boolean; bump: () => void
}) {
  const [phones, setPhones] = useState<string[]>(miPhones())
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState("")
  const [mode, setMode] = useState<"list" | "bind">("list")
  const [phone, setPhone] = useState("")
  const [code, setCode] = useState("")
  const [sent, setSent] = useState(false)
  const [left, setLeft] = useState(0)

  useEffect(() => {
    if (left <= 0) return
    const t = setTimeout(() => setLeft(v => (v > 0 ? v - 1 : 0)), 1000)
    return () => clearTimeout(t)
  }, [left])

  const canSend = phone.length === 11
  const canBind = sent && /^\d{4,8}$/.test(code)

  function closeForm() {
    setMode("list"); setPhone(""); setCode(""); setSent(false); setLeft(0); setErr("")
  }

  async function send() {
    if (busy || !canSend) return
    setBusy(true); setErr("")
    try {
      await miSendCode(phone)
      setSent(true); setCode(""); setLeft(60)
      notify("验证码已发送")
    } catch (e: any) {
      const msg = String(e?.message ?? e).slice(0, 40)
      setErr(msg); notify(msg, "error")
    } finally { setBusy(false) }
  }

  async function doBind() {
    if (busy || !canBind) return
    setBusy(true); setErr("")
    try {
      await miCheckCode(phone, code)
      const next = Array.from(new Set([...phones, phone]))
      await miBindPhone(phone, next, true)
      miSetPhones(next)
      setPhones(next)
      closeForm()
      notify("已绑定")
      bump()
    } catch (e: any) {
      const msg = String(e?.message ?? e).slice(0, 40)
      setErr(msg); notify(msg, "error")
    } finally { setBusy(false) }
  }

  async function doUnbind(target: string) {
    if (busy) return
    setBusy(true); setErr("")
    try {
      // type=2 解绑这个号；剩下还有号就 type=1 全量重绑一次，保持服务端列表一致
      await miBindPhone(target, [target], false)
      const rest = phones.filter(p => p !== target)
      if (rest.length > 0) await miBindPhone(rest[0], rest, true)
      miSetPhones(rest)
      setPhones(rest)
      notify("已解绑")
      bump()
    } catch (e: any) {
      const msg = String(e?.message ?? e).slice(0, 40)
      setErr(msg); notify(msg, "error")
    } finally { setBusy(false) }
  }

  return (
    <>
      <Section key="list" title="取件手机号"
        footer={!authed
          ? "先授权小米账号才能绑定取件手机号。"
          : (err || "小米按手机号聚合包裹，不用逐个授权快递公司。")}>
        {phones.length === 0 ? (
          <HStack spacing={12} padding={{ vertical: 8 }} frame={{ maxWidth: "infinity", alignment: "leading" }}>
            <Text font={16} foregroundStyle={C.tertiary}>未绑定手机号</Text>
          </HStack>
        ) : (
          phones.map(p => (
            <HStack key={p} spacing={10} padding={{ vertical: 7 }}
              frame={{ maxWidth: "infinity", alignment: "leading" }}>
              <Text font={17} foregroundStyle={C.text} frame={{ maxWidth: "infinity", alignment: "leading" }}>{p}</Text>
              <Menu label={<Image systemName="ellipsis.circle" font={17} foregroundStyle={C.tertiary} />}>
                <Button title="解绑" systemImage="trash" role="destructive" action={() => {
                  void Dialog.confirm({
                    title: `解绑 ${p}？`,
                    message: "解绑后，寄到这个手机号的包裹不再聚合进小米快递。",
                    confirmLabel: "解绑",
                    cancelLabel: "取消",
                    role: "destructive",
                  } as any).then((ok: boolean) => {
                    if (!ok) return
                    void doUnbind(p)
                  })
                }} />
              </Menu>
            </HStack>
          ))
        )}
        {authed && mode === "list" ? (
          <VStack spacing={0}>
            <Row icon="plus.circle" iconColor={C.accent}
              title={phones.length === 0 ? "绑定取件手机号" : "绑定其他手机号"}
              onTap={() => { setPhone(""); setCode(""); setSent(false); setLeft(0); setErr(""); setMode("bind") }} />
          </VStack>
        ) : null}
      </Section>

      {mode === "bind" ? (
        <NativeSection key="bind"
          header={<SectionHeader title="绑定取件手机号" action="收起" onAction={closeForm} />}
          footer={<Text font={12} foregroundStyle={C.tertiary}>{err || (sent ? `验证码已发到 ${phone}。` : "绑定的手机号会聚合进小米快递。")}</Text>}>
          <InputLine label="手机号" divider>
            <TextField title="" prompt="11 位手机号" value={phone} keyboardType="numberPad"
              multilineTextAlignment="leading" frame={{ maxWidth: "infinity" }}
              onChanged={(v: string) => {
                setPhone(digits(v, 11))
                if (sent) { setSent(false); setCode(""); setLeft(0) }
              }} />
          </InputLine>
          <InputLine label="验证码">
            <TextField title="" prompt="短信验证码" value={code} keyboardType="numberPad"
              multilineTextAlignment="leading" frame={{ maxWidth: "infinity" }}
              onChanged={(v: string) => setCode(digits(v, 8))} />
            <Button title={left > 0 ? `${left}s` : busy ? "发送中…" : sent ? "重新发送" : "获取验证码"}
              buttonStyle="bordered" controlSize="small"
              disabled={busy || left > 0 || !canSend}
              action={() => void send()} />
          </InputLine>
          <VStack padding={{ vertical: 6 }} frame={{ maxWidth: "infinity" }}>
            <FormActions cancel="收起" confirm={busy ? "绑定中…" : "绑定"} busy={busy} disabled={!canBind}
              onCancel={closeForm} onConfirm={() => void doBind()} />
          </VStack>
        </NativeSection>
      ) : null}
    </>
  )
}
