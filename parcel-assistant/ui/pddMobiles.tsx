// 取件手机号管理（内嵌在平台详情页，不多开页面）：
// 号码列表始终显示；点「绑定其他手机号」/「修改备注」时在列表下方就地展开一张表单，收起后列表还在。
// 这样做的好处：不管表单怎么操作，用户永远看得见自己的号，不会出现「退不回列表」的状态。
//
// 风控边界：这几个接口要 anti-content，令牌由拼多多官方页面里的反爬 JS 现场算（utils/pddAnti.ts），
// 我们只加载官方页并调它的生成器，不计算、不重放、不伪造任何字段。
import { Button, HStack, Image, Menu, ProgressView, Text, TextField, VStack, useEffect, useState, Section as NativeSection } from "scripting"
import { C, alpha } from "../theme"
import { FormActions, InputLine, Row, Section, SectionHeader } from "./kit"
import { notify } from "./notify"
import {
  pddBoundMobiles, pddBindPreCheck, pddFastBindMobile, pddSendBindSms, pddVerifyBindSms,
  pddNewBindMobile, pddUnbindMobile, pddUpdateMobileAlias, pddStationPackages, applyPddPickupCodes,
  type PddBindPreCheck, type PddBoundMobile,
} from "../utils/pddExpress"
import { pddAntiCleanup } from "../utils/pddAnti"

export type PddMobiles = { pre: PddBindPreCheck | null; mobiles: PddBoundMobile[]; onlyWxScan?: boolean; waiting?: number }

/** 列表 + 预检查并发读，顺带看一眼驿站（能知道这个账号是不是只能微信取件） */
export async function loadPddMobiles(): Promise<PddMobiles> {
  const [mobiles, pre, station] = await Promise.all([
    pddBoundMobiles().catch(() => [] as PddBoundMobile[]),
    pddBindPreCheck().catch(() => null),
    pddStationPackages().catch(() => null),
  ])
  return { pre, mobiles, onlyWxScan: station?.onlyWxScan ?? false, waiting: station?.items.length ?? 0 }
}

const digits = (v: string, n: number) => v.replace(/[^0-9]/g, "").slice(0, n)

function labelOf(m: PddBoundMobile): string {
  return m.alias ? `${m.masked}（${m.alias}）` : m.masked
}

