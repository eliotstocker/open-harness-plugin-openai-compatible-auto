import {
  isModelType,
  type ApiKeyAuth,
  type Credential,
  type Model,
  type OAuthAuth,
  type OAuthCredential,
  type Provider,
  type RefreshModelsContext,
  type ThinkingLevelMap,
} from "@earendil-works/pi-ai"
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy"
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent"
import { refreshLiteLLMTokens, runLiteLLMLogin } from "./core/auth.js"
import {
  fetchDiscoveredModels,
  fetchGatewayUserInfo,
  rootURL,
  v1URL,
  type DiscoveredModel,
  type GatewayUserInfo,
} from "./core/discovery.js"

const PROVIDER_ID = "openai-auto"
const PROVIDER_NAME = "OpenAI-Compatible (Auto)"
const DEFAULT_CONTEXT_WINDOW = 128_000
const DEFAULT_MAX_TOKENS = 16_384
const APP_HEADERS = { "X-Prov-Application": "pi" }

function asRecord(v: unknown): Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : {}
}

function readStr(v: unknown): string | undefined {
  return typeof v === "string" && v.trim().length > 0 ? v.trim() : undefined
}

function oauthBaseURL(cred: OAuthCredential): string | undefined {
  const rec = asRecord(cred)
  const meta = asRecord(rec.metadata)
  return (
    readStr(rec.baseURL) ??
    readStr(meta.baseURL) ??
    readStr(process.env.OPENAI_AUTO_BASE_URL) ??
    readStr(process.env.LITELLM_BASE_URL)
  )
}

function buildThinkingLevelMap(efforts?: string[]): ThinkingLevelMap | undefined {
  if (!efforts || efforts.length === 0) return undefined
  const set = new Set(efforts.map((e) => e.toLowerCase()))
  const map: ThinkingLevelMap = {}
  const pick = (preferred: string[]): string | null => preferred.find((p) => set.has(p)) ?? null
  map.minimal = pick(["minimal", "low"])
  map.low = pick(["low", "minimal", "medium", "high"])
  map.medium = pick(["medium", "high", "low"])
  map.high = pick(["high", "medium"])
  map.xhigh = pick(["max", "xhigh", "high"])
  return map
}

function toPiModel(m: DiscoveredModel, baseUrl: string): Model<"openai-completions"> {
  const reasoning = m.reasoning ?? false
  const thinkingLevelMap = reasoning ? buildThinkingLevelMap(m.reasoningEfforts) : undefined
  const supportsEffort = Boolean(m.reasoningEfforts && m.reasoningEfforts.length > 0)
  return {
    id: m.id,
    name: m.name,
    api: "openai-completions",
    provider: PROVIDER_ID,
    baseUrl: v1URL(baseUrl),
    reasoning,
    ...(thinkingLevelMap ? { thinkingLevelMap } : {}),
    input: m.supportsVision ? ["text", "image"] : ["text"],
    cost: m.cost ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: m.contextWindow ?? DEFAULT_CONTEXT_WINDOW,
    maxTokens: m.maxTokens ?? DEFAULT_MAX_TOKENS,
    compat: {
      supportsStore: false,
      supportsUsageInStreaming: true,
      supportsReasoningEffort: reasoning && supportsEffort,
    },
  }
}

async function resolveFromCredential(
  credential: Credential | undefined,
  fallbackBaseUrl?: string,
): Promise<{ baseUrl?: string; apiKey?: string }> {
  if (credential?.type === "oauth") {
    const base = oauthBaseURL(credential) ?? fallbackBaseUrl
    return { baseUrl: base ? v1URL(base) : undefined, apiKey: credential.access }
  }
  if (credential?.type === "api_key") {
    const base =
      readStr(credential.env?.OPENAI_AUTO_BASE_URL) ??
      readStr(credential.env?.LITELLM_BASE_URL) ??
      fallbackBaseUrl ??
      readStr(process.env.OPENAI_AUTO_BASE_URL) ??
      readStr(process.env.LITELLM_BASE_URL)
    const apiKey =
      readStr(credential.key) ??
      readStr(process.env.OPENAI_AUTO_API_KEY) ??
      readStr(process.env.LITELLM_API_KEY)
    return { baseUrl: base ? v1URL(base) : undefined, apiKey }
  }
  const base =
    fallbackBaseUrl ??
    readStr(process.env.OPENAI_AUTO_BASE_URL) ??
    readStr(process.env.LITELLM_BASE_URL)
  const apiKey = readStr(process.env.OPENAI_AUTO_API_KEY) ?? readStr(process.env.LITELLM_API_KEY)
  return { baseUrl: base ? v1URL(base) : undefined, apiKey }
}

