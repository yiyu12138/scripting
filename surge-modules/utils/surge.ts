// Surge HTTP API 客户端：只用到 /v1/modules 三个接口。
import { fetch } from "scripting"
import { getApiKey } from "./config"
import type { SurgeConfig } from "./config"

export interface SurgeModule {
  name: string
  enabled: boolean
  type: string
  description: string
  header: Record<string, string>
  arguments: string[]
  updatedAt: number | null
  loadError: string
}

export interface ModuleList {
  enabled: string[]
  available: string[]
  modules: SurgeModule[]
}

function mapModule(raw: unknown): SurgeModule | null {
  if (!raw || typeof raw !== "object") return null
  const data = raw as Record<string, unknown>
  const name = typeof data.name === "string" ? data.name.trim() : ""
  if (!name) return null
  const header: Record<string, string> = {}
  if (data.header && typeof data.header === "object") {
    for (const [key, value] of Object.entries(data.header as Record<string, unknown>)) {
      if (typeof value === "string") header[key.toLowerCase()] = value
    }
  }
  return {
    name,
    enabled: data.enabled === true,
    type: typeof data.type === "string" ? data.type : "installed",
    description: typeof data.description === "string" ? data.description : "",
    header,
    arguments: Array.isArray(data.arguments) ? data.arguments.filter((item): item is string => typeof item === "string") : [],
    updatedAt: typeof data["updated-at"] === "number" ? data["updated-at"] as number : null,
    loadError: typeof data["load-error"] === "string" ? data["load-error"] as string : "",
  }
}

async function request(config: SurgeConfig, path: string, init?: { method?: string; body?: string }): Promise<unknown> {
  const key = getApiKey()
  if (!key) throw new Error("先填 Surge API Key")
  const url = `http://${config.host}:${config.port}${path}`
  let response: Response
  try {
    response = await fetch(url, {
      method: init?.method ?? "GET",
      headers: {
        "X-Key": key,
        "Accept": "application/json",
        ...(init?.body ? { "Content-Type": "application/json" } : {}),
      },
      body: init?.body,
      allowInsecureRequest: true,
      timeout: 20,
      debugLabel: "Surge HTTP API",
    })
  } catch (error) {
    throw new Error(`连不上 ${config.host}:${config.port} —— 确认 Surge 已启动、[General] 里配了 http-api`)
  }
  if (response.status === 401 || response.status === 403) throw new Error("API Key 不对（HTTP 401）")
  if (!response.ok) throw new Error(`Surge 返回 HTTP ${response.status}`)
  try { return await response.json() } catch { throw new Error("Surge 返回的不是 JSON") }
}

export async function listModules(config: SurgeConfig): Promise<ModuleList> {
  const data = await request(config, "/v1/modules") as Record<string, unknown>
  const modules = Array.isArray(data.modules) ? data.modules.map(mapModule).filter((m): m is SurgeModule => !!m) : []
  return {
    enabled: Array.isArray(data.enabled) ? data.enabled.filter((v): v is string => typeof v === "string") : [],
    available: Array.isArray(data.available) ? data.available.filter((v): v is string => typeof v === "string") : [],
    modules,
  }
}

export async function moduleDetail(config: SurgeConfig, name: string): Promise<string> {
  const data = await request(config, `/v1/modules/detail?name=${encodeURIComponent(name)}`) as Record<string, unknown>
  return typeof data.text === "string" ? data.text : ""
}

export async function setModulesEnabled(config: SurgeConfig, states: Record<string, boolean>): Promise<void> {
  await request(config, "/v1/modules", { method: "POST", body: JSON.stringify(states) })
}
