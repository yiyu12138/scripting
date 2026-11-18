import {
  Button,
  HStack,
  List,
  Navigation,
  NavigationStack,
  Pasteboard,
  Safari,
  Script,
  SecureField,
  Section,
  Spacer,
  Text,
  TextField,
  VStack,
  useState,
} from "scripting"
import {
  getApiKey, getConfig, getToken, parseRepo, saveConfig, setApiKey, setToken,
} from "./utils/config"
import type { SurgeConfig } from "./utils/config"
import { listModules, moduleDetail, setModulesEnabled } from "./utils/surge"
import {
  readLatest, readModuleText, saveBackup, writeLatest,
} from "./utils/backup"
import type { BackupInput, BackupModule, Manifest } from "./utils/backup"
import { uploadFile } from "./utils/github"

const GRAY = "#8E8E93" as any

function Hint({ children }: { children: string }) {
  return <Text font={12} foregroundStyle={GRAY} lineLimit={6}>{children}</Text>
}

function Row({ label, children }: { label: string; children: any }) {
  return (
    <HStack spacing={8}>
      <Text font={13}>{label}</Text>
      <Spacer />
      {children}
    </HStack>
  )
}

const toNumber = (value: string, fallback: number) => {
  const n = Number(value.trim())
  return Number.isInteger(n) && n > 0 && n < 65536 ? n : fallback
}

function installLink(rawURL: string): string {
  return `surge:///install-module?url=${encodeURIComponent(rawURL)}`
}