export function createOpenAIAutoPiProvider(): {
  provider: Provider<"openai-completions">
  getUserInfo: () => GatewayUserInfo | undefined
} {
  let models: Model<"openai-completions">[] = []
  let lastUserInfo: GatewayUserInfo | undefined
  const completionsApi = () => openAICompletionsApi()

  const oauth: OAuthAuth = {
    name: "LiteLLM CLI Code Flow (Browser)",
    loginLabel: "LiteLLM CLI Code Flow (Browser)",
    login: async (interaction) => {
      const placeholder =
        readStr(process.env.OPENAI_AUTO_BASE_URL) ??
        readStr(process.env.LITELLM_BASE_URL) ??
        "https://llm.example.com"
      const enteredUrl = await interaction.prompt({
        type: "text",
        message: "LiteLLM proxy URL",
        placeholder,
      })
      const baseURL =
        readStr(enteredUrl) ??
        readStr(process.env.OPENAI_AUTO_BASE_URL) ??
        readStr(process.env.LITELLM_BASE_URL)
      if (!baseURL) {
        throw new Error("Base URL is required")
      }
      const team = readStr(
        await interaction.prompt({
          type: "text",
          message: "Team (optional)",
          placeholder: "Leave blank if not required",
        }),
      )

      const tok = await runLiteLLMLogin(
        baseURL,
        { providerID: PROVIDER_ID, team, headers: APP_HEADERS, clientName: "pi" },
        {
          signal: interaction.signal,
          onAuth: (url, instructions) => {
            interaction.notify({ type: "auth_url", url, instructions })
          },
          onPrompt: (message, p) =>
            interaction.prompt({ type: "manual_code", message, placeholder: p }),
        },
      )

      lastUserInfo = await fetchGatewayUserInfo(baseURL, tok.access, APP_HEADERS, interaction.signal)

      return {
        type: "oauth",
        access: tok.access,
        refresh: tok.refresh,
        expires: tok.expires,
        baseURL: rootURL(baseURL),
        metadata: { ...tok.metadata, ...(lastUserInfo?.email ? { userEmail: lastUserInfo.email } : {}) },
      }
    },
    refresh: async (credential, signal) => {
      const tok = await refreshLiteLLMTokens(
        {
          access: credential.access,
          refresh: credential.refresh,
          expires: credential.expires,
          metadata: asRecord(credential.metadata),
        },
        APP_HEADERS,
        signal,
      )
      return {
        ...credential,
        ...tok,
        type: "oauth",
      }
    },
    toAuth: async (credential) => {
      const baseURL = oauthBaseURL(credential)
      return {
        apiKey: credential.access,
        headers: APP_HEADERS,
        ...(baseURL ? { baseUrl: v1URL(baseURL) } : {}),
      }
    },
  }

  const apiKey: ApiKeyAuth = {
    name: "OpenAI-Compatible API Key",
    login: async (interaction) => {
      const placeholder =
        readStr(process.env.OPENAI_AUTO_BASE_URL) ??
        readStr(process.env.LITELLM_BASE_URL) ??
        "https://llm.example.com/v1"
      const enteredUrl = await interaction.prompt({
        type: "text",
        message: "OpenAI-compatible Base URL",
        placeholder,
      })
      const baseURL =
        readStr(enteredUrl) ??
        readStr(process.env.OPENAI_AUTO_BASE_URL) ??
        readStr(process.env.LITELLM_BASE_URL)
      if (!baseURL) {
        throw new Error("Base URL is required")
      }
      const enteredKey = await interaction.prompt({
        type: "secret",
        message: "API key (optional for local endpoints)",
        placeholder: "sk-...",
      })
      const key = readStr(enteredKey)
      await fetchDiscoveredModels(baseURL, key, APP_HEADERS, interaction.signal)
      lastUserInfo = await fetchGatewayUserInfo(baseURL, key, APP_HEADERS, interaction.signal)
      return {
        type: "api_key",
        ...(key ? { key } : {}),
        env: { OPENAI_AUTO_BASE_URL: v1URL(baseURL) },
      }
    },
    check: async ({ ctx, credential }) => {
      const base =
        readStr(credential?.env?.OPENAI_AUTO_BASE_URL) ??
        readStr(await ctx.env("OPENAI_AUTO_BASE_URL")) ??
        readStr(await ctx.env("LITELLM_BASE_URL"))
      return base ? { type: "api_key", source: credential ? "stored credential" : "env" } : undefined
    },
    resolve: async ({ ctx, credential }) => {
      const base =
        readStr(credential?.env?.OPENAI_AUTO_BASE_URL) ??
        readStr(await ctx.env("OPENAI_AUTO_BASE_URL")) ??
        readStr(await ctx.env("LITELLM_BASE_URL"))
      if (!base) return undefined
      const resolvedKey =
        readStr(credential?.key) ??
        readStr(await ctx.env("OPENAI_AUTO_API_KEY")) ??
        readStr(await ctx.env("LITELLM_API_KEY")) ??
        "local"
      return {
        auth: { apiKey: resolvedKey, baseUrl: v1URL(base), headers: APP_HEADERS },
        env: { ...credential?.env, OPENAI_AUTO_BASE_URL: v1URL(base) },
        source: credential ? "stored credential" : "env",
      }
    },
  }

  const provider: Provider<"openai-completions"> = {
    id: PROVIDER_ID,
    name: PROVIDER_NAME,
    baseUrl: v1URL(
      readStr(process.env.OPENAI_AUTO_BASE_URL) ??
        readStr(process.env.LITELLM_BASE_URL) ??
        "http://localhost:4000",
    ),
    headers: APP_HEADERS,
    auth: { oauth, apiKey },
    getModels: () => models,
    refreshModels: async (context: RefreshModelsContext) => {
      if (context.stored) {
        const restored = context.stored.models.filter(
          (m): m is Model<"openai-completions"> =>
            m.provider === PROVIDER_ID && isModelType(m, "chat") && m.api === "openai-completions",
        )
        if (!(await context.publish({ update: () => { models = restored } }))) {
          return
        }
      }

      if (!context.allowNetwork || context.signal.aborted) return

      const { baseUrl, apiKey: resolvedKey } = await resolveFromCredential(context.credential, context.baseUrl)
      if (!baseUrl) return

      const [discovered, userInfo] = await Promise.all([
        fetchDiscoveredModels(baseUrl, resolvedKey, APP_HEADERS, context.signal),
        fetchGatewayUserInfo(baseUrl, resolvedKey, APP_HEADERS, context.signal),
      ])
      if (context.signal.aborted) return

      lastUserInfo = userInfo
      const refreshed = discovered.map((m) => toPiModel(m, baseUrl))
      await context.publish({
        persist: { models: refreshed, checkedAt: Date.now() },
        update: () => {
          models = refreshed
        },
      })
    },
    stream: (model, context, options) => completionsApi().stream(model, context, options),
    streamSimple: (model, context, options) => completionsApi().streamSimple(model, context, options),
  }

  return { provider, getUserInfo: () => lastUserInfo }
}

