import type { Context } from "@deepseek-ai/cordis"
import { brandString } from "@deepseek-ai/dsh-brand"
import { credentialKey } from "@deepseek-ai/dsh-credentials"
import {
  attributionHeaders,
  CONTEXT_WINDOW_EXCEEDED_CODE,
  EMPTY_RESPONSE_CODE,
  isContextWindowExceededError,
  isQuotaExceededError,
  LlmAdapter,
  LlmError,
  QUOTA_EXCEEDED_CODE,
  ReasoningEffortId,
  type FinishReason,
  type GenerateOptions,
  type LlmDiscoveredModel,
  type LlmModelInfo,
  type LlmReasoningEffortInfo,
  type LlmResolvedModelInfo,
  type Message,
  type StreamChunk,
  type TokenUsage,
} from "@deepseek-ai/dsh-llm"
import "@deepseek-ai/dsh-authorization"
import "@deepseek-ai/dsh-settings"
import z from "@deepseek-ai/schemastery"
import {
  isContextOverflow,
  type AssistantMessage,
  type AssistantMessageEvent,
  type Context as PiContext,
  type JsonObject,
  type Model,
  type SimpleStreamOptions,
  type ToolResultMessage,
  type Usage,
} from "@earendil-works/pi-ai"
import * as piAiNs from "@earendil-works/pi-ai"
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy"
import { NEVER_EXPIRES, refreshLiteLLMTokens, runLiteLLMLogin } from "./core/auth.js"
import {
  fetchDiscoveredModels,
  fetchGatewayUserInfo,
  rootURL,
  v1URL,
  type DiscoveredModel,
  type GatewayUserInfo,
} from "./core/discovery.js"

export const name = "openai-auto"
export const inject = ["llm"] as const

const PROVIDER_ID = "openai-auto"
const RECORD_KEY = credentialKey(name, PROVIDER_ID)
const DEFAULT_CONTEXT_WINDOW = 128_000
const DEFAULT_MAX_TOKENS = 16_384
const REFRESH_TTL_MS = 5 * 60 * 1000
const EXPIRY_SKEW_MS = 60_000
const APP_HEADERS = { "X-Prov-Application": "dsh" }

export interface OpenAIAutoDshConfig {
  displayName?: string
  baseURL?: string
  apiKeyEnv?: string
  headers?: Record<string, string>
  defaultContextWindow?: number
  defaultMaxTokens?: number
}

export const Config = z.object({
  displayName: z.string().description("Display name shown in model pickers"),
  baseURL: z.string().description("OpenAI-compatible endpoint URL (optional if signed in via /login)"),
  apiKeyEnv: z.string().description("Credential/environment variable name for API key"),
  headers: z.dict(z.string()).description("Extra HTTP headers sent on requests"),
  defaultContextWindow: z.number().default(DEFAULT_CONTEXT_WINDOW),
  defaultMaxTokens: z.number().default(DEFAULT_MAX_TOKENS),
})

interface StoredGrant {
  access: string
  refresh: string
  expires: number
  baseURL: string
  metadata?: Record<string, unknown>
}

function asRecord(v: unknown): Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : {}
}

function readStr(v: unknown): string | undefined {
  return typeof v === "string" && v.trim().length > 0 ? v.trim() : undefined
}

function parseGrant(v: unknown): StoredGrant | undefined {
  const rec = asRecord(v)
  const access = readStr(rec.access)
  const baseURL = readStr(rec.baseURL)
  if (!access || !baseURL) return undefined
  return {
    access,
    refresh: typeof rec.refresh === "string" ? rec.refresh : "",
    expires: typeof rec.expires === "number" && Number.isFinite(rec.expires) ? rec.expires : NEVER_EXPIRES,
    baseURL: rootURL(baseURL),
    metadata: asRecord(rec.metadata),
  }
}

function zeroUsage(): Usage {
  return {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  }
}

function flattenText(message: Message): string {
  const out: string[] = []
  for (const block of message.content) {
    if (block.type === "text") out.push(block.text)
    else if (block.type === "file") out.push(`[file: ${block.attachment.name}]`)
  }
  return out.join("")
}

