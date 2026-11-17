// 身份码 —— 三条独立身份码（淘宝 / 菜鸟 / 拼多多），各自有独立编号与二维码。
// 首页点「身份码」先进入口列表；设置页是截图里的三个开关管理页。
import { Button, Device, HStack, Image, NavigationLink, Text, Toggle, VStack, ZStack, useEffect, useState } from "scripting"
import { C, GLASS, GLASS_TINT, RR, alpha, isDark } from "../theme"
import { Icon, Row, Section, SubPage } from "./kit"
import { assetImage } from "./assets"
import {
  getIdentityCodes, setIdentityEnabled,
  type IdentityBrand, type IdentityCode,
} from "../store"
import { cnIdentityCached, fetchCnIdentity, fetchPddIdentity, fetchTbIdentity, pddIdentityCached, tbHasLogin, tbIdentityCached, type CnIdentity, type PddIdentity } from "../utils/identity"
import { loginTaobao } from "../utils/net"
import { markPlatform } from "../platforms"
import { pddHasLogin } from "../utils/pdd"
import { notify } from "./notify"
import { Barcode } from "./barcode"

const META: Record<IdentityBrand, { icon: string; bg: any; fg: any }> = {
  taobao: { icon: "qrcode", bg: alpha("#F08A2E", 0.14), fg: C.orange },
  cainiao: { icon: "barcode", bg: alpha("#34A853", 0.14), fg: C.green },
  pdd: { icon: "qrcode.viewfinder", bg: alpha("#F0554F", 0.12), fg: C.red },
}

// 三个品牌统一使用官方 App 图标（512px / 200px），裁圆后直接显示，不叠加自制底图。
const BRAND_FILE: Record<IdentityBrand, string> = {
  taobao: "identity/taobao.png",
  cainiao: "identity/cainiao.png",
  pdd: "identity/pdd.jpg",
}

export function BrandMark({ id, size = 28 }: { id: IdentityBrand; size?: number }) {
  return (
    <ZStack frame={{ width: size, height: size }} clipShape={RR(size / 2)}>
      <Image image={assetImage(BRAND_FILE[id])} resizable antialiased
        interpolation="high" frame={{ width: size, height: size }} />
    </ZStack>
  )
}

/** 该品牌的平台是否已在「账号」页授权 */
function authorizedOf(id: IdentityBrand): boolean {
  if (id === "pdd") return pddHasLogin()
  return tbHasLogin()
}

function mask(code: string): string {
  return code.replace(/(\d{4})(\d{4})(\d{4})/, "$1 $2 $3")
}

