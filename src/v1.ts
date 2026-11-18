import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
import { PKCE_FLOW, refreshLiteLLMTokens, startLiteLLMInteractive } from "./core/auth.js"
import {
  fetchDiscoveredModels,
  fetchGatewayUserInfo,
  v1URL,
  type DiscoveredModel,
  type GatewayUserInfo,
} from "./core/discovery.js"
import { saveGatewayStatus } from "./core/state.js"

const PLUGIN_ID = "openai-auto"
const DEFAULT_PROVIDER_NAME = "OpenAI-Compatible (Auto)"
const ALLOWED_INPUTS = new Set(["text", "image", "audio", "video", "pdf"])

const COMPATIBLE_PACKAGES = new Set([
  "@ai-sdk/openai-compatible",
  "@opencode/ai/providers/openai-compatible",
  "@opencode/ai/providers/openai-compatible/responses",
])

interface V1PluginInput {
  client?: {
    auth?: {
      set?: (params: {
        path: { id: string }
        body: { type: "api"; key: string; metadata?: Record<string, string> }
      }) => Promise<unknown>
    }
  }
}

interface V1Prompt {
  type: "text"
  key: string
  message: string
  placeholder?: string
}

interface V1AuthHook {
  provider: string
  loader?: (
    getAuth: () => Promise<Record<string, unknown> | undefined>,
    provider: Record<string, unknown>,
  ) => Promise<Record<string, unknown>>
  methods: Array<
    | {
        type: "oauth"
        label: string
        prompts?: V1Prompt[]
        authorize(inputs?: Record<string, string>): Promise<
          | {
              url: string
              instructions: string
              method: "auto"
              callback(): Promise<
                | { type: "success"; provider?: string; key: string; metadata?: Record<string, string> }
                | { type: "failed" }
              >
            }
          | {
              url: string
              instructions: string
              method: "code"
              callback(code: string): Promise<
                | { type: "success"; provider?: string; key: string; metadata?: Record<string, string> }
                | { type: "failed" }
              >
            }
        >
      }
    | {
        type: "api"
        label: string
        prompts?: V1Prompt[]
        authorize?: (inputs?: Record<string, string>) => Promise<
          | { type: "success"; key?: string; provider?: string; metadata?: Record<string, string> }
          | { type: "failed" }
        >
      }
  >
}

interface V1Hooks {
  config?: (cfg: Record<string, unknown>) => Promise<void>
  auth?: V1AuthHook
}

interface V1AuthConnection {
  entryKey: string
  apiKey: string
  baseURL?: string
  providerID?: string
  refresh?: string
  expires?: number
  metadata?: Record<string, string>
}

function asRecord(v: unknown): Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : {}
}

function readStr(v: unknown): string | undefined {
  return typeof v === "string" && v.trim().length > 0 ? v.trim() : undefined
}

function readHeaders(v: unknown): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [k, val] of Object.entries(asRecord(v))) {
    if (typeof val === "string") out[k] = val
  }
  return out
}

function withAppHeader(headers: Record<string, string>): Record<string, string> {
  const hasApp = Object.keys(headers).some((k) => k.toLowerCase() === "x-prov-application")
  return hasApp ? headers : { "X-Prov-Application": "opencode", ...headers }
}

function toStringRecord(v: Record<string, unknown>): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [k, val] of Object.entries(v)) {
    if (typeof val === "string" && val.length > 0) out[k] = val
    else if (typeof val === "number" && Number.isFinite(val)) out[k] = String(val)
  }
  return out
}

function authJsonPath(): string {
  const dataDir = readStr(process.env.XDG_DATA_HOME) ?? join(homedir(), ".local", "share")
  return join(dataDir, "opencode", "auth.json")
}

function writeV1AuthEntry(id: string, entry: { type: "api"; key: string; metadata?: Record<string, string> }): void {
  try {
    const p = authJsonPath()
    const dir = join(p, "..")
    mkdirSync(dir, { recursive: true })
    let data: Record<string, unknown> = {}
    if (existsSync(p)) {
      try {
        data = asRecord(JSON.parse(readFileSync(p, "utf8")))
      } catch {}
    }
    data[id] = entry
    writeFileSync(p, JSON.stringify(data, null, 2), "utf8")
  } catch {}
}

function readV1AuthStore(): Record<string, unknown> {
  if (readStr(process.env.OPENCODE_AUTH_CONTENT)) {
    try {
      return asRecord(JSON.parse(process.env.OPENCODE_AUTH_CONTENT!))
    } catch {
      return {}
    }
  }
  try {
    const p = authJsonPath()
    if (!existsSync(p)) return {}
    return asRecord(JSON.parse(readFileSync(p, "utf8")))
  } catch {
    return {}
  }
}