function formatStatus(info: GatewayUserInfo | undefined): string | undefined {
  if (!info?.email) return undefined
  if (info.effectiveSpendUsd !== undefined && info.monthlyCapUsd !== undefined) {
    return `${info.email} ($${info.effectiveSpendUsd.toFixed(2)}/$${info.monthlyCapUsd.toFixed(0)})`
  }
  return info.email
}

export default function openaiAutoPiExtension(pi: ExtensionAPI): void {
  const { provider, getUserInfo } = createOpenAIAutoPiProvider()
  pi.registerProvider(provider)

  const syncStatus = async (ctx: ExtensionContext) => {
    if (!ctx.hasUI) return
    if (ctx.model?.provider !== PROVIDER_ID) {
      ctx.ui.setStatus(PROVIDER_ID, undefined)
      return
    }
    let info = getUserInfo()
    if (!info) {
      const auth = await ctx.modelRegistry.getProviderAuth(PROVIDER_ID).catch(() => undefined)
      if (auth?.auth.baseUrl && auth.auth.apiKey) {
        info = await fetchGatewayUserInfo(auth.auth.baseUrl, auth.auth.apiKey, APP_HEADERS)
      }
    }
    ctx.ui.setStatus(PROVIDER_ID, formatStatus(info))
  }

  pi.on("session_start", (_event, ctx) => void syncStatus(ctx))
  pi.on("model_select", (_event, ctx) => void syncStatus(ctx))
}