/** 单条身份码展示页 */
export function IdentityCodeSheet({ id, close, open }: {
  id: IdentityBrand
  close: () => void
  open?: (kind: string, props?: any) => void
}) {
  const [rev, setRev] = useState(0)
  const code = getIdentityCodes().find(c => c.id === id)
  const [qr, setQr] = useState<any>(null)
  const [live, setLive] = useState<CnIdentity | null>(() => (id === "cainiao" ? cnIdentityCached() : null))
  const [tbLive, setTbLive] = useState<CnIdentity | null>(() => (id === "taobao" ? tbIdentityCached() : null))
  const [pddLive, setPddLive] = useState<PddIdentity | null>(() => (id === "pdd" ? pddIdentityCached() : null))
  const [busy, setBusy] = useState(false)
  const [needLogin, setNeedLogin] = useState(false)
  // 已授权但码没取到：要跟「没授权」分开说，否则会让人以为得重新登录
  const [fail, setFail] = useState("")
  const [now, setNow] = useState(Date.now())
  // 全屏出示的是哪一张（null = 不展示）
  const [full, setFull] = useState<"qr" | "bar" | null>(null)

  // 菜鸟：进页面即取一次真码
  useEffect(() => {
    if (id !== "cainiao") return
    if (!tbHasLogin()) { setNeedLogin(true); return }
    let alive = true
    setBusy(true)
    void (async () => {
      try {
        const r = await fetchCnIdentity()
        if (!alive) return
        if (r) { setLive(r); setNeedLogin(false); setFail("") }
        else { setNeedLogin(false); setFail("菜鸟没返回身份码") }
      } catch (e: any) {
        if (!alive) return
        setNeedLogin(false); setFail(String(e?.message ?? e).slice(0, 30))
      }
      setBusy(false)
    })()
    return () => { alive = false }
  }, [id, rev])

  // 淘宝：进页面取一次淘宝 App 里那张身份码（接口与菜鸟的实名码不同）
  useEffect(() => {
    if (id !== "taobao") return
    if (!tbHasLogin()) { setNeedLogin(true); setTbLive(null); return }
    let alive = true
    setBusy(true)
    void (async () => {
      try {
        const r = await fetchTbIdentity()
        if (!alive) return
        setTbLive(r); setNeedLogin(false); setFail("")
      } catch (e: any) {
        if (!alive) return
        setTbLive(null); setNeedLogin(false); setFail(String(e?.message ?? e).slice(0, 30))
      }
      setBusy(false)
    })()
    return () => { alive = false }
  }, [id, rev])

  // 拼多多：同样进页面即取一次，码值与到期时间都按接口返回
  useEffect(() => {
    if (id !== "pdd") return
    if (!pddHasLogin()) { setNeedLogin(true); setPddLive(null); return }
    let alive = true
    setBusy(true)
    void (async () => {
      try {
        const r = await fetchPddIdentity()
        if (!alive) return
        if (r) { setPddLive(r); setNeedLogin(false); setFail("") }
        else { setNeedLogin(true); setPddLive(null) }
      } catch (e: any) {
        if (!alive) return
        const msg = String(e?.message ?? e)
        setPddLive(null); setNeedLogin(false); setFail(msg.slice(0, 140))
        // 身份码是最早发现掉登录的地方：平台状态要跟着改，否则「账号」页还写着已授权
        if (/失效|重新授权|未登录|40001/.test(msg)) {
          try { markPlatform("pdd", false, "登录已失效") } catch { }
          notify("拼多多登录已失效，请在账号页重新授权", "warn")
        }
      }
      setBusy(false)
    })()
    return () => { alive = false }
  }, [id, rev])

  // 倒计时：两个品牌都用接口给的到期时间
  const exp = (id === "cainiao" ? live?.expiresAt : id === "taobao" ? tbLive?.expiresAt : id === "pdd" ? pddLive?.expiresAt : 0) ?? 0
  useEffect(() => {
    if (!exp) return
    const t = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(t)
  }, [exp])

  const liveCode = (id === "cainiao" ? live?.code : id === "taobao" ? tbLive?.code : id === "pdd" ? pddLive?.code : "") ?? ""
  const shown = liveCode || (code?.code ?? "")
  // 码已失效：接口报了登录失效/要重新授权。这时的缓存码不能再出示，
  // 否则扫下去等于把别人的件领走 —— 界面模糊掉并明说
  const stale = !!fail && /失效|重新授权/.test(fail)

  // 全屏出示：条码/二维码点一下放大，条码转成横向铺满长边
  function openFull(kind: "qr" | "bar") {
    if (!shown) return
    if (stale) { notify("身份码已失效，请刷新或重新授权", "warn"); return }
    setFull(kind)
  }

  useEffect(() => {
    let alive = true
    setQr(null)
    void (async () => {
      if (!shown) return
      try {
        // 二维码内容就是码本身（驿站的机器扫的就是这串），不要加自定前缀，
        // 否则高拍仪/驿站 App 认不出来
        const img = await QRCode.generate(shown)
        if (alive && img) setQr(img)
      } catch {}
    })()
    return () => { alive = false }
  }, [id, rev, shown])

  if (!code) {
    return (
      <SubPage title="身份码" onClose={close}>
        <Section><Text font={15} foregroundStyle={C.secondary}>这条身份码已删除</Text></Section>
      </SubPage>
    )
  }

  const left = exp ? Math.max(0, Math.floor((exp - now) / 1000)) : 0
  const mmss = `${String(Math.floor(left / 60)).padStart(2, "0")}:${String(left % 60).padStart(2, "0")}`

  // 到期就换：只剩 1 秒时才重新取，不提前刷（倒计时读的就是接口给的剩余时间）
  useEffect(() => {
    if (!exp || busy || needLogin || fail) return
    if (left > 1 || left <= 0) return
    setRev(r => r + 1)
  }, [left, exp, busy, needLogin, fail])

  if (needLogin && (id === "cainiao" || id === "taobao" || id === "pdd")) {
    const isPdd = id === "pdd"
    const isTb = id === "taobao"
    return (
      <SubPage title={code.name} onClose={close}>
        <Section footer={isPdd
          ? "在「账号」页授权拼多多后，自动取取件身份码。"
          : isTb ? "淘宝登录后自动取淘宝身份码，不需要输入任何信息。"
          : "用淘宝账号登录一次，之后自动取实名身份码，不再需要输入。"}>
          <VStack spacing={10} frame={{ maxWidth: "infinity" }} padding={{ vertical: 10 }}>
            <Icon name="person.badge.key" size={46} color={isPdd ? C.red : isTb ? C.orange : C.green} />
            <Text font={15} foregroundStyle={C.secondary} multilineTextAlignment="center">
              {busy ? "正在校验登录状态…" : isPdd ? "授权拼多多后可显示取件身份码" : isTb ? "登录淘宝后可显示淘宝身份码" : "登录淘宝后可显示实名身份码"}
            </Text>
          </VStack>
        </Section>
        <Section>
          <Button title={busy ? "请稍候" : isPdd ? "去授权拼多多" : "登录淘宝"} buttonStyle="borderedProminent" frame={{ maxWidth: "infinity" }}
            disabled={busy}
            action={() => {
              if (busy) return
              // 拼多多走「账号」页的授权流程，淘宝走扫码登录
              if (isPdd) { open ? open("authorize") : notify("请在账号页授权拼多多", "warn"); return }
              if (open) { open("qrLogin"); return }
              setBusy(true)
              void (async () => {
                await loginTaobao()
                setBusy(false)
                setRev(rev + 1)
              })()
            }} />
        </Section>
      </SubPage>
    )
  }
  return (
    <SubPage title={code.name} onClose={close}
      trailing={
        <Button action={() => { setFail(""); setRev(r => r + 1) }} buttonStyle="plain">
          <Image systemName="arrow.triangle.2.circlepath" font={17} fontWeight="semibold" foregroundStyle={C.text} />
        </Button>
      }>
      <Section>
        <VStack spacing={12} frame={{ maxWidth: "infinity" }} padding={{ vertical: 8 }}
          fullScreenCover={{
            isPresented: full !== null,
            onChanged: (v: boolean) => { if (!v) setFull(null) },
            content: <CodeFullScreen kind={full ?? "qr"} value={shown} img={qr} onClose={() => setFull(null)} />,
          }}>
          {/* 灯条用 shown 而不是 liveCode：跟下面的二维码取同一个值，
              否则接口刚失败、只有缓存码时会出现「有二维码没灯条」 */}
          {shown ? (
            <VStack padding={{ horizontal: 12, vertical: 8 }} background={{ style: "#FFFFFF", shape: RR(10) }} clipShape={RR(10)}
              opacity={stale ? 0.22 : 1} blur={stale ? 6 : 0}
              onTapGesture={() => openFull("bar")}>
              <Barcode value={shown} width={Math.min(Device.screen.width - 64, 330)} height={78} />
            </VStack>
          ) : null}
          {qr ? (
            <VStack padding={10} background={{ style: "#FFFFFF", shape: RR(14) }} clipShape={RR(14)}
              frame={{ width: 200, height: 200 }}
              opacity={stale ? 0.22 : 1} blur={stale ? 6 : 0}
              onTapGesture={() => openFull("qr")}>
              <Image image={qr} resizable antialiased interpolation="high"
                frame={{ width: 184, height: 184 }} />
            </VStack>
          ) : (
            <VStack frame={{ width: 200, height: 200 }}>
              <Icon name="qrcode" size={110} color={C.text} />
            </VStack>
          )}
          {stale ? (
            <Text font={13} fontWeight="semibold" foregroundStyle={C.red} multilineTextAlignment="center">
              码已失效，点右上角刷新或重新授权
            </Text>
          ) : (
            <Text font={13} foregroundStyle={C.secondary}>点条码或二维码可全屏出示</Text>
          )}
          {live ? (
            <Text font={12} fontWeight="medium" foregroundStyle={live.certificated ? C.green : C.red}>
              {live.certificated ? "已实名认证" : "未完成实名认证"}
            </Text>
          ) : null}
          {exp ? (
            <Text font={12} foregroundStyle={left > 60 ? C.tertiary : C.red}>
              {busy ? "正在刷新…" : left > 1 ? `${mmss} 后自动换码` : "正在自动换码…"}
            </Text>
          ) : null}
        </VStack>
      </Section>

      {id === "cainiao" && live ? (
        <Section title="实名信息" footer="信息由菜鸟返回，与菜鸟 App 一致。">
          <Row title="姓名" value={live.name || "未返回"} chevron={false} />
          <Row title="身份证号" value={live.idCard || "未返回"} chevron={false} />
          <Row title="认证状态" value={live.certificated ? "已实名" : "未实名"} chevron={false} />
        </Section>
      ) : null}

      {id === "pdd" && pddLive?.mobile ? (
        <Section title="取件人" footer="拼多多只返回绑定手机号，不含姓名与证件。">
          <Row title="绑定手机号" value={pddLive.mobile.replace(/^.*[：:]\s*/, "")} chevron={false} />
        </Section>
      ) : null}

      {fail && !needLogin ? (
        <Section footer="已授权但没取到码。可先在「账号」页重新授权，再点右上角刷新。">
          <HStack spacing={8} padding={{ vertical: 6 }} frame={{ maxWidth: "infinity", alignment: "leading" }}>
            <Text font={14} foregroundStyle={C.red}>{fail}</Text>
          </HStack>
        </Section>
      ) : null}

      <Section title="身份码编号">
        <HStack spacing={12} padding={{ vertical: 6 }} frame={{ maxWidth: "infinity" }}>
          <BrandMark id={code.id} size={34} />
          <Text font={live ? 17 : 24} fontWeight="bold" foregroundStyle={C.text} lineLimit={1} minScaleFactor={0.55}
            frame={{ maxWidth: "infinity", alignment: "leading" }}>
            {live ? shown : (shown ? mask(shown) : "未获取")}
          </Text>
          <Button title="复制" buttonStyle="bordered" disabled={!shown} action={() => {
            try { void Pasteboard.setString(shown) } catch {}
          }} />
        </HStack>
      </Section>
    </SubPage>
  )
}