function parseV1AuthEntry(entryKey: string, raw: unknown): V1AuthConnection | undefined {
  const rec = asRecord(raw)
  if (rec.type === "api") {
    const apiKey = readStr(rec.key)
    if (!apiKey) return undefined
    const meta = toStringRecord(asRecord(rec.metadata))
    const expNum = meta.expires ? Number(meta.expires) : NaN
    return {
      entryKey,
      apiKey,
      baseURL: readStr(meta.baseURL),
      providerID: readStr(meta.providerID),
      refresh: readStr(meta.refresh),
      expires: Number.isFinite(expNum) && expNum > 0 ? expNum : undefined,
      metadata: meta,
    }
  }
  if (rec.type === "oauth") {
    const apiKey = readStr(rec.access)
    if (!apiKey) return undefined
    const meta = toStringRecord(asRecord(rec.metadata))
    const expires = typeof rec.expires === "number" && Number.isFinite(rec.expires) ? rec.expires : undefined
    return {
      entryKey,
      apiKey,
      baseURL: readStr(meta.baseURL) ?? readStr(rec.enterpriseUrl),
      providerID: readStr(meta.providerID),
      refresh: readStr(rec.refresh),
      expires,
      metadata: meta,
    }
  }
  return undefined
}

async function resolveAuthConnection(
  entryKey: string,
  raw: unknown,
  headers: Record<string, string>,
  persist?: (apiKey: string, metadata: Record<string, string>) => Promise<void>,
): Promise<V1AuthConnection | undefined> {
  const conn = parseV1AuthEntry(entryKey, raw)
  if (!conn) return undefined
  if (
    conn.metadata?.flow === PKCE_FLOW &&
    conn.refresh &&
    conn.expires !== undefined &&
    Date.now() >= conn.expires - 60_000
  ) {
    try {
      const refreshed = await refreshLiteLLMTokens(
        {
          access: conn.apiKey,
          refresh: conn.refresh,
          expires: conn.expires,
          metadata: conn.metadata,
        },
        headers,
      )
      const nextMeta = toStringRecord({
        ...conn.metadata,
        refresh: refreshed.refresh,
        expires: String(refreshed.expires),
      })
      if (persist) await persist(refreshed.access, nextMeta).catch(() => {})
      return {
        ...conn,
        apiKey: refreshed.access,
        refresh: refreshed.refresh,
        expires: refreshed.expires,
        metadata: nextMeta,
      }
    } catch {
      return conn
    }
  }
  return conn
}

function isTargetProviderV1(
  id: string,
  p: Record<string, unknown>,
  options: Record<string, unknown>,
): boolean {
  const pOpts = asRecord(p.options)
  const pSettings = asRecord(p.settings)
  if (pOpts.autoModels === false || pSettings.autoModels === false) return false
  if (id === readStr(options.providerID) || id === PLUGIN_ID) return true
  const npm = readStr(p.npm)
  const hasUrl = Boolean(readStr(pOpts.baseURL) ?? readStr(pSettings.baseURL) ?? readStr(p.api))
  return Boolean(npm && COMPATIBLE_PACKAGES.has(npm) && hasUrl)
}

function toV1ModelConfig(m: DiscoveredModel): Record<string, unknown> {
  const input = (m.inputModalities ?? ["text"]).filter((x) => ALLOWED_INPUTS.has(x))
  const variants =
    m.reasoningEfforts && m.reasoningEfforts.length > 0
      ? Object.fromEntries(m.reasoningEfforts.map((effort) => [effort, { reasoning_effort: effort }]))
      : undefined

  return {
    id: m.id,
    name: m.name,
    tool_call: m.supportsTools ?? true,
    ...(m.reasoning ? { reasoning: true, interleaved: "reasoning_content" } : {}),
    modalities: {
      input: input.length > 0 ? input : ["text"],
      output: ["text"],
    },
    limit: {
      context: m.contextWindow ?? 128_000,
      output: m.maxTokens ?? 8_192,
    },
    ...(m.cost
      ? {
          cost: {
            input: m.cost.input,
            output: m.cost.output,
            cache_read: m.cost.cacheRead,
            cache_write: m.cost.cacheWrite,
          },
        }
      : {}),
    ...(variants ? { variants } : {}),
  }
}