function toolResultText(blocks: Message["content"]): string {
  const out: string[] = []
  for (const block of blocks) {
    if (block.type === "text") out.push(block.text)
    else if (block.type === "file") out.push(`[file: ${block.attachment.name}]`)
    else if (block.type === "image") out.push(`[image: ${block.attachment.mediaType}]`)
  }
  return out.join("\n")
}

function parseArgs(raw: string): JsonObject {
  try {
    const parsed = JSON.parse(raw) as unknown
    if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
      return parsed as JsonObject
    }
  } catch {}
  return {}
}

function toPiContext(options: GenerateOptions): PiContext {
  let systemPrompt = options.system
  let rest = options.messages
  if (systemPrompt === undefined && rest[0]?.role === "system") {
    const text = flattenText(rest[0])
    systemPrompt = text.length > 0 ? text : undefined
    rest = rest.slice(1)
  }

  const toolNames = new Map<string, string>()
  const messages: PiContext["messages"] = []

  for (const msg of rest) {
    if (msg.role === "system") {
      messages.push({ role: "user", content: flattenText(msg), timestamp: 0 })
      continue
    }
    if (msg.role === "assistant") {
      const content: AssistantMessage["content"] = []
      for (const block of msg.content) {
        if (block.type === "text") content.push({ type: "text", text: block.text })
        else if (block.type === "reasoning") content.push({ type: "thinking", thinking: block.text })
        else if (block.type === "tool-call") {
          toolNames.set(String(block.id), block.name)
          content.push({
            type: "toolCall",
            id: String(block.id),
            name: block.name,
            arguments: parseArgs(block.arguments),
          })
        }
      }
      messages.push({
        role: "assistant",
        content,
        api: "openai-completions",
        provider: PROVIDER_ID,
        model: options.model,
        usage: zeroUsage(),
        stopReason: content.some((b) => b.type === "toolCall") ? "toolUse" : "stop",
        timestamp: 0,
      })
      continue
    }

    const text = flattenText(msg)
    const results = msg.content.filter((b) => b.type === "tool-result")
    if (text.length > 0 || results.length === 0) {
      messages.push({ role: "user", content: text, timestamp: 0 })
    }
    for (const r of results) {
      const tr: ToolResultMessage = {
        role: "toolResult",
        toolCallId: String(r.toolCallId),
        toolName: toolNames.get(String(r.toolCallId)) ?? "unknown",
        content: [{ type: "text", text: toolResultText(r.content) || "(no output)" }],
        isError: r.isError ?? false,
        timestamp: 0,
      }
      messages.push(tr)
    }
  }

  return {
    ...(systemPrompt !== undefined ? { systemPrompt } : {}),
    messages,
    ...(options.tools && options.tools.length > 0
      ? {
          tools: options.tools.map((t) => ({
            name: t.name,
            description: t.description,
            parameters: t.parameters as never,
          })),
        }
      : {}),
  }
}

function mapUsage(u: Usage): TokenUsage {
  return {
    inputTokens: u.input,
    outputTokens: u.output,
    totalTokens: u.totalTokens,
    ...(u.cacheRead > 0 ? { cacheReadTokens: u.cacheRead } : {}),
    ...(u.cacheWrite > 0 ? { cacheWriteTokens: u.cacheWrite } : {}),
  }
}

function classifyError(message: string): string {
  if (/\b(?:401|403)\b/.test(message)) return "AUTH"
  if (isQuotaExceededError(message)) return QUOTA_EXCEEDED_CODE
  if (/\b429\b|rate.?limit/i.test(message)) return "RATE_LIMIT"
  if (/\b400\b|\b413\b|invalid.?request|payload too large/i.test(message)) return "INVALID_REQUEST"
  if (/\b5\d\d\b/.test(message)) return "SERVER"
  if (/\btime(?:d)?\s*out\b|timeout/i.test(message)) return "TIMEOUT"
  if (/\b(?:network|connection|socket|fetch)\b|\bECONN[A-Z]+\b/i.test(message)) return "TRANSPORT"
  return "OPENAI_AUTO_ERROR"
}

