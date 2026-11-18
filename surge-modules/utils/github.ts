// 把备份推到 GitHub，拿到 raw 地址，好让 Surge 用 surge:///install-module 装回来。
import { fetch } from "scripting"
import { parseRepo } from "./config"

const B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/"

/** 自己算 base64，不依赖 Data 是否被导出。 */
export function base64Encode(text: string): string {
  const bytes: number[] = []
  for (const ch of text) {
    const code = ch.codePointAt(0) ?? 0
    if (code < 0x80) bytes.push(code)
    else if (code < 0x800) bytes.push(0xc0 | (code >> 6), 0x80 | (code & 63))
    else if (code < 0x10000) bytes.push(0xe0 | (code >> 12), 0x80 | ((code >> 6) & 63), 0x80 | (code & 63))
    else bytes.push(0xf0 | (code >> 18), 0x80 | ((code >> 12) & 63), 0x80 | ((code >> 6) & 63), 0x80 | (code & 63))
  }
  let out = ""
  for (let i = 0; i < bytes.length; i += 3) {
    const b0 = bytes[i]
    const b1 = i + 1 < bytes.length ? bytes[i + 1] : undefined
    const b2 = i + 2 < bytes.length ? bytes[i + 2] : undefined
    out += B64[b0 >> 2]
    out += B64[((b0 & 3) << 4) | (b1 === undefined ? 0 : b1 >> 4)]
    out += b1 === undefined ? "=" : B64[((b1 & 15) << 2) | (b2 === undefined ? 0 : b2 >> 6)]
    out += b2 === undefined ? "=" : B64[b2 & 63]
  }
  return out
}

function apiBase(owner: string, name: string, path: string): string {
  const encoded = path.split("/").filter(Boolean).map(encodeURIComponent).join("/")
  return `https://api.github.com/repos/${owner}/${name}/contents/${encoded}`
}

export function rawURL(repo: string, branch: string, path: string): string {
  const parsed = parseRepo(repo)
  if (!parsed) throw new Error("仓库要写成 owner/name")
  const encoded = path.split("/").filter(Boolean).map(encodeURIComponent).join("/")
  return `https://raw.githubusercontent.com/${parsed.owner}/${parsed.name}/${encodeURIComponent(branch)}/${encoded}`
}

async function github(token: string, url: string, init?: { method?: string; body?: string }) {
  const response = await fetch(url, {
    method: init?.method ?? "GET",
    headers: {
      "Authorization": `Bearer ${token}`,
      "Accept": "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      ...(init?.body ? { "Content-Type": "application/json" } : {}),
    },
    body: init?.body,
    timeout: 30,
    debugLabel: "GitHub contents",
  })
  return response
}

export async function uploadFile(options: {
  token: string
  repo: string
  branch: string
  path: string
  content: string
  message: string
}): Promise<string> {
  const parsed = parseRepo(options.repo)
  if (!parsed) throw new Error("仓库要写成 owner/name")
  if (!options.token) throw new Error("先填 GitHub Token")

  const url = apiBase(parsed.owner, parsed.name, options.path)
  let sha: string | undefined
  const existing = await github(options.token, `${url}?ref=${encodeURIComponent(options.branch)}`)
  if (existing.status === 200) {
    const data = await existing.json() as Record<string, unknown>
    if (typeof data.sha === "string") sha = data.sha
  } else if (existing.status === 401) {
    throw new Error("GitHub Token 无效（401）")
  } else if (existing.status !== 404) {
    throw new Error(`读仓库失败：HTTP ${existing.status}`)
  }

  const payload: Record<string, unknown> = {
    message: options.message,
    content: base64Encode(options.content),
    branch: options.branch,
  }
  if (sha) payload.sha = sha

  const response = await github(options.token, url, { method: "PUT", body: JSON.stringify(payload) })
  if (response.status === 401) throw new Error("GitHub Token 没有写权限（401）")
  if (response.status === 403) throw new Error("GitHub 拒绝写入（403，可能是 Token 权限或限流）")
  if (!response.ok) throw new Error(`上传失败：HTTP ${response.status}`)

  return rawURL(options.repo, options.branch, options.path)
}