function App() {
  const initial = getConfig()
  const [host, setHost] = useState(initial.host)
  const [port, setPort] = useState(String(initial.port))
  const [key, setKey] = useState(getApiKey())
  const [repo, setRepo] = useState(initial.repo)
  const [branch, setBranch] = useState(initial.branch)
  const [token, setToken] = useState(getToken())
  const [status, setStatus] = useState("")
  const [busy, setBusy] = useState(false)
  const [manifest, setManifest] = useState<Manifest | null>(() => readLatest())

  function config(): SurgeConfig {
    return {
      host: host.trim() || "127.0.0.1",
      port: toNumber(port, 6171),
      repo: repo.trim(),
      branch: branch.trim() || "main",
    }
  }

  function persist() {
    saveConfig(config())
    setApiKey(key)
    setToken(token)
  }

  async function run(task: () => Promise<string>) {
    if (busy) return
    setBusy(true)
    setStatus("处理中…")
    try {
      setStatus(await task())
    } catch (error) {
      setStatus(`失败：${error instanceof Error ? error.message : String(error)}`)
    } finally {
      setBusy(false)
    }
  }

  const doTest = () => run(async () => {
    persist()
    const list = await listModules(config())
    return `连上了：${list.modules.length} 个模块，启用了 ${list.enabled.length} 个`
  })

  const doBackup = () => run(async () => {
    persist()
    const list = await listModules(config())
    const targets = list.modules.filter(item => item.type !== "internal")
    const items: BackupInput[] = []
    const failed: string[] = []
    for (const item of targets) {
      const text = await moduleDetail(config(), item.name)
      if (!text.trim()) { failed.push(item.name); continue }
      items.push({
        name: item.name, type: item.type, enabled: item.enabled,
        description: item.description, header: item.header, text,
      })
    }
    if (!items.length) throw new Error("没拿到任何模块内容")
    const saved = saveBackup(config().host, items)
    setManifest(saved)
    const skipped = list.modules.length - targets.length
    const extra = failed.length ? `，${failed.length} 个读取失败` : ""
    return `已备份 ${items.length} 个模块（跳过 ${skipped} 个内置${extra}）`
  })

  const doUpload = () => run(async () => {
    persist()
    const latest = manifest ?? readLatest()
    if (!latest) throw new Error("先备份一次")
    if (!parseRepo(config().repo)) throw new Error("仓库填 owner/name，例如 owner/scripting")
    if (!token.trim()) throw new Error("先填 GitHub Token（需要 Contents 读写权限）")

    const next: Manifest = { ...latest, modules: latest.modules.map(item => ({ ...item })) }
    let uploaded = 0
    for (const item of next.modules) {
      const text = readModuleText(latest, item)
      if (!text.trim()) continue
      item.url = await uploadFile({
        token: token.trim(), repo: config().repo, branch: config().branch,
        path: `surge-backup/${item.file}`, content: text,
        message: `surge: backup ${item.name}`,
      })
      uploaded++
    }
    writeLatest(next)
    setManifest(next)
    return `上传了 ${uploaded} 个模块，装回来时点下面的「安装」`
  })

  const doInstall = (item: BackupModule) => run(async () => {
    if (!item.url) throw new Error("这个模块还没上传，先上传到 GitHub")
    await Safari.openURL(installLink(item.url))
    return `已打开 Surge，安装「${item.name}」`
  })

  const doCopyLinks = () => run(async () => {
    const latest = manifest ?? readLatest()
    const links = (latest?.modules ?? []).filter(item => item.url).map(item => installLink(item.url))
    if (!links.length) throw new Error("还没有安装链接，先上传")
    await Pasteboard.setString(links.join("\n"))
    return `已复制 ${links.length} 条安装链接`
  })

  const doRestoreStates = () => run(async () => {
    persist()
    const latest = manifest ?? readLatest()
    if (!latest) throw new Error("先备份一次")
    const list = await listModules(config())
    const known = new Set(list.modules.map(item => item.name))
    const states: Record<string, boolean> = {}
    for (const item of latest.modules) if (known.has(item.name)) states[item.name] = item.enabled
    const count = Object.keys(states).length
    if (!count) throw new Error("备份里的模块现在一个都没装上")
    await setModulesEnabled(config(), states)
    return `已按备份恢复 ${count} 个模块的启用状态`
  })

  const modules = manifest?.modules ?? []
  const savedAt = manifest?.savedAt ? new Date(manifest.savedAt).toLocaleString() : "还没有备份"

  return (
    <NavigationStack>
      <List navigationTitle="Surge 模块备份">
        <Section header={<Text>Surge HTTP API</Text>}>
          <Row label="主机">
            <TextField title="主机" value={host} onChanged={setHost} onBlur={persist}
              prompt="127.0.0.1" font={13} fontDesign="monospaced" textFieldStyle="plain"
              keyboardType="URL" textInputAutocapitalization="never" autocorrectionDisabled />
          </Row>
          <Row label="端口">
            <TextField title="端口" value={port} onChanged={setPort} onBlur={persist}
              prompt="6171" font={13} fontDesign="monospaced" textFieldStyle="plain" keyboardType="numberPad" />
          </Row>
          <Row label="API Key">
            <SecureField title="API Key" value={key} onChanged={setKey} onBlur={persist}
              prompt="http-api 里的密钥" font={13} fontDesign="monospaced" textFieldStyle="plain"
              textInputAutocapitalization="never" autocorrectionDisabled />
          </Row>
          <Button title="保存并测试连接" action={() => { void doTest() }} disabled={busy} />
          <Hint>{"Surge 配置文件的 [General] 里加一行：http-api = 你的密钥@0.0.0.0:6171。本机 Surge 填 127.0.0.1，Mac 上的 Surge 填它的内网 IP。"}</Hint>
        </Section>

        <Section header={<Text>备份</Text>}>
          <Button title="从 Surge 备份模块" action={() => { void doBackup() }} disabled={busy} />
          <Hint>{"把每个模块的原文抓下来存到本机（App 的 Documents/SurgeModules），内置模块跳过。"}</Hint>
          <Text font={12} foregroundStyle={GRAY}>{`最近备份：${savedAt}`}</Text>
        </Section>

        <Section header={<Text>GitHub（可选，装回来用）</Text>}>
          <Row label="仓库">
            <TextField title="仓库" value={repo} onChanged={setRepo} onBlur={persist}
              prompt="owner/name" font={13} fontDesign="monospaced" textFieldStyle="plain"
              keyboardType="URL" textInputAutocapitalization="never" autocorrectionDisabled />
          </Row>
          <Row label="分支">
            <TextField title="分支" value={branch} onChanged={setBranch} onBlur={persist}
              prompt="main" font={13} fontDesign="monospaced" textFieldStyle="plain"
              textInputAutocapitalization="never" autocorrectionDisabled />
          </Row>
          <Row label="Token">
            <SecureField title="Token" value={token} onChanged={setToken} onBlur={persist}
              prompt="fine-grained，Contents 读写" font={13} fontDesign="monospaced" textFieldStyle="plain"
              textInputAutocapitalization="never" autocorrectionDisabled />
          </Row>
          <Button title="上传最新备份" action={() => { void doUpload() }} disabled={busy || !modules.length} />
          <Button title="复制全部安装链接" action={() => { void doCopyLinks() }} disabled={busy || !modules.length} />
          <Hint>{"上传到 surge-backup/ 目录，Surge 用 surge:///install-module 拉取。仓库必须公开，否则 Surge 读不到。"}</Hint>
        </Section>

        <Section header={<Text>{`模块（${modules.length}）`}</Text>}>
          {modules.length ? modules.map(item => (
            <VStack key={item.name} alignment="leading" spacing={4}>
              <HStack spacing={6}>
                <Text font={14} lineLimit={1}>{item.name}</Text>
                <Spacer />
                <Text font={11} foregroundStyle={GRAY}>{item.enabled ? "启用中" : "已停用"}</Text>
              </HStack>
              <Text font={11} foregroundStyle={GRAY} lineLimit={1}>
                {[item.header.version ? `v${item.header.version}` : "", item.header.author ?? "", `${item.bytes} 字符`, item.url ? "已上传" : "未上传"].filter(Boolean).join(" · ")}
              </Text>
              <HStack spacing={10}>
                <Button title="安装" action={() => { void doInstall(item) }} disabled={busy || !item.url} />
                <Button title="复制原文" action={() => { void run(async () => {
                  const latest = manifest ?? readLatest()
                  if (!latest) throw new Error("没有备份")
                  const text = readModuleText(latest, item)
                  if (!text) throw new Error("读不到文件")
                  await Pasteboard.setString(text)
                  return `已复制「${item.name}」原文`
                }) }} disabled={busy} />
              </HStack>
            </VStack>
          )) : <Hint>{"还没有备份。先在上面点「从 Surge 备份模块」。"}</Hint>}
          {modules.length ? <Button title="按备份恢复启用状态" action={() => { void doRestoreStates() }} disabled={busy} /> : null}
        </Section>

        <Section header={<Text>状态</Text>}>
          <Text font={12} foregroundStyle={GRAY} lineLimit={8}>{status || "空闲"}</Text>
          <Hint>{"重装 Surge 后：逐个点「安装」，再点「按备份恢复启用状态」，最后重新装一次 MITM 证书。"}</Hint>
        </Section>
      </List>
    </NavigationStack>
  )
}

async function main() {
  try {
    await Navigation.present({ element: <App />, modalPresentationStyle: "fullScreen" })
  } finally {
    Script.exit()
  }
}

void main()