function mapStopReason(msg: AssistantMessage, contextWindow: number): FinishReason {
  if (
    isContextOverflow(msg, contextWindow) ||
    (msg.stopReason === "error" && msg.errorMessage && isContextWindowExceededError(msg.errorMessage))
  ) {
    return {
      kind: "error",
      failure: {
        message: msg.errorMessage ?? `Context window exceeded for "${msg.model}"`,
        code: CONTEXT_WINDOW_EXCEEDED_CODE,
      },
    }
  }
  switch (msg.stopReason) {
    case "stop":
      if (msg.content.length === 0) {
        return {
          kind: "error",
          failure: {
            message: `Model "${msg.model}" returned an empty response`,
            code: EMPTY_RESPONSE_CODE,
          },
        }
      }
      return { kind: "stop" }
    case "length":
      return { kind: "max-tokens" }
    case "toolUse":
      return { kind: "tool-calls" }
    case "aborted":
      return {
        kind: "aborted",
        failure: { message: msg.errorMessage ?? "Stream aborted", code: "ABORTED" },
      }
    default: {
      const text = msg.errorMessage ?? "OpenAI-compatible stream error"
      return { kind: "error", failure: { message: text, code: classifyError(text) } }
    }
  }
}

async function* toStreamChunks(
  events: AsyncIterable<AssistantMessageEvent>,
  contextWindow: number,
  callerSignal?: AbortSignal,
): AsyncIterable<StreamChunk> {
  const toolIds = new Map<number, { id: string; name: string }>()
  for await (const event of events) {
    switch (event.type) {
      case "text_start":
        yield { type: "block-start", index: event.contentIndex, blockType: "text" }
        break
      case "text_delta":
        yield { type: "text-delta", index: event.contentIndex, text: event.delta }
        break
      case "text_end":
        yield { type: "block-end", index: event.contentIndex, block: { type: "text", text: event.content } }
        break
      case "thinking_start":
        yield { type: "block-start", index: event.contentIndex, blockType: "reasoning" }
        break
      case "thinking_delta":
        yield { type: "reasoning-delta", index: event.contentIndex, text: event.delta }
        break
      case "thinking_end":
        yield { type: "block-end", index: event.contentIndex, block: { type: "reasoning", text: event.content } }
        break
      case "toolcall_start": {
        const partial = event.partial.content[event.contentIndex]
        const id = partial?.type === "toolCall" ? partial.id : ""
        const toolName = partial?.type === "toolCall" ? partial.name : ""
        toolIds.set(event.contentIndex, { id, name: toolName })
        yield { type: "block-start", index: event.contentIndex, blockType: "tool-call" }
        break
      }
      case "toolcall_delta": {
        const known = toolIds.get(event.contentIndex)
        yield {
          type: "tool-call-delta",
          index: event.contentIndex,
          id: brandString(known?.id ?? "") as unknown as import("@deepseek-ai/dsh-llm").ToolCallId,
          ...(known?.name ? { name: known.name } : {}),
          argumentsDelta: event.delta,
        }
        break
      }
      case "toolcall_end":
        yield {
          type: "block-end",
          index: event.contentIndex,
          block: {
            type: "tool-call",
            id: brandString(event.toolCall.id) as unknown as import("@deepseek-ai/dsh-llm").ToolCallId,
            name: event.toolCall.name,
            arguments: JSON.stringify(event.toolCall.arguments),
          },
        }
        break
      case "done":
        yield { type: "usage", usage: mapUsage(event.message.usage) }
        yield { type: "finish", reason: mapStopReason(event.message, contextWindow) }
        return
      case "error":
        yield { type: "usage", usage: mapUsage(event.error.usage) }
        yield {
          type: "finish",
          reason: mapStopReason(
            callerSignal?.aborted ? { ...event.error, stopReason: "aborted" } : event.error,
            contextWindow,
          ),
        }
        return
    }
  }
  throw new LlmError("OpenAI-compatible stream ended without terminal event", "STREAM_CLOSED")
}

