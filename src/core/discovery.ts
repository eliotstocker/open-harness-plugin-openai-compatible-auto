const TIMEOUT_MS = 15_000
const ME_TIMEOUT_MS = 5_000
const NON_CHAT_RE = /\b(embed|embedding|whisper|tts|dall-e|moderation|rerank|speech)\b/i

export interface ModelCostPer1M {
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
}

export interface DiscoveredModel {
  id: string
  name: string
  publisher?: string
  contextWindow?: number
  maxTokens?: number
  reasoning?: boolean
  reasoningEfforts?: string[]
  supportsTools?: boolean
  supportsVision?: boolean
  supportsAudio?: boolean
  supportsVideo?: boolean
  supportsPdf?: boolean
  supportsPromptCaching?: boolean
  inputModalities?: string[]
  cost?: ModelCostPer1M
}

export interface GatewayUserInfo {
  gatewayName?: string
  email?: string
  gcpBillingLabel?: string
  keyName?: string
  monthlyCapUsd?: number
  settledUsd?: number
  unsettledUsd?: number
  effectiveSpendUsd?: number
  remainingUsd?: number
  allowed?: boolean
  usageUrl?: string
}

function safeHttpUrl(raw: unknown): string | undefined {
  if (typeof raw !== "string" || !raw.trim()) return undefined
  try {
    const parsed = new URL(raw.trim())
    return parsed.protocol === "https:" || parsed.protocol === "http:" ? parsed.href : undefined
  } catch {
    return undefined
  }
}

function resolveUsageUrl(baseURL: string, me?: Record<string, unknown>): string | undefined {
  const explicitUsage = safeHttpUrl(me?.usage_url)
  if (explicitUsage) return explicitUsage
  const portalBase = safeHttpUrl(me?.portal_url) ?? safeHttpUrl(me?.base_url) ?? safeHttpUrl(baseURL)
  return portalBase ? `${rootURL(portalBase)}/portal#usage` : undefined
}

/** Strip trailing slashes and optional `/v1` suffix so endpoints resolve consistently. */
export function rootURL(baseURL: string): string {
  let url = baseURL.trim().replace(/\/+$/, "")
  if (url.endsWith("/v1")) url = url.slice(0, -3)
  return url
}

export function v1URL(baseURL: string): string {
  return `${rootURL(baseURL)}/v1`
}

function authHeaders(apiKey?: string, extra?: Record<string, string>): Record<string, string> {
  return {
    Accept: "application/json",
    ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
    ...extra,
  }
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v)
}

function posInt(v: unknown): number | undefined {
  return typeof v === "number" && Number.isFinite(v) && v > 0 ? Math.floor(v) : undefined
}

function nonNegNum(v: unknown): number | undefined {
  return typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : undefined
}

function strArray(v: unknown): string[] | undefined {
  if (!Array.isArray(v)) return undefined
  const out = v.filter((x): x is string => typeof x === "string" && x.trim().length > 0).map((x) => x.trim())
  return out.length > 0 ? out : undefined
}

function roundUsd(v: number): number {
  return Math.round(v * 1_000_000) / 1_000_000
}

interface ModelInfoMeta {
  displayName?: string
  publisher?: string
  mode?: string
  maxInputTokens?: number
  maxOutputTokens?: number
  maxTokens?: number
  supportsTools?: boolean
  supportsVision?: boolean
  supportsAudio?: boolean
  supportsVideo?: boolean
  supportsPdf?: boolean
  supportsPromptCaching?: boolean
  supportsReasoning?: boolean
  reasoningEfforts?: string[]
  cost?: ModelCostPer1M
}