/** 内嵌在平台详情页的取件手机号管理 */
export function PddMobileSection({ authed, bump }: {
  authed: boolean; bump: () => void
}) {
  const [data, setData] = useState<PddMobiles>({ pre: null, mobiles: [] })
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState("")
  const [loaded, setLoaded] = useState(false)

  // 模式：列表（默认）/ 绑定表单 / 改备注表单——后两者是列表下方的一块，不是替换整页
  const [mode, setMode] = useState<"list" | "bind" | "alias">("list")
  const [mobile, setMobile] = useState("")
  const [code, setCode] = useState("")
  const [left, setLeft] = useState(0)
  const [mobileId, setMobileId] = useState("")
  const [sent, setSent] = useState(false)
  const [aliasDraft, setAliasDraft] = useState("")
  const [aliasFor, setAliasFor] = useState<PddBoundMobile | null>(null)

  useEffect(() => {
    if (left <= 0) return
    const t = setTimeout(() => setLeft(v => (v > 0 ? v - 1 : 0)), 1000)
    return () => clearTimeout(t)
  }, [left])

  useEffect(() => {
    if (!authed) return
    void reload()
    return () => { pddAntiCleanup() }
  }, [authed])

  async function reload() {
    try {
      setData(await loadPddMobiles())
      setErr("")
    } catch (e: any) {
      setErr(String(e?.message ?? e).slice(0, 40))
    } finally {
      setLoaded(true)
    }
  }

  function closeForm() {
    setMode("list"); setSent(false); setMobile(""); setCode("")
    setAliasDraft(""); setAliasFor(null); setLeft(0); setMobileId("")
  }

  async function guard(op: () => Promise<void>, done: string) {
    if (busy) return
    setBusy(true)
    try {
      await op()
      // 绑定后，寄到这个号、绑定前就到站的件才查得到，顺手把取件码补进包裹
      void applyPddPickupCodes().catch(() => { })
      await reload()
      notify(done)
      bump()
    } catch (e: any) {
      const msg = String(e?.message ?? e).slice(0, 40)
      setErr(msg)
      notify(msg, "error")
    } finally {
      setBusy(false)
    }
  }

  async function sendCode() {
    if (busy || mobile.length !== 11) return
    setBusy(true); setErr("")
    try {
      setMobileId(await pddSendBindSms(mobile))
      setSent(true); setCode(""); setLeft(60)
      notify("验证码已发送")
    } catch (e: any) {
      const msg = String(e?.message ?? e).slice(0, 40)
      setErr(msg); notify(msg, "error")
    } finally { setBusy(false) }
  }

  async function doBind() {
    if (busy || !sent || code.length !== 6) return
    setBusy(true); setErr("")
    try {
      const session = await pddVerifyBindSms(mobileId, code)
      await pddNewBindMobile(session, aliasDraft.trim())
      closeForm()
      await guard(async () => { }, "已绑定")
    } catch (e: any) {
      const msg = String(e?.message ?? e).slice(0, 40)
      setErr(msg); notify(msg, "error")
    } finally { setBusy(false) }
  }

  async function doAlias() {
    const target = aliasFor
    if (!target || busy) return
    if (aliasDraft.trim() === target.alias) { closeForm(); return }
    setBusy(true); setErr("")
    try {
      await pddUpdateMobileAlias(target.mobileId, aliasDraft.trim(), target.scene)
      closeForm()
      await guard(async () => { }, "已修改备注")
    } catch (e: any) {
      const msg = String(e?.message ?? e).slice(0, 40)
      setErr(msg); notify(msg, "error")
    } finally { setBusy(false) }
  }

  const { pre, mobiles } = data
  // 快速绑定只在预检查给了已有号、且它还没在列表里时才提示
  const showFastBind = !!pre && !!pre.mobileId && mobiles.every(m => m.mobileId !== pre.mobileId)
  const canSend = mobile.length === 11
  const canBind = sent && code.length === 6

  return (
    <>
      <Section key="list" title="取件手机号"
        footer={!authed
          ? "先授权拼多多才能读取和管理取件手机号。"
          : (err || undefined)}>
        {!authed ? (
          <HStack spacing={12} padding={{ vertical: 8 }} frame={{ maxWidth: "infinity", alignment: "leading" }}>
            <Text font={16} foregroundStyle={C.tertiary}>未授权</Text>
          </HStack>
        ) : !loaded ? (
          <HStack spacing={10} padding={{ vertical: 8 }} frame={{ maxWidth: "infinity", alignment: "leading" }}>
            <ProgressView controlSize="small" />
            <Text font={16} foregroundStyle={C.secondary}>正在读取…</Text>
          </HStack>
        ) : mobiles.length === 0 ? (
          <HStack spacing={12} padding={{ vertical: 8 }} frame={{ maxWidth: "infinity", alignment: "leading" }}>
            <Text font={16} foregroundStyle={C.tertiary}>未绑定手机号</Text>
          </HStack>
        ) : (
          mobiles.map(m => (
            <HStack key={m.mobileId || m.masked} spacing={10} padding={{ vertical: 7 }}
              frame={{ maxWidth: "infinity", alignment: "leading" }}>
              <Text font={17} foregroundStyle={C.text} frame={{ maxWidth: "infinity", alignment: "leading" }}>
                {labelOf(m)}
              </Text>
              {m.commonlyUsed ? (
                <Text font={12} fontWeight="medium" foregroundStyle={C.accent}
                  padding={{ horizontal: 8, vertical: 3 }}
                  background={{ style: alpha("#6B5BD2", 0.12), shape: { type: "capsule", style: "continuous" } }}>
                  常用
                </Text>
              ) : null}
              <Menu label={<Image systemName="ellipsis.circle" font={17} foregroundStyle={C.tertiary} />}>
                <Button title="修改备注" systemImage="square.and.pencil" action={() => {
                  setAliasFor(m); setAliasDraft(m.alias); setMode("alias")
                }} />
                <Button title="解绑" systemImage="trash" role="destructive" action={() => {
                  void Dialog.confirm({
                    title: `解绑 ${labelOf(m)}？`,
                    message: "解绑后，寄到这个手机号的快递就不能用本账号的身份码取件了。",
                    confirmLabel: "解绑",
                    cancelLabel: "取消",
                    role: "destructive",
                  } as any).then((ok: boolean) => {
                    if (!ok) return
                    void guard(() => pddUnbindMobile(m.mobileId, m.scene), "已解绑")
                  })
                }} />
              </Menu>
            </HStack>
          ))
        )}

        {authed && data.onlyWxScan ? (
          <Text font={13} foregroundStyle={C.orange} padding={{ vertical: 2 }}>
            只能微信扫码取件：接口不给待取件的取件码，身份码照常可用。
          </Text>
        ) : null}

        {authed && loaded && mode === "list" ? (
          <VStack spacing={0}>
            {showFastBind ? (
              <Row icon="person.crop.circle.badge.checkmark" iconColor={C.accent}
                title={busy ? "绑定中…" : pre!.mobileDesc ? `绑定本账号手机号（${pre!.mobileDesc}）` : "绑定本账号手机号"}
                chevron={false}
                onTap={() => {
                  if (busy) return
                  void guard(async () => {
                    await pddFastBindMobile(pre!.mobileId, pre!.mobileIdScene)
                  }, "已绑定本账号手机号")
                }} />
            ) : null}
            <Row icon="plus.circle" iconColor={C.accent} title="绑定其他手机号"
              onTap={() => { setMobile(""); setCode(""); setAliasDraft(""); setSent(false); setLeft(0); setMode("bind") }} />
          </VStack>
        ) : null}
      </Section>

      {mode === "bind" ? (
        <NativeSection key="bind"
          header={<SectionHeader title="绑定取件手机号" action="收起" onAction={closeForm} />}
          footer={<Text font={12} foregroundStyle={C.tertiary}>{err || (sent ? `验证码已发到 ${mobile}。` : "绑定后，寄到这个手机号的快递也能用本账号的身份码取件。")}</Text>}>
          <InputLine label="手机号" divider>
            <TextField title="" prompt="11 位手机号" value={mobile} keyboardType="numberPad"
              multilineTextAlignment="leading" frame={{ maxWidth: "infinity" }}
              onChanged={(v: string) => {
                setMobile(digits(v, 11))
                if (sent) { setSent(false); setCode(""); setLeft(0); setMobileId("") }
              }} />
          </InputLine>
          <InputLine label="验证码" divider>
            <TextField title="" prompt="6 位验证码" value={code} keyboardType="numberPad"
              multilineTextAlignment="leading" frame={{ maxWidth: "infinity" }}
              onChanged={(v: string) => setCode(digits(v, 6))} />
            <Button title={left > 0 ? `${left}s` : sent ? "重新发送" : "获取验证码"}
              buttonStyle="bordered" controlSize="small"
              disabled={busy || left > 0 || !canSend}
              action={() => void sendCode()} />
          </InputLine>
          <InputLine label="备注">
            <TextField title="" prompt="可选" value={aliasDraft}
              multilineTextAlignment="leading" frame={{ maxWidth: "infinity" }}
              onChanged={(v: string) => setAliasDraft(v.slice(0, 5))} />
          </InputLine>
          <VStack padding={{ vertical: 6 }} frame={{ maxWidth: "infinity" }}>
            <FormActions cancel="收起" confirm={busy ? "绑定中…" : "绑定"} busy={busy} disabled={!canBind}
              onCancel={closeForm} onConfirm={() => void doBind()} />
          </VStack>
        </NativeSection>
      ) : null}

      {mode === "alias" && aliasFor ? (
        <NativeSection key="alias"
          header={<SectionHeader title="修改备注" action="收起" onAction={closeForm} />}
          footer={<Text font={12} foregroundStyle={C.tertiary}>备注只给自己看，最多 5 个字；留空保存就是去掉备注。</Text>}>
          <InputLine label="备注">
            <TextField title="" prompt="比如：家里" value={aliasDraft}
              multilineTextAlignment="leading" frame={{ maxWidth: "infinity" }}
              onChanged={(v: string) => setAliasDraft(v.slice(0, 5))} />
          </InputLine>
          <VStack padding={{ vertical: 6 }} frame={{ maxWidth: "infinity" }}>
            <FormActions cancel="收起" confirm={busy ? "保存中…" : "保存"} busy={busy}
              onCancel={closeForm} onConfirm={() => void doAlias()} />
          </VStack>
        </NativeSection>
      ) : null}
    </>
  )
}
