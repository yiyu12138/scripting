// 平台详情页：从「账号授权」里点某个平台的图标/名字进来。
// 这里放这个平台专属的东西：授权状态、专属设置（拼多多取件手机号、丰巢手机号…）、
// 同步记录、解除授权。授权页本身只保留一行摘要，避免把所有设置堆在一页。
import { Button, HStack, Image, Text, Toggle, VStack, useState } from "scripting"
import { C, RR } from "../theme"
import { Icon, Section, SubPage } from "./kit"
import { assetImage } from "./assets"
import { notify } from "./notify"
import {
  PLATFORMS, authorize, clearAuth, hasAuth, markPlatform, needsReauth,
  platformEnabled, platformState, setPlatformEnabled, type PlatformId,
} from "../platforms"
import { miPhones, platformLastError, platformLastSyncedAt, syncPlatformParcels } from "../utils/platformSync"
import { PddMobileSection } from "./pddMobiles"
import { MiPhoneSection } from "./miPhones"
import { fcMobile } from "../utils/fengchao"

function hmText(t: number): string {
  const d = new Date(t)
  const p = (n: number) => String(n).padStart(2, "0")
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
}

export function PlatformDetailPage({ id, close, bump, open, closeLabel }: {
  id: PlatformId
  close: () => void
  bump: () => void
  open: (kind: string, props?: any) => void
  closeLabel?: string
}) {
  const p = PLATFORMS.find(x => x.id === id)
  const [rev, setRev] = useState(0)
  const [busy, setBusy] = useState(false)
  const [mobBusy, setMobBusy] = useState(false)
  const [syncText, setSyncText] = useState("")

  const authed = hasAuth(id)
  const expired = needsReauth(id)
  const st = platformState(id)
  const lastAt = platformLastSyncedAt(id)
  const err = platformLastError(id)
  const name = p?.name ?? id

  /* ---- 各平台专属设置都是内嵌 Section 组件，避免多开一层页面 ---- */

  async function doSync() {
    if (busy) return
    setBusy(true)
    setSyncText("准备中…")
    try {
      // 只认平台结论（与授权页、通知同一份），不再拿平台名字去 errors 里模糊匹配：
      // 「小米快递聚合」与「小米快递」对不上，就会把真实原因吐成「同步未完成」。
      const report = await syncPlatformParcels((t) => setSyncText(t || "同步中…"),
        { force: true, quietIssues: true, deadline: Date.now() + 90_000, only: [id] })
      const res = report?.results?.[id]
      if (res?.outcome === "ok") notify(`${name}已同步`)
      else if (!res) notify(`${name}未启用，请先授权或打开开关`, "warn")
      else notify(res.message, res.outcome === "failed" ? "warn" : "info")
    } catch (e: any) {
      notify(String(e?.message ?? e).slice(0, 30), "error")
    } finally {
      setBusy(false)
      setSyncText("")
      setRev(r => r + 1)
    }
  }

  async function doAuth() {
    if (busy) return
    // 丰巢是原生表单页，直接跳过去
    if (id === "fengchao") { open("fengchaoLogin"); return }
    setBusy(true)
    try {
      const e = await authorize(id)
      if (e) notify(e, "warn")
      else {
        markPlatform(id, true)
        notify(`${name}授权成功`)
        bump()
      }
    } catch (e: any) {
      notify(String(e?.message ?? e), "error")
    } finally {
      setBusy(false)
      setRev(r => r + 1)
    }
  }

  return (
    <SubPage title={name} onClose={close} closeLabel={closeLabel}>
      <Section>
        <HStack spacing={14} padding={{ vertical: 8 }} frame={{ maxWidth: "infinity", alignment: "leading" }}>
          <VStack frame={{ width: 46, height: 46 }} clipShape={RR(23)}>
            <Image image={assetImage(p?.icon ?? "logos64/hive.png")} resizable antialiased
              interpolation="high" frame={{ width: 46, height: 46 }} />
          </VStack>
          <VStack alignment="leading" spacing={3} frame={{ maxWidth: "infinity", alignment: "leading" }}>
            <Text font={17} fontWeight="semibold" foregroundStyle={C.text}>{name}</Text>
            <Text font={13} foregroundStyle={expired ? C.orange : authed ? C.accent : C.tertiary}>
              {expired ? "登录已失效，需要重新授权"
                : !authed ? "未授权"
                    // 小米没绑手机号时接口一定查不到东西：提前说清楚，不用等点同步才报错
                    : id === "mi" && miPhones().length === 0 ? "已授权 · 未绑定取件手机号"
                      : "已授权"}
            </Text>
          </VStack>
          {authed ? (
            <Button title="解除授权" buttonStyle="bordered" tint={C.red} controlSize="small" disabled={busy} action={() => {
              clearAuth(id)
              notify(`${name}已解除授权`)
              bump()
              close()
            }} />
          ) : (
            <Button title={busy ? "处理中…" : "授权"} buttonStyle="borderedProminent" controlSize="small"
              disabled={busy} action={doAuth} />
          )}
        </HStack>
      </Section>

      {/* ---- 各平台的专属设置 ---- */}
      {id === "pdd" ? (
        <PddMobileSection authed={authed} bump={bump} />
      ) : null}

      {id === "taobao" || id === "cainiao" ? (
        <Section title="数据来源" footer="两个平台共用一次淘宝登录，但可以各自停用：关掉淘宝就不再拉订单，关掉菜鸟就不再读驿站取件码。">
          <Toggle title="读取淘宝订单" systemImage="bag"
            value={platformEnabled("taobao")}
            onChanged={(v) => { setPlatformEnabled("taobao", v); setRev(r => r + 1); bump() }} />
          <Toggle title="读取菜鸟驿站取件码" systemImage="shippingbox"
            value={platformEnabled("cainiao")}
            onChanged={(v) => { setPlatformEnabled("cainiao", v); setRev(r => r + 1); bump() }} />
        </Section>
      ) : null}

      {id === "fengchao" ? (
        <Section title="账号"
          footer="丰巢的取件码来自柜机接口。在「物流详情」页里，带柜机信息的包裹会多一个「一键开柜」按钮。">
          <HStack spacing={12} padding={{ vertical: 6 }} frame={{ maxWidth: "infinity", alignment: "leading" }}>
            <Icon name="iphone" size={18} color={C.accent} />
            <Text font={16} foregroundStyle={C.text}>登录手机号</Text>
            <VStack frame={{ maxWidth: "infinity" }} />
            <Text font={15} foregroundStyle={C.secondary}>{fcMobile() || "未登录"}</Text>
          </HStack>
        </Section>
      ) : null}

      {id === "mi" ? (
        <MiPhoneSection authed={authed} bump={bump} />
      ) : null}

      <Section title="同步"
        footer={err && Date.now() - err.at < 3 * 3_600_000 ? `最近一次失败：${err.msg}` : undefined}>
        <HStack spacing={12} padding={{ vertical: 6 }} frame={{ maxWidth: "infinity", alignment: "leading" }}>
          <Icon name="clock.arrow.circlepath" size={18} color={C.accent} />
          <VStack alignment="leading" spacing={2} frame={{ maxWidth: "infinity", alignment: "leading" }}>
            <Text font={16} foregroundStyle={C.text}>上次同步</Text>
            <Text font={12} foregroundStyle={C.tertiary} lineLimit={1}>
              {busy && syncText ? syncText : (lastAt > 0 ? hmText(lastAt) : st ? `无成功记录` : "从未同步")}
            </Text>
          </VStack>
          <Button buttonStyle="bordered" disabled={busy || !authed} action={doSync}>
            <Text font={15} lineLimit={1} frame={{ minWidth: 80 }}>{busy ? "同步中…" : "立即同步"}</Text>
          </Button>
        </HStack>
      </Section>
    </SubPage>
  )
}
