// 设置与密钥：普通配置存 Storage，密钥只进 Keychain。
import { Keychain, Storage } from "scripting"

export interface SurgeConfig {
  host: string
  port: number
  repo: string
  branch: string
}

const CONFIG_KEY = "surge-modules.config"
const API_KEY_ITEM = "surge-modules.surge-api-key"
const TOKEN_ITEM = "surge-modules.github-token"

const DEFAULT_CONFIG: SurgeConfig = { host: "127.0.0.1", port: 6171, repo: "", branch: "main" }

const text = (value: unknown): string => typeof value === "string" ? value.trim() : ""

export function getConfig(): SurgeConfig {
  try {
    const raw = Storage.get<unknown>(CONFIG_KEY)
    const data = raw && typeof raw === "object" ? raw as Record<string, unknown> : {}
    return {
      host: text(data.host) || DEFAULT_CONFIG.host,
      port: typeof data.port === "number" && Number.isInteger(data.port) && data.port >= 1 && data.port <= 65535
        ? data.port : DEFAULT_CONFIG.port,
      repo: text(data.repo),
      branch: text(data.branch) || DEFAULT_CONFIG.branch,
    }
  } catch {
    return { ...DEFAULT_CONFIG }
  }
}

export function saveConfig(config: SurgeConfig): SurgeConfig {
  const next: SurgeConfig = {
    host: text(config.host) || DEFAULT_CONFIG.host,
    port: Number.isInteger(config.port) && config.port >= 1 && config.port <= 65535 ? config.port : DEFAULT_CONFIG.port,
    repo: text(config.repo),
    branch: text(config.branch) || DEFAULT_CONFIG.branch,
  }
  Storage.set(CONFIG_KEY, next)
  return next
}

function readKey(item: string): string {
  try { return Keychain.get(item)?.trim() || "" } catch { return "" }
}

function writeKey(item: string, value: string): boolean {
  try {
    const clean = value.trim()
    if (!clean) return Keychain.remove(item)
    return Keychain.set(item, clean, { synchronizable: false, accessibility: "first_unlock_this_device" })
  } catch { return false }
}

export const getApiKey = () => readKey(API_KEY_ITEM)
export const setApiKey = (value: string) => writeKey(API_KEY_ITEM, value)

export const getToken = () => readKey(TOKEN_ITEM)
export const setToken = (value: string) => writeKey(TOKEN_ITEM, value)

/** repo 允许 "owner/name" 或完整 GitHub 地址。 */
export function parseRepo(value: string): { owner: string; name: string } | null {
  const trimmed = value.trim().replace(/^https?:\/\/github\.com\//i, "").replace(/\.git$/i, "").replace(/\/+$/, "")
  const parts = trimmed.split("/")
  if (parts.length !== 2) return null
  const [owner, name] = parts
  if (!/^[\w.-]+$/.test(owner) || !/^[\w.-]+$/.test(name)) return null
  return { owner, name }
}