/** 首页入口列表：Native NavigationLink，整行可点 */
export function IdentityListSheet({ close, open, manage = false, bump }: {
  close: () => void
  open: (kind: string, props?: any) => void
  manage?: boolean
  bump?: () => void
}) {
  const [rev, setRev] = useState(0)
  const all = getIdentityCodes()

  if (manage) {
    return (
      <SubPage title="身份码设置" onClose={close}>
        <Section title="快捷入口设置"
          footer="控制在主页右下角显示的快捷入口按钮">
          {all.map(c => (
            <HStack key={c.id} spacing={12} padding={{ vertical: 4 }} frame={{ maxWidth: "infinity", alignment: "leading" }}>
              <BrandMark id={c.id} size={30} />
              <VStack alignment="leading" spacing={2} frame={{ maxWidth: "infinity", alignment: "leading" }}>
                <Text font={16} foregroundStyle={C.text}>{c.name}</Text>
                {authorizedOf(c.id) ? null : (
                  <Text font={12} foregroundStyle={C.tertiary}>未授权，请在账号页授权</Text>
                )}
              </VStack>
              <Toggle title="" value={c.enabled} onChanged={(v) => {
                if (!v) { setIdentityEnabled(c.id, false); setRev(rev + 1); bump?.(); return }
                if (!authorizedOf(c.id)) {
                  notify(c.id === "pdd" ? "请先在账号页授权拼多多" : "请先在账号页授权淘宝", "warn")
                  setRev(rev + 1)
                  return
                }
                setIdentityEnabled(c.id, true); setRev(rev + 1); bump?.()
              }} />
            </HStack>
          ))}
        </Section>
        <Section footer="不会上传服务器，仅保存在本机。" />
      </SubPage>
    )
  }

  const list = all.filter(c => c.enabled)
  return (
    <SubPage title="身份码" onClose={close}>
      <Section title="选择要出示的身份码" footer="点一条即可出示对应二维码。">
        {list.length === 0 ? (
          <Row icon="barcode" title="还没有启用的身份码" detail="到「设置 → 身份码」里开启" chevron={false} />
        ) : list.map(c => {
          return (
            <NavigationLink key={c.id} destination={<IdentityCodeSheet id={c.id} close={() => {}} />}>
              <HStack spacing={12} padding={{ vertical: 6 }} frame={{ maxWidth: "infinity", alignment: "leading" }}>
                <BrandMark id={c.id} size={36} />
                <VStack alignment="leading" spacing={2} frame={{ maxWidth: "infinity", alignment: "leading" }}>
                  <Text font={16} fontWeight="medium" foregroundStyle={C.text}>{c.name}</Text>
                  <Text font={12} foregroundStyle={C.tertiary}>
                    {c.id === "cainiao" ? (tbHasLogin() ? "实名身份码" : "未登录淘宝") : c.code ? mask(c.code) : "未获取"}
                  </Text>
                </VStack>
              </HStack>
            </NavigationLink>
          )
        })}
      </Section>
    </SubPage>
  )
}

