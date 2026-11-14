import { Integration, Model, Plugin, Provider, type Credential } from "@opencode/plugin"
import type { Context } from "@opencode/plugin/promise/plugin"
import type { IntegrationOAuthAuthorization } from "@opencode/plugin/promise/integration"
import { refreshLiteLLMTokens, startLiteLLMInteractive, type LiteLLMTokens } from "./core/auth.js"
import {
  fetchDiscoveredModels,
  fetchGatewayUserInfo,
  rootURL,
  v1URL,
  type GatewayUserInfo,
} from "./core/discovery.js"

const PLUGIN_ID = "openai-auto"
const INTEGRATION_ID = "openai-auto"
const LITELLM_METHOD_ID = "litellm-cli"
const OPENAI_COMPAT_PKG = "@opencode/ai/providers/openai-compatible"
const REFRESH_TTL_MS = 5 * 60 * 1000
const ALLOWED_INPUTS = new Set(["text", "image", "audio", "video", "pdf"])

const COMPATIBLE_PACKAGES = new Set([
  OPENAI_COMPAT_PKG,
  "@opencode/ai/providers/openai-compatible/responses",
  "@ai-sdk/openai-compatible",
])

interface SourceState {
  id: string
  name: string
  baseURL: string
  apiKey?: string
  headers: Record<string, string>
  pkg: string
  fromConfig: boolean
  usesConnection: boolean
  models: Model.Info[]
  userInfo?: GatewayUserInfo
  ownedIds: Set<string>
  lastFetchedAt: number
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

function formatUserBadge(baseName: string, user?: GatewayUserInfo): string {
  if (!user?.email) return baseName
  const spend =
    user.effectiveSpendUsd !== undefined && user.monthlyCapUsd !== undefined
      ? ` · $${user.effectiveSpendUsd.toFixed(2)}/$${user.monthlyCapUsd.toFixed(0)}`
      : ""
  return `${baseName} (${user.email}${spend})`
}

function toOAuth(methodID: string, token: LiteLLMTokens): Credential.OAuth {
  return {
    type: "oauth",
    methodID: Integration.MethodID.make(methodID),
    access: token.access,
    refresh: token.refresh,
    expires: token.expires,
    metadata: token.metadata,
  }
}

async function authorizeOpenCode(
  baseURL: string,
  methodID: string,
  meta: { providerID: string; team?: string; headers?: Record<string, string> },
): Promise<IntegrationOAuthAuthorization> {
  const session = await startLiteLLMInteractive(baseURL, { ...meta, clientName: "opencode" })
  if (session.mode === "auto") {
    const callback = session.waitForToken().then((tok) => toOAuth(methodID, tok))
    callback.catch(() => {})
    return {
      mode: "auto",
      url: session.url,
      instructions: session.instructions,
      expiresAt: session.expiresAt,
      callback,
    }
  }
  return {
    mode: "code",
    url: session.url,
    instructions: session.instructions,
    callback: async (code) => toOAuth(methodID, await session.exchangeCode(code)),
  }
}

async function discoverOpenCodeModels(
  providerID: string,
  baseURL: string,
  apiKey?: string,
  extraHeaders?: Record<string, string>,
): Promise<{ models: Model.Info[]; userInfo?: GatewayUserInfo }> {
  const [discovered, userInfo] = await Promise.all([
    fetchDiscoveredModels(baseURL, apiKey, extraHeaders),
    fetchGatewayUserInfo(baseURL, apiKey, extraHeaders),
  ])
  const pid = Provider.ID.make(providerID)
  const models: Model.Info[] = discovered.map((m) => {
    const defaults = Model.Info.default(pid, Model.ID.make(m.id))
    const input = (m.inputModalities ?? ["text"]).filter((x) => ALLOWED_INPUTS.has(x))
    const variants =
      m.reasoningEfforts?.map((effort) => ({
        id: Model.VariantID.make(effort),
        body: { reasoning_effort: effort },
      })) ?? []

    return {
      ...defaults,
      name: m.name,
      limit: {
        context: m.contextWindow ?? defaults.limit.context,
        output: m.maxTokens ?? defaults.limit.output,
      },
      capabilities: {
        ...defaults.capabilities,
        tools: m.supportsTools ?? defaults.capabilities.tools,
        input: input.length > 0 ? input : defaults.capabilities.input,
      },
      ...(m.cost
        ? {
            cost: [
              {
                input: m.cost.input as never,
                output: m.cost.output as never,
                cache: {
                  read: m.cost.cacheRead as never,
                  write: m.cost.cacheWrite as never,
                },
              },
            ],
          }
        : {}),
      ...(m.reasoning
        ? {
            compatibility: {
              reasoningField: "reasoning_content" as const,
              ...(m.reasoningEfforts?.length ? { supportsEffortUpdates: true } : {}),
            },
          }
        : {}),
      ...(variants.length > 0 ? { variants } : {}),
    }
  })
  return { models, userInfo }
}

function credentialKey(cred: Credential.Value | undefined): string | undefined {
  if (cred?.type === "key") return cred.key
  if (cred?.type === "oauth" && cred.methodID === LITELLM_METHOD_ID) return cred.access
  return undefined
}

async function readConnection(ctx: Context, integrationID = INTEGRATION_ID) {
  try {
    const active = await ctx.integration.connection.active(integrationID)
    if (!active) return undefined
    const cred = await ctx.integration.connection.resolve(active)
    const apiKey = credentialKey(cred)
    if (!cred || !apiKey) return undefined
    const answers = asRecord(cred.metadata)
    return {
      apiKey,
      baseURL: readStr(answers.baseURL),
      providerID: readStr(answers.providerID),
    }
  } catch {
    return undefined
  }
}

function isTargetProvider(
  p: { id: string; package: string; settings?: Record<string, unknown> },
  options: Record<string, unknown>,
): boolean {
  const settings = asRecord(p.settings)
  if (settings.autoModels === false) return false
  if (p.id === readStr(options.providerID) || p.id === PLUGIN_ID) return true
  return COMPATIBLE_PACKAGES.has(p.package) && typeof settings.baseURL === "string"
}

export default Plugin.define({
  id: PLUGIN_ID,
  async setup(ctx) {
    if (!ctx.provider) return

    const opts = asRecord(ctx.options)
    const sources = new Map<string, SourceState>()

    await ctx.integration.transform((editor) => {
      editor.update(INTEGRATION_ID, (i) => {
        i.name = "OpenAI-Compatible (Auto)"
      })
      editor.method.update({
        integrationID: INTEGRATION_ID,
        method: {
          type: "key",
          label: "API Key",
          form: [
            {
              key: "baseURL",
              type: "string",
              format: "uri",
              title: "Base URL",
              description: "OpenAI-compatible endpoint URL (e.g. https://llm.example.com/v1)",
              placeholder: "https://llm.example.com/v1",
            },
            {
              key: "providerID",
              type: "string",
              title: "Provider ID",
              default: PLUGIN_ID,
            },
          ],
        },
      })
      editor.method.update({
        integrationID: INTEGRATION_ID,
        method: {
          id: LITELLM_METHOD_ID,
          type: "oauth",
          label: "LiteLLM CLI Code Flow (Browser)",
          form: [
            {
              key: "baseURL",
              type: "string",
              format: "uri",
              title: "Base URL",
              description: "LiteLLM proxy URL (leave empty to use configured provider URL or LITELLM_BASE_URL)",
              placeholder: "https://llm.example.com",
            },
            {
              key: "providerID",
              type: "string",
              title: "Provider ID",
              default: PLUGIN_ID,
            },
            {
              key: "team",
              type: "string",
              title: "Team (optional)",
            },
          ],
        },
        authorize: async (answer) => {
          const providerID = readStr(answer.providerID) ?? readStr(opts.providerID) ?? PLUGIN_ID
          const providers = (await ctx.provider.list()).data
          const target = providers.find((p) => p.id === providerID)
          const targetSettings = asRecord(target?.settings)
          const baseURL =
            readStr(answer.baseURL) ??
            readStr(targetSettings.baseURL) ??
            readStr(opts.baseURL) ??
            readStr(process.env.LITELLM_BASE_URL)
          if (!baseURL) {
            throw new Error("Enter a Base URL or configure providers.<id>.settings.baseURL")
          }
          const headers = withAppHeader({ ...readHeaders(opts.headers), ...readHeaders(target?.headers) })
          return authorizeOpenCode(baseURL, LITELLM_METHOD_ID, {
            providerID,
            team: readStr(answer.team),
            headers,
          })
        },
        refresh: async (cred) => {
          const tok = await refreshLiteLLMTokens(cred, withAppHeader(readHeaders(opts.headers)))
          return { ...cred, ...tok }
        },
      })
    })

    const syncSources = async (force = false): Promise<boolean> => {
      let changed = false
      const conn = await readConnection(ctx)
      const list = (await ctx.provider.list().catch(() => ({ data: [] }))).data
      const candidates = list.filter((p) => isTargetProvider(p, opts))

      for (const p of candidates) {
        const settings = asRecord(p.settings)
        const connMatch = conn && (!conn.providerID || conn.providerID === p.id) ? conn : undefined
        const baseURL = readStr(settings.baseURL) ?? connMatch?.baseURL ?? readStr(opts.baseURL)
        if (!baseURL) continue
        const apiKey = readStr(settings.apiKey) ?? connMatch?.apiKey ?? readStr(opts.apiKey)
        const headers = withAppHeader({ ...readHeaders(opts.headers), ...readHeaders(p.headers) })
        const existing = sources.get(p.id)
        if (!force && existing && Date.now() - existing.lastFetchedAt < REFRESH_TTL_MS && existing.baseURL === rootURL(baseURL) && existing.apiKey === apiKey) {
          continue
        }
        try {
          const { models, userInfo } = await discoverOpenCodeModels(p.id, baseURL, apiKey, headers)
          sources.set(p.id, {
            id: p.id,
            name: p.name || p.id,
            baseURL: rootURL(baseURL),
            apiKey,
            headers,
            pkg: p.package || OPENAI_COMPAT_PKG,
            fromConfig: true,
            usesConnection: !readStr(settings.apiKey) && Boolean(connMatch?.apiKey),
            models,
            userInfo,
            ownedIds: existing?.ownedIds ?? new Set(),
            lastFetchedAt: Date.now(),
          })
          changed = true
        } catch (err) {
          console.warn(`[${PLUGIN_ID}] Model discovery failed for "${p.id}": ${err instanceof Error ? err.message : String(err)}`)
        }
      }

      const fallbackURL = conn?.baseURL ?? readStr(opts.baseURL) ?? readStr(process.env.LITELLM_BASE_URL)
      const fallbackID = conn?.providerID ?? readStr(opts.providerID) ?? PLUGIN_ID
      if (fallbackURL && !candidates.some((p) => p.id === fallbackID)) {
        const apiKey = conn?.apiKey ?? readStr(opts.apiKey) ?? readStr(process.env.LITELLM_API_KEY)
        const headers = withAppHeader(readHeaders(opts.headers))
        const existing = sources.get(fallbackID)
        if (force || !existing || Date.now() - existing.lastFetchedAt >= REFRESH_TTL_MS || existing.apiKey !== apiKey || existing.baseURL !== rootURL(fallbackURL)) {
          try {
            const { models, userInfo } = await discoverOpenCodeModels(fallbackID, fallbackURL, apiKey, headers)
            sources.set(fallbackID, {
              id: fallbackID,
              name: formatUserBadge("OpenAI-Compatible (Auto)", userInfo),
              baseURL: rootURL(fallbackURL),
              apiKey,
              headers,
              pkg: OPENAI_COMPAT_PKG,
              fromConfig: false,
              usesConnection: Boolean(conn?.apiKey),
              models,
              userInfo,
              ownedIds: existing?.ownedIds ?? new Set(),
              lastFetchedAt: Date.now(),
            })
            changed = true
          } catch (err) {
            console.warn(`[${PLUGIN_ID}] Model discovery failed for "${fallbackID}": ${err instanceof Error ? err.message : String(err)}`)
          }
        }
      }

      return changed
    }

    await syncSources(true)

    await ctx.provider.transform((editor) => {
      for (const src of sources.values()) {
        const current = editor.get(src.id)
        if (current) {
          editor.update(src.id, (p) => {
            if (!p.package) p.package = src.pkg
            if (src.usesConnection) p.integrationID = Integration.ID.make(INTEGRATION_ID)
            p.headers = withAppHeader({ ...p.headers, ...src.headers })
            const settings: Record<string, unknown> = { ...(p.settings ?? {}), baseURL: v1URL(src.baseURL) }
            if (src.usesConnection) delete settings.apiKey
            p.settings = settings
          })
          const discoveredIds = new Set<string>(src.models.map((m) => m.id))
          const kept = [...current.models.values()].filter(
            (m) => !src.ownedIds.has(m.id) || discoveredIds.has(m.id),
          )
          const existingIds = new Set<string>(kept.map((m) => m.id))
          const added = src.models.filter((m) => !existingIds.has(m.id))
          src.ownedIds = new Set<string>(
            [...src.ownedIds].filter((id) => discoveredIds.has(id)).concat(added.map((m) => String(m.id))),
          )
          editor.models.set(src.id, [...kept, ...added])
        } else {
          src.ownedIds = new Set(src.models.map((m) => m.id))
          editor.add({
            info: {
              ...Provider.Info.empty(Provider.ID.make(src.id)),
              name: src.name,
              activation: "enabled",
              package: src.pkg,
              settings: {
                baseURL: v1URL(src.baseURL),
                ...(!src.usesConnection && src.apiKey ? { apiKey: src.apiKey } : {}),
              },
              headers: src.headers,
              ...(src.usesConnection ? { integrationID: Integration.ID.make(INTEGRATION_ID) } : {}),
            },
            models: src.models,
          })
        }
      }
    })

    const controller = new AbortController()
    void (async () => {
      for await (const event of ctx.event.subscribe({
        types: ["provider.updated", "credential.switched", "session.created"],
        signal: controller.signal,
      })) {
        // Only force-bypass the TTL cache on credential switches; provider.updated is emitted by our own reload().
        const force = event.type === "credential.switched"
        if (await syncSources(force)) {
          await ctx.provider.reload().catch((err) => {
            console.warn(`[${PLUGIN_ID}] provider.reload failed:`, err)
          })
        }
      }
    })().catch(() => {})

    return () => controller.abort()
  },
})