/** OpenCode V1 (`@opencode-ai/plugin` / sidecar 1.18.x) `server()` hook adapter. */
export async function setupV1(
  input: V1PluginInput,
  options?: Record<string, unknown>,
): Promise<V1Hooks> {
  const opts = asRecord(options)
  const defaultProviderID = readStr(opts.providerID) ?? PLUGIN_ID
  let lastKnownConfig: Record<string, unknown> = {}

  const persistV1Auth = async (id: string, apiKey: string, metadata: Record<string, string>) => {
    writeV1AuthEntry(id, { type: "api", key: apiKey, metadata })
    await input.client?.auth?.set?.({
      path: { id },
      body: { type: "api", key: apiKey, metadata },
    }).catch(() => {})
  }

  return {
    async config(cfg) {
      lastKnownConfig = cfg
      const providers = asRecord(cfg.provider)
      const disabled = new Set(Array.isArray(cfg.disabled_providers) ? cfg.disabled_providers.map(String) : [])
      const authStore = readV1AuthStore()
      const defaultHeaders = withAppHeader(readHeaders(opts.headers))

      const defaultConn = await resolveAuthConnection(
        defaultProviderID,
        authStore[defaultProviderID] ?? authStore[PLUGIN_ID],
        defaultHeaders,
        (key, meta) => persistV1Auth(defaultProviderID, key, meta),
      )

      let activeUserInfo: GatewayUserInfo | undefined
      const matchedIds = new Set<string>()

      for (const [id, rawProvider] of Object.entries(providers)) {
        if (disabled.has(id)) continue
        const p = asRecord(rawProvider)
        if (!isTargetProviderV1(id, p, opts)) continue
        matchedIds.add(id)

        const pOpts = asRecord(p.options)
        const pSettings = asRecord(p.settings)
        const headers = withAppHeader({ ...defaultHeaders, ...readHeaders(pOpts.headers) })

        const directConn =
          id !== defaultProviderID && authStore[id]
            ? await resolveAuthConnection(id, authStore[id], headers, (key, meta) => persistV1Auth(id, key, meta))
            : undefined
        const connMatch =
          directConn ?? (defaultConn && (!defaultConn.providerID || defaultConn.providerID === id) ? defaultConn : undefined)

        const baseURL =
          readStr(pOpts.baseURL) ??
          readStr(pSettings.baseURL) ??
          readStr(p.api) ??
          connMatch?.baseURL ??
          readStr(opts.baseURL)
        if (!baseURL) continue

        const apiKey =
          readStr(pOpts.apiKey) ??
          readStr(pSettings.apiKey) ??
          connMatch?.apiKey ??
          readStr(opts.apiKey) ??
          readStr(process.env.LITELLM_API_KEY)

        try {
          const [discovered, userInfo] = await Promise.all([
            fetchDiscoveredModels(baseURL, apiKey, headers),
            fetchGatewayUserInfo(baseURL, apiKey, headers),
          ])
          if (!activeUserInfo && userInfo) activeUserInfo = userInfo

          const existingModels = asRecord(p.models)
          const mergedModels: Record<string, unknown> = {}
          for (const m of discovered) {
            mergedModels[m.id] = toV1ModelConfig(m)
          }
          for (const [mid, mval] of Object.entries(existingModels)) {
            mergedModels[mid] = mval
          }

          const currentName = readStr(p.name)
          const hasCustomName = Boolean(currentName && currentName !== id && currentName !== DEFAULT_PROVIDER_NAME)
          providers[id] = {
            ...p,
            npm: readStr(p.npm) ?? "@ai-sdk/openai-compatible",
            name: hasCustomName ? currentName : (userInfo?.gatewayName ?? DEFAULT_PROVIDER_NAME),
            options: {
              ...pOpts,
              baseURL: v1URL(baseURL),
              ...(apiKey ? { apiKey } : {}),
              headers,
            },
            models: mergedModels,
          }
        } catch (err) {
          console.warn(
            `[${PLUGIN_ID}] Model discovery failed for "${id}": ${err instanceof Error ? err.message : String(err)}`,
          )
        }
      }

      const fallbackID = defaultConn?.providerID ?? defaultProviderID
      const fallbackURL = defaultConn?.baseURL ?? readStr(opts.baseURL) ?? readStr(process.env.LITELLM_BASE_URL)
      if (fallbackURL && !matchedIds.has(fallbackID) && !disabled.has(fallbackID)) {
        const apiKey = defaultConn?.apiKey ?? readStr(opts.apiKey) ?? readStr(process.env.LITELLM_API_KEY)
        try {
          const [discovered, userInfo] = await Promise.all([
            fetchDiscoveredModels(fallbackURL, apiKey, defaultHeaders),
            fetchGatewayUserInfo(fallbackURL, apiKey, defaultHeaders),
          ])
          if (!activeUserInfo && userInfo) activeUserInfo = userInfo

          const models: Record<string, unknown> = {}
          for (const m of discovered) {
            models[m.id] = toV1ModelConfig(m)
          }
          providers[fallbackID] = {
            npm: "@ai-sdk/openai-compatible",
            name: userInfo?.gatewayName ?? DEFAULT_PROVIDER_NAME,
            options: {
              baseURL: v1URL(fallbackURL),
              ...(apiKey ? { apiKey } : {}),
              headers: defaultHeaders,
            },
            models,
          }
        } catch (err) {
          console.warn(
            `[${PLUGIN_ID}] Model discovery failed for "${fallbackID}": ${err instanceof Error ? err.message : String(err)}`,
          )
        }
      }

      cfg.provider = providers
      saveGatewayStatus(activeUserInfo)
    },
    auth: {
      provider: defaultProviderID,
      async loader(getAuth, provider) {
        const pOpts = asRecord(provider.options)
        const headers = withAppHeader({ ...readHeaders(opts.headers), ...readHeaders(pOpts.headers) })
        const raw = await getAuth()
        const conn = await resolveAuthConnection(defaultProviderID, raw, headers, (key, meta) =>
          persistV1Auth(defaultProviderID, key, meta),
        )
        const baseURL = readStr(pOpts.baseURL) ?? conn?.baseURL ?? readStr(opts.baseURL)
        return {
          ...(conn?.apiKey ? { apiKey: conn.apiKey } : {}),
          ...(baseURL ? { baseURL: v1URL(baseURL) } : {}),
          headers,
        }
      },
      methods: [
        {
          type: "oauth",
          label: "LiteLLM CLI Code Flow (Browser)",
          prompts: [
            {
              type: "text",
              key: "baseURL",
              message: "LiteLLM proxy URL (leave empty to use configured provider URL or LITELLM_BASE_URL)",
              placeholder: "https://llm.example.com",
            },
            {
              type: "text",
              key: "providerID",
              message: "Provider ID",
              placeholder: defaultProviderID,
            },
            {
              type: "text",
              key: "team",
              message: "Team (optional)",
            },
          ],
          async authorize(inputs) {
            const providerID = readStr(inputs?.providerID) ?? defaultProviderID
            const providers = asRecord(lastKnownConfig.provider)
            const target = asRecord(providers[providerID])
            const targetOpts = asRecord(target.options)
            const targetSettings = asRecord(target.settings)
            const baseURL =
              readStr(inputs?.baseURL) ??
              readStr(targetOpts.baseURL) ??
              readStr(targetSettings.baseURL) ??
              readStr(target.api) ??
              readStr(opts.baseURL) ??
              readStr(process.env.LITELLM_BASE_URL)
            if (!baseURL) {
              throw new Error("Enter a Base URL or configure provider.<id>.options.baseURL")
            }
            const headers = withAppHeader({ ...readHeaders(opts.headers), ...readHeaders(targetOpts.headers) })
            const session = await startLiteLLMInteractive(baseURL, {
              providerID,
              team: readStr(inputs?.team),
              headers,
              clientName: "opencode",
            })
            if (session.mode === "auto") {
              return {
                url: session.url,
                instructions: session.instructions,
                method: "auto",
                callback: async () => {
                  const tok = await session.waitForToken()
                  return {
                    type: "success",
                    key: tok.access,
                    metadata: toStringRecord({
                      ...tok.metadata,
                      refresh: tok.refresh,
                      expires: tok.expires,
                    }),
                  }
                },
              }
            }
            return {
              url: session.url,
              instructions: session.instructions,
              method: "code",
              callback: async (code) => {
                const tok = await session.exchangeCode(code)
                return {
                  type: "success",
                  key: tok.access,
                  metadata: toStringRecord({
                    ...tok.metadata,
                    refresh: tok.refresh,
                    expires: tok.expires,
                  }),
                }
              },
            }
          },
        },
        {
          type: "api",
          label: "API Key",
          prompts: [
            {
              type: "text",
              key: "baseURL",
              message: "OpenAI-compatible Base URL (e.g. https://llm.example.com/v1)",
              placeholder: "https://llm.example.com/v1",
            },
            {
              type: "text",
              key: "providerID",
              message: "Provider ID",
              placeholder: defaultProviderID,
            },
          ],
          async authorize(inputs) {
            const providerID = readStr(inputs?.providerID) ?? defaultProviderID
            const baseURL = readStr(inputs?.baseURL) ?? readStr(opts.baseURL)
            return {
              type: "success",
              key: "",
              provider: providerID,
              metadata: toStringRecord({
                ...(baseURL ? { baseURL } : {}),
                providerID,
              }),
            }
          },
        },
      ],
    },
  }
}