function mapReasoningEfforts(efforts?: string[]): LlmReasoningEffortInfo[] {
  if (!efforts || efforts.length === 0) return []
  return efforts.map((id) => ({
    id: ReasoningEffortId(id),
    name: id.charAt(0).toUpperCase() + id.slice(1),
  }))
}

function toPiReasoning(effort?: string): SimpleStreamOptions["reasoning"] | undefined {
  if (!effort) return undefined
  const lower = effort.toLowerCase()
  if (lower === "minimal" || lower === "low" || lower === "medium" || lower === "high" || lower === "xhigh") {
    return lower
  }
  if (lower === "max") return "xhigh"
  return undefined
}

export function apply(ctx: Context, initialConfig: OpenAIAutoDshConfig = {}): void {
  let getConfig = (): OpenAIAutoDshConfig => initialConfig
  let cachedModels: DiscoveredModel[] = []
  let cachedUser: GatewayUserInfo | undefined
  let cachedAt = 0
  let cachedKey = ""

  const requestHeaders = (extra?: Record<string, string>) => ({
    ...APP_HEADERS,
    ...extra,
    ...attributionHeaders(),
  })

  const resolveEndpointAndAuth = async (signal?: AbortSignal): Promise<{ baseURL: string; apiKey?: string }> => {
    const cfg = getConfig()
    const credentials = ctx.get("credentials")

    if (credentials) {
      const rec = await credentials.readRecord(RECORD_KEY).catch(() => undefined)
      if (rec?.kind === "grant") {
        const grant = parseGrant(rec.payload)
        if (grant) {
          if (Date.now() + EXPIRY_SKEW_MS >= grant.expires) {
            const refreshed = await credentials.modifyRecord(RECORD_KEY, async (current) => {
              if (current?.kind !== "grant") return current
              const cur = parseGrant(current.payload)
              if (!cur) return current
              if (Date.now() + EXPIRY_SKEW_MS < cur.expires) return current
              const tok = await refreshLiteLLMTokens(cur, requestHeaders(cfg.headers), signal)
              return { kind: "grant", payload: { ...cur, ...tok } }
            })
            const updated = refreshed?.kind === "grant" ? parseGrant(refreshed.payload) : undefined
            if (updated) return { baseURL: updated.baseURL, apiKey: updated.access }
          }
          return { baseURL: grant.baseURL, apiKey: grant.access }
        }
      }
    }

    const baseURL = readStr(cfg.baseURL) ?? readStr(process.env.OPENAI_AUTO_BASE_URL) ?? readStr(process.env.LITELLM_BASE_URL)
    if (!baseURL) {
      throw new LlmError(
        "openai-auto is not configured. Run /login openai-auto or set baseURL in settings.",
        "MISSING_CREDENTIAL",
      )
    }

    let apiKey: string | undefined
    const envRef = readStr(cfg.apiKeyEnv)
    if (envRef && credentials) {
      apiKey = (await credentials.resolve(envRef as never).catch(() => undefined))?.value
    } else if (envRef) {
      apiKey = readStr(process.env[envRef])
    } else {
      apiKey = readStr(process.env.OPENAI_AUTO_API_KEY) ?? readStr(process.env.LITELLM_API_KEY)
    }
    return { baseURL: rootURL(baseURL), apiKey }
  }

  const refreshModels = async (force = false, signal?: AbortSignal): Promise<DiscoveredModel[]> => {
    let auth: { baseURL: string; apiKey?: string }
    try {
      auth = await resolveEndpointAndAuth(signal)
    } catch {
      return cachedModels
    }
    const cacheKey = `${auth.baseURL}:${auth.apiKey ?? ""}`
    if (!force && cachedKey === cacheKey && Date.now() - cachedAt < REFRESH_TTL_MS && cachedModels.length > 0) {
      return cachedModels
    }
    try {
      const hdrs = requestHeaders(getConfig().headers)
      const [models, userInfo] = await Promise.all([
        fetchDiscoveredModels(auth.baseURL, auth.apiKey, hdrs, signal),
        fetchGatewayUserInfo(auth.baseURL, auth.apiKey, hdrs, signal),
      ])
      cachedModels = models
      cachedUser = userInfo
      cachedAt = Date.now()
      cachedKey = cacheKey
      return models
    } catch (err) {
      ctx.logger.warn(`openai-auto: /v1/models discovery failed: ${err instanceof Error ? err.message : String(err)}`)
      return cachedModels
    }
  }

  const formatDisplayName = () => {
    const base = readStr(getConfig().displayName) ?? "OpenAI-Compatible (Auto)"
    if (!cachedUser?.email) return base
    const spend =
      cachedUser.effectiveSpendUsd !== undefined && cachedUser.monthlyCapUsd !== undefined
        ? ` ($${cachedUser.effectiveSpendUsd.toFixed(2)}/$${cachedUser.monthlyCapUsd.toFixed(0)})`
        : ""
    return `${base} · ${cachedUser.email}${spend}`
  }

  class OpenAIAutoDshAdapter extends LlmAdapter {
    override providerInfo(provider: string) {
      return {
        id: provider,
        name: formatDisplayName(),
      }
    }

    override async listModels(provider: string): Promise<LlmModelInfo[]> {
      const list = await refreshModels(false)
      return list.map((m) => ({
        provider,
        id: m.id,
        name: m.name,
        inputModalities: m.supportsVision ? ["text", "image"] : ["text"],
      }))
    }

    override async resolveModel(provider: string, model: string, signal?: AbortSignal): Promise<LlmResolvedModelInfo> {
      const list = await refreshModels(false, signal)
      const found = list.find((m) => m.id === model)
      const cfg = getConfig()
      const efforts = found?.reasoning ? mapReasoningEfforts(found.reasoningEfforts) : []
      return {
        provider,
        id: model,
        name: found?.name ?? model,
        inputModalities: found?.supportsVision ? ["text", "image"] : ["text"],
        context: { contextWindow: found?.contextWindow ?? cfg.defaultContextWindow ?? DEFAULT_CONTEXT_WINDOW },
        defaultMaxTokens: found?.maxTokens ?? cfg.defaultMaxTokens ?? DEFAULT_MAX_TOKENS,
        ...(efforts.length > 0 ? { reasoning: { efforts } } : {}),
      }
    }

    override async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
      const cfg = getConfig()
      const { baseURL, apiKey } = await resolveEndpointAndAuth(options.signal)
      const resolved = await this.resolveModel(options.provider, options.model, options.signal)
      const meta = cachedModels.find((m) => m.id === options.model)
      const contextWindow = resolved.context?.contextWindow ?? DEFAULT_CONTEXT_WINDOW
      const reasoning = toPiReasoning(options.reasoningEffort ? String(options.reasoningEffort) : undefined)

      const piModel: Model<"openai-completions"> = {
        id: options.model,
        name: resolved.name,
        api: "openai-completions",
        provider: PROVIDER_ID,
        baseUrl: v1URL(baseURL),
        reasoning: meta?.reasoning ?? Boolean(reasoning),
        input: resolved.inputModalities?.includes("image") ? ["text", "image"] : ["text"],
        cost: meta?.cost ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow,
        maxTokens: resolved.defaultMaxTokens ?? DEFAULT_MAX_TOKENS,
        compat: {
          supportsStore: false,
          supportsUsageInStreaming: true,
          supportsReasoningEffort: Boolean(reasoning),
        },
      }

      const rawPiCtx = toPiContext(options)
      const normalizeContext = (piAiNs as Record<string, unknown>).normalizeContext
      const piCtx =
        typeof normalizeContext === "function"
          ? (normalizeContext as (c: PiContext) => unknown)(rawPiCtx)
          : rawPiCtx

      const piEvents = openAICompletionsApi().streamSimple(piModel, piCtx as never, {
        ...(apiKey ? { apiKey } : {}),
        ...(reasoning ? { reasoning } : {}),
        ...(options.temperature !== undefined ? { temperature: options.temperature } : {}),
        ...(options.maxTokens !== undefined ? { maxTokens: options.maxTokens } : {}),
        ...(options.sessionId !== undefined ? { sessionId: String(options.sessionId) } : {}),
        signal: options.signal,
        headers: requestHeaders(cfg.headers),
      })

      yield* toStreamChunks(piEvents, contextWindow, options.signal)
    }
  }

  const adapter = new OpenAIAutoDshAdapter()
  ctx.llm.registerAdapter([PROVIDER_ID], adapter)
  ctx.llm.registerConfigurableProviders([
    {
      provider: PROVIDER_ID,
      displayName: formatDisplayName(),
      settingsNs: name,
      settingsPath: [],
      declared: true,
    },
  ])
  ctx.llm.registerModelDiscovery(name, async (req, signal): Promise<readonly LlmDiscoveredModel[]> => {
    const auth = req.baseURL
      ? { baseURL: req.baseURL, apiKey: req.apiKey }
      : await resolveEndpointAndAuth(signal)
    const list = await fetchDiscoveredModels(auth.baseURL, auth.apiKey, requestHeaders(getConfig().headers), signal)
    return list.map((m) => ({
      id: m.id,
      name: m.name,
      ...(m.contextWindow !== undefined ? { contextWindow: m.contextWindow } : {}),
      ...(m.maxTokens !== undefined ? { maxTokens: m.maxTokens } : {}),
    }))
  })

  ctx.inject(["authorization", "credentials"], (authCtx) => {
    authCtx.authorization.registerFlow({
      key: RECORD_KEY,
      label: "OpenAI-Compatible (Auto)",
      methods: [
        { id: "litellm-cli", label: "LiteLLM CLI Code Flow (Browser)" },
        { id: "api-key", label: "API Key + Base URL" },
      ],
      async run(session) {
        const defaultUrl =
          readStr(getConfig().baseURL) ?? readStr(process.env.LITELLM_BASE_URL) ?? "https://llm.example.com"
        const rawUrl = await session.prompt({
          kind: "text",
          message: "Endpoint Base URL",
          placeholder: defaultUrl,
        })
        const baseURL = readStr(rawUrl) ?? readStr(getConfig().baseURL) ?? readStr(process.env.LITELLM_BASE_URL)
        if (!baseURL) throw new LlmError("Base URL is required", "INVALID_ARGS")

        if (session.method === "api-key") {
          const apiKey = readStr(
            await session.prompt({
              kind: "secret",
              message: "API key (optional for local endpoints)",
              placeholder: "sk-...",
            }),
          )
          await fetchDiscoveredModels(baseURL, apiKey, requestHeaders(getConfig().headers), session.signal)
          await authCtx.credentials.modifyRecord(RECORD_KEY, async () => ({
            kind: "grant",
            payload: {
              access: apiKey ?? "local",
              refresh: "",
              expires: NEVER_EXPIRES,
              baseURL: rootURL(baseURL),
            } satisfies StoredGrant,
          }))
          void refreshModels(true).catch(() => {})
          return
        }

        const team = readStr(
          await session.prompt({
            kind: "text",
            message: "LiteLLM team (optional)",
            placeholder: "Leave blank if not required",
          }),
        )
        const tok = await runLiteLLMLogin(
          baseURL,
          { providerID: PROVIDER_ID, team, headers: requestHeaders(getConfig().headers), clientName: "dsh" },
          {
            signal: session.signal,
            onAuth: (url, instructions) => {
              session.notify({ message: instructions, url })
            },
            onPrompt: (message, placeholder) =>
              session.prompt({ kind: "secret", message, placeholder }),
          },
        )
        await authCtx.credentials.modifyRecord(RECORD_KEY, async () => ({
          kind: "grant",
          payload: {
            access: tok.access,
            refresh: tok.refresh,
            expires: tok.expires,
            baseURL: rootURL(baseURL),
            metadata: tok.metadata,
          } satisfies StoredGrant,
        }))
        void refreshModels(true).catch(() => {})
      },
    })
  })

  ctx.on("credentials/record-updated", (key) => {
    if (key === RECORD_KEY) void refreshModels(true).catch(() => {})
  })

  ctx.inject(["settings"], (settingsCtx) => {
    settingsCtx.settings.installSection(ctx, name, Config, initialConfig, {
      setSource: (source) => {
        getConfig = source
      },
      onChange: () => {
        void refreshModels(true).catch(() => {})
      },
    })
  })
}