async function fetchModelInfo(
  baseURL: string,
  headers: Record<string, string>,
  signal?: AbortSignal,
): Promise<Map<string, ModelInfoMeta>> {
  const map = new Map<string, ModelInfoMeta>()
  try {
    const reqSignal = signal
      ? AbortSignal.any([signal, AbortSignal.timeout(TIMEOUT_MS)])
      : AbortSignal.timeout(TIMEOUT_MS)
    const res = await fetch(`${v1URL(baseURL)}/model/info`, {
      headers,
      signal: reqSignal,
    })
    if (!res.ok) return map
    const json = (await res.json()) as { data?: unknown }
    if (!Array.isArray(json.data)) return map
    for (const item of json.data) {
      if (!isRecord(item) || !isRecord(item.model_info)) continue
      const info = item.model_info
      const params = isRecord(item.litellm_params) ? item.litellm_params : undefined
      const key =
        (typeof item.model_name === "string" && item.model_name) ||
        (typeof info.key === "string" && info.key) ||
        (typeof params?.model === "string" ? params.model : undefined)
      if (!key || map.has(key)) continue

      const inTok = nonNegNum(info.input_cost_per_token)
      const outTok = nonNegNum(info.output_cost_per_token)
      const cacheReadTok = nonNegNum(info.cache_read_input_token_cost)
      const cacheWriteTok = nonNegNum(info.cache_creation_input_token_cost)
      const cost: ModelCostPer1M | undefined =
        inTok !== undefined || outTok !== undefined
          ? {
              input: roundUsd((inTok ?? 0) * 1_000_000),
              output: roundUsd((outTok ?? 0) * 1_000_000),
              cacheRead: roundUsd((cacheReadTok ?? 0) * 1_000_000),
              cacheWrite: roundUsd((cacheWriteTok ?? 0) * 1_000_000),
            }
          : undefined

      map.set(key, {
        displayName: typeof info.display_name === "string" && info.display_name.trim() ? info.display_name.trim() : undefined,
        publisher: typeof info.litellm_provider === "string" && info.litellm_provider.trim() ? info.litellm_provider.trim() : undefined,
        mode: typeof info.mode === "string" ? info.mode : undefined,
        maxInputTokens: posInt(info.max_input_tokens),
        maxOutputTokens: posInt(info.max_output_tokens),
        maxTokens: posInt(info.max_tokens),
        supportsTools:
          typeof info.supports_function_calling === "boolean"
            ? info.supports_function_calling
            : undefined,
        supportsVision: typeof info.supports_vision === "boolean" ? info.supports_vision : undefined,
        supportsAudio: typeof info.supports_audio_input === "boolean" ? info.supports_audio_input : undefined,
        supportsVideo: typeof info.supports_video_input === "boolean" ? info.supports_video_input : undefined,
        supportsPdf: typeof info.supports_pdf_input === "boolean" ? info.supports_pdf_input : undefined,
        supportsPromptCaching:
          typeof info.supports_prompt_caching === "boolean" ? info.supports_prompt_caching : undefined,
        supportsReasoning:
          typeof info.supports_reasoning === "boolean" ? info.supports_reasoning : undefined,
        reasoningEfforts: strArray(info.supported_reasoning_efforts),
        cost,
      })
    }
  } catch {
    // `/v1/model/info` is LiteLLM/prov-ai-specific; standard OpenAI-compatible endpoints only expose `/v1/models`.
  }
  return map
}