/** 全屏出示：白底、无干扰。条码旋转 90°，条纹沿屏幕长边走，高拍仪更好扫 */
export function CodeFullScreen({ kind, value, img, onClose }: { kind: "qr" | "bar"; value: string; img: any; onClose: () => void }) {
  // 顶部给关闭按钮留位（全 App 二级页的 topGap 都是 56），底部留给码值与提示；
  // 中间才是条码，旋转后视觉高度就是 longSide
  const longSide = Math.min(Device.screen.height - 330, 640)
  const shortSide = Math.min(Device.screen.width - 50, 340)
  return (
    <ZStack frame={{ maxWidth: "infinity", maxHeight: "infinity" }} background="#FFFFFF" ignoresSafeArea>
      {/* 用 VStack 排版而不是叠放：码块和底部文字各占一段，永远不打架 */}
      <VStack spacing={18} frame={{ maxWidth: "infinity", maxHeight: "infinity" }}
        padding={{ top: 104, bottom: 40, horizontal: 24 }}>
        <ZStack frame={{ maxWidth: "infinity", maxHeight: "infinity" }}>
          {kind === "qr" ? (
            img
              ? <Image image={img} resizable antialiased interpolation="none" frame={{ width: 320, height: 320 }} />
              : <Text font={15} foregroundStyle="#666666">二维码生成中…</Text>
          ) : (
            // 旋转不改变布局尺寸，外面用一个正方形块把它居中，视觉上就是横着的长条码
            <ZStack frame={{ width: shortSide + 40, height: shortSide + 40 }}>
              <Barcode value={value} width={longSide} height={shortSide} rotationEffect={90} />
            </ZStack>
          )}
        </ZStack>

        <VStack spacing={8}>
          <Text font={14} fontWeight="medium" foregroundStyle="#1C1C1E" lineLimit={1} minScaleFactor={0.55}>{value}</Text>
          <Text font={12} foregroundStyle="#8E8E93">
            {kind === "bar" ? "条码已横向铺满，直接对准扫码口" : "二维码已放大，请对准扫描区"}
          </Text>
        </VStack>
      </VStack>

      <VStack frame={{ maxWidth: "infinity", maxHeight: "infinity", alignment: "topTrailing" }}
        padding={{ top: 56, trailing: 20 }}>
        <VStack frame={{ width: 40, height: 40 }} background={{ style: "rgba(0,0,0,0.06)", shape: "circle" }}
          onTapGesture={onClose} contentShape="rect">
          <Image systemName="xmark" font={16} fontWeight="semibold" foregroundStyle="#1C1C1E" />
        </VStack>
      </VStack>
    </ZStack>
  )
}

/** 设置里的身份码入口进入管理态 */
export function IdentityEntrySettings({ close, open, bump }: { close: () => void; open: (kind: string, props?: any) => void; bump?: () => void }) {
  return <IdentityListSheet close={close} open={open} manage bump={bump} />
}

export { META as IDENTITY_META }
export type { IdentityCode }