/** Query `/v1/models` (and optional `/v1/model/info`) and return normalized chat model descriptors. */
export async function fetchDiscoveredModels(
  baseURL: string,
  apiKey?: string,
  extraHeaders?: Record<string, string>,
  signal?: AbortSignal,
): Promise<DiscoveredModel[]> {
  const headers = authHeaders(apiKey, extraHeaders)
  const reqSignal = signal
    ? AbortSignal.any([signal, AbortSignal.timeout(TIMEOUT_MS)])
    : AbortSignal.timeout(TIMEOUT_MS)

  const [modelsRes, infoMap] = await Promise.all([
    fetch(`${v1URL(baseURL)}/models`, {
      headers,
      signal: reqSignal,
    }),
    fetchModelInfo(baseURL, headers, signal),
  ])

  if (!modelsRes.ok) {
    throw new Error(`GET /v1/models failed: HTTP ${modelsRes.status} ${modelsRes.statusText}`)
  }

  const body = (await modelsRes.json()) as unknown
  const list = Array.isArray(body)
    ? body
    : isRecord(body) && Array.isArray(body.data)
      ? body.data
      : isRecord(body) && Array.isArray(body.models)
        ? body.models
        : null

  if (!list) throw new Error("Unexpected /v1/models response shape")

  const seen = new Set<string>()
  const models: DiscoveredModel[] = []

  for (const item of list) {
    if (!isRecord(item)) continue
    const id = typeof item.id === "string" ? item.id : typeof item.name === "string" ? item.name : ""
    if (!id || seen.has(id)) continue

    const meta = infoMap.get(id)
    const mode = meta?.mode ?? (typeof item.mode === "string" ? item.mode : undefined)
    if (mode && mode !== "chat" && mode !== "completion" && mode !== "responses") continue
    if (!mode && NON_CHAT_RE.test(id)) continue

    seen.add(id)
    const contextWindow =
      meta?.maxInputTokens ?? posInt(item.context_length) ?? posInt(item.max_model_len)
    const maxTokens = meta?.maxOutputTokens ?? meta?.maxTokens ?? posInt(item.max_tokens)
    const name =
      (typeof item.name === "string" && item.name.trim() ? item.name.trim() : undefined) ??
      meta?.displayName ??
      id
    const publisher =
      meta?.publisher ??
      (typeof item.owned_by === "string" && item.owned_by.trim() ? item.owned_by.trim() : undefined)

    const supportsVision =
      meta?.supportsVision ?? (typeof item.supports_vision === "boolean" ? item.supports_vision : undefined)
    const supportsAudio =
      meta?.supportsAudio ?? (typeof item.supports_audio_input === "boolean" ? item.supports_audio_input : undefined)
    const supportsVideo =
      meta?.supportsVideo ?? (typeof item.supports_video_input === "boolean" ? item.supports_video_input : undefined)
    const supportsPdf = meta?.supportsPdf

    const rawModalities = strArray(item.input_modalities) ?? ["text"]
    const modalitySet = new Set<string>(rawModalities)
    if (supportsVision) modalitySet.add("image")
    if (supportsAudio) modalitySet.add("audio")
    if (supportsVideo) modalitySet.add("video")
    if (supportsPdf) modalitySet.add("pdf")

    const reasoningEfforts = meta?.reasoningEfforts ?? strArray(item.supported_reasoning_efforts)
    const reasoning =
      meta?.supportsReasoning ??
      (typeof item.supports_reasoning === "boolean" ? item.supports_reasoning : undefined) ??
      (reasoningEfforts && reasoningEfforts.length > 0 ? true : undefined)

    models.push({
      id,
      name,
      publisher,
      contextWindow,
      maxTokens,
      reasoning,
      reasoningEfforts,
      supportsTools: meta?.supportsTools,
      supportsVision,
      supportsAudio,
      supportsVideo,
      supportsPdf,
      supportsPromptCaching: meta?.supportsPromptCaching,
      inputModalities: [...modalitySet],
      cost: meta?.cost,
    })
  }

  return models
}

/** Optional query for `GET /v1/me` on prov-ai gateways; returns `undefined` cleanly on unsupported endpoints. */
export async function fetchGatewayUserInfo(
  baseURL: string,
  apiKey?: string,
  extraHeaders?: Record<string, string>,
  signal?: AbortSignal,
): Promise<GatewayUserInfo | undefined> {
  if (!apiKey) return undefined
  try {
    const reqSignal = signal
      ? AbortSignal.any([signal, AbortSignal.timeout(ME_TIMEOUT_MS)])
      : AbortSignal.timeout(ME_TIMEOUT_MS)
    const res = await fetch(`${v1URL(baseURL)}/me`, {
      headers: authHeaders(apiKey, extraHeaders),
      signal: reqSignal,
    })
    if (!res.ok) return undefined
    const json = (await res.json()) as unknown
    if (!isRecord(json)) return undefined
    return {
      gatewayName: typeof json.gateway_name === "string" && json.gateway_name.trim() ? json.gateway_name.trim() : undefined,
      email: typeof json.email === "string" && json.email.trim() ? json.email.trim() : undefined,
      gcpBillingLabel:
        typeof json.gcp_billing_label === "string" && json.gcp_billing_label.trim()
          ? json.gcp_billing_label.trim()
          : undefined,
      keyName: typeof json.key_name === "string" && json.key_name.trim() ? json.key_name.trim() : undefined,
      monthlyCapUsd: nonNegNum(json.monthly_cap_usd),
      settledUsd: nonNegNum(json.settled_usd),
      unsettledUsd: nonNegNum(json.unsettled_usd),
      effectiveSpendUsd: nonNegNum(json.effective_spend_usd),
      remainingUsd: nonNegNum(json.remaining_usd),
      allowed: typeof json.allowed === "boolean" ? json.allowed : undefined,
      usageUrl: resolveUsageUrl(baseURL, json),
    }
  } catch {
    return undefined
  }
}
