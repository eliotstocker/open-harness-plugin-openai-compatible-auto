import { createHash, randomBytes, timingSafeEqual } from "node:crypto"
import { createServer } from "node:http"
import { isIP } from "node:net"
import { setTimeout as delay } from "node:timers/promises"
import { rootURL } from "./discovery.js"

const REQUEST_TIMEOUT_MS = 10_000
const CALLBACK_TIMEOUT_MS = 10 * 60 * 1000
const POLL_INTERVAL_MS = 2_000
const DEFAULT_TOKEN_LIFETIME_MS = 24 * 60 * 60 * 1000

export const NEVER_EXPIRES = Number.MAX_SAFE_INTEGER
export const PKCE_FLOW = "litellm_cli_pkce"

type Json = Record<string, unknown>

export interface LiteLLMTokens {
  access: string
  refresh: string
  expires: number
  metadata: Record<string, unknown>
}

export type LiteLLMInteractiveSession =
  | {
      mode: "auto"
      url: string
      instructions: string
      expiresAt: number
      waitForToken(signal?: AbortSignal): Promise<LiteLLMTokens>
    }
  | {
      mode: "code"
      url: string
      instructions: string
      exchangeCode(code: string): Promise<LiteLLMTokens>
    }

export interface LiteLLMLoginCallbacks {
  onAuth(url: string, instructions: string): void
  onPrompt(message: string, placeholder?: string): Promise<string>
  signal?: AbortSignal
}

interface CliAuthDiscovery {
  authorizationEndpoint: string
  tokenEndpoint: string
  registrationEndpoint: string
  resource: string
}

function isRecord(v: unknown): v is Json {
  return typeof v === "object" && v !== null && !Array.isArray(v)
}

function isToken(v: unknown): v is string {
  return typeof v === "string" && /^[\x21-\x7e]+$/.test(v)
}

function posNumber(v: unknown): number | undefined {
  return typeof v === "number" && Number.isFinite(v) && v > 0 ? v : undefined
}

function safeEqual(a: unknown, b: string): boolean {
  if (typeof a !== "string") return false
  const left = Buffer.from(a)
  const right = Buffer.from(b)
  return left.length === right.length && timingSafeEqual(left, right)
}

function jwtExpiry(token: string, fallback: number): number {
  const [, payload] = token.split(".")
  if (!payload) return fallback
  try {
    const claims = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as unknown
    const exp = isRecord(claims) ? posNumber(claims.exp) : undefined
    return exp ? Math.min(Math.floor(exp * 1_000), NEVER_EXPIRES) : fallback
  } catch {
    return fallback
  }
}

export function validateSsoRoot(baseURL: string): string {
  let url: URL
  try {
    url = new URL(baseURL)
  } catch {
    throw new Error(`Invalid LiteLLM base URL: ${baseURL}`)
  }
  const host = url.hostname
  const loopback = host === "localhost" || host === "[::1]" || (isIP(host) === 4 && host.startsWith("127."))
  if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) {
    throw new Error("LiteLLM browser sign-in requires https (or http on localhost)")
  }
  return rootURL(url.href)
}

function sameOrigin(value: unknown, issuer: URL, field: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`Invalid ${field}`)
  const url = new URL(value)
  if (url.origin !== issuer.origin) throw new Error(`Cross-origin ${field}`)
  return value.trim()
}

async function listenLoopback() {
  const state = randomBytes(32).toString("base64url")
  const expiresAt = Date.now() + CALLBACK_TIMEOUT_MS
  const server = createServer()

  let settle!: (res: { code?: string; error?: Error }) => void
  const code = new Promise<string>((resolve, reject) => {
    const timer = setTimeout(() => settle({ error: new Error("LiteLLM sign-in timed out") }), CALLBACK_TIMEOUT_MS)
    settle = (res) => {
      settle = () => {}
      clearTimeout(timer)
      server.close()
      if (res.error) reject(res.error)
      else resolve(res.code!)
    }
  })
  code.catch(() => {})

  server.on("request", (req, res) => {
    res.setHeader("Cache-Control", "no-store")
    const url = new URL(req.url ?? "/", "http://127.0.0.1")
    if (url.pathname !== "/callback") return void res.writeHead(404).end()
    if (!safeEqual(url.searchParams.get("state"), state)) return void res.writeHead(400).end("Invalid state")
    const err = url.searchParams.get("error")
    if (err) {
      res.writeHead(400).end("Sign-in failed")
      return settle({ error: new Error(`LiteLLM sign-in denied (${err})`) })
    }
    const authCode = url.searchParams.get("code")
    if (!authCode) return void res.writeHead(400).end("Missing code")
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" })
    res.end("<!doctype html><title>LiteLLM login complete</title><p>Signed in. You can close this tab.</p>")
    settle({ code: authCode })
  })

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject)
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject)
      resolve()
    })
  })

  const addr = server.address()
  if (!addr || typeof addr === "string") {
    settle({ error: new Error("Loopback callback failed to bind") })
    throw new Error("Loopback callback failed to bind")
  }

  return {
    redirectUri: `http://127.0.0.1:${addr.port}/callback`,
    state,
    expiresAt,
    code,
    close: () => settle({ error: new Error("LiteLLM sign-in cancelled") }),
  }
}

async function discoverPkce(
  root: string,
  headers?: Record<string, string>,
  signal?: AbortSignal,
): Promise<CliAuthDiscovery | undefined> {
  const reqSignal = signal
    ? AbortSignal.any([signal, AbortSignal.timeout(REQUEST_TIMEOUT_MS)])
    : AbortSignal.timeout(REQUEST_TIMEOUT_MS)
  const res = await fetch(`${root}/.well-known/litellm-cli-auth`, {
    headers: { Accept: "application/json", ...headers },
    signal: reqSignal,
  })
  if (res.status === 429 || res.status >= 500) {
    throw new Error(`LiteLLM CLI auth discovery failed (HTTP ${res.status})`)
  }
  if (!res.ok) return undefined
  const data = (await res.json().catch(() => undefined)) as unknown
  if (!isRecord(data) || data.contract_version !== 1) return undefined
  if (!Array.isArray(data.code_challenge_methods_supported) || !data.code_challenge_methods_supported.includes("S256")) {
    throw new Error("LiteLLM CLI auth discovery missing S256 support")
  }
  const issuer = new URL(String(data.issuer))
  if (rootURL(issuer.href) !== rootURL(root)) throw new Error("LiteLLM CLI auth issuer mismatch")
  return {
    authorizationEndpoint: sameOrigin(data.authorization_endpoint, issuer, "authorization_endpoint"),
    tokenEndpoint: sameOrigin(data.token_endpoint, issuer, "token_endpoint"),
    registrationEndpoint: sameOrigin(data.registration_endpoint, issuer, "registration_endpoint"),
    resource: sameOrigin(data.resource, issuer, "resource"),
  }
}

async function exchangePkce(
  endpoint: string,
  form: URLSearchParams,
  headers?: Record<string, string>,
  fallbackRefresh?: string,
  signal?: AbortSignal,
) {
  const reqSignal = signal
    ? AbortSignal.any([signal, AbortSignal.timeout(REQUEST_TIMEOUT_MS)])
    : AbortSignal.timeout(REQUEST_TIMEOUT_MS)
  const res = await fetch(endpoint, {
    method: "POST",
    headers: { ...headers, Accept: "application/json", "Content-Type": "application/x-www-form-urlencoded" },
    body: form,
    signal: reqSignal,
  })
  const data = (await res.json().catch(() => undefined)) as unknown
  if (!res.ok || !isRecord(data)) {
    throw new Error(`LiteLLM token exchange failed (HTTP ${res.status})`)
  }
  const expiresIn = posNumber(data.expires_in)
  if (!isToken(data.access_token) || (!isToken(data.refresh_token) && !isToken(fallbackRefresh)) || !expiresIn) {
    throw new Error("LiteLLM token exchange returned invalid token payload")
  }
  return {
    access: data.access_token,
    refresh: isToken(data.refresh_token) ? data.refresh_token : fallbackRefresh!,
    expires: Math.floor(Date.now() + expiresIn * 1_000),
  }
}

/**
 * Starts browser-based LiteLLM sign-in and returns a host-neutral interactive handle:
 * 1) LiteLLM CLI-auth PKCE (`/.well-known/litellm-cli-auth`)
 * 2) LiteLLM CLI SSO code flow (`/sso/cli/start` + `/sso/cli/poll`)
 * 3) Pasted UI token fallback (`/sso/key/generate` + `/key/generate`)
 */
export async function startLiteLLMInteractive(
  baseURL: string,
  meta: { providerID: string; team?: string; headers?: Record<string, string>; clientName?: string; signal?: AbortSignal },
): Promise<LiteLLMInteractiveSession> {
  const root = validateSsoRoot(baseURL)
  const pkce = await discoverPkce(root, meta.headers, meta.signal)

  if (pkce) {
    const verifier = randomBytes(32).toString("base64url")
    const challenge = createHash("sha256").update(verifier).digest("base64url")
    const cb = await listenLoopback()
    try {
      const regRes = await fetch(pkce.registrationEndpoint, {
        method: "POST",
        headers: { ...meta.headers, Accept: "application/json", "Content-Type": "application/json" },
        body: JSON.stringify({
          client_name: meta.clientName ?? "open-harness-plugin-openai-compatible-auto",
          redirect_uris: [cb.redirectUri],
          token_endpoint_auth_method: "none",
          grant_types: ["authorization_code", "refresh_token"],
          response_types: ["code"],
        }),
        signal: meta.signal
          ? AbortSignal.any([meta.signal, AbortSignal.timeout(REQUEST_TIMEOUT_MS)])
          : AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      })
      const reg = (await regRes.json().catch(() => undefined)) as unknown
      if (!regRes.ok || !isRecord(reg) || !isToken(reg.client_id)) {
        throw new Error(`LiteLLM PKCE registration failed (HTTP ${regRes.status})`)
      }
      const clientId = reg.client_id
      const authUrl = new URL(pkce.authorizationEndpoint)
      for (const [k, v] of Object.entries({
        client_id: clientId,
        redirect_uri: cb.redirectUri,
        response_type: "code",
        resource: pkce.resource,
        code_challenge: challenge,
        code_challenge_method: "S256",
        state: cb.state,
      })) {
        authUrl.searchParams.set(k, v)
      }

      return {
        mode: "auto",
        url: authUrl.toString(),
        instructions: "Sign in to LiteLLM in your browser.",
        expiresAt: cb.expiresAt,
        waitForToken: async (signal) => {
          const onAbort = () => cb.close()
          signal?.addEventListener("abort", onAbort, { once: true })
          try {
            const code = await cb.code
            const tok = await exchangePkce(
              pkce.tokenEndpoint,
              new URLSearchParams({
                grant_type: "authorization_code",
                code,
                redirect_uri: cb.redirectUri,
                client_id: clientId,
                code_verifier: verifier,
                resource: pkce.resource,
              }),
              meta.headers,
              undefined,
              signal,
            )
            return {
              ...tok,
              metadata: {
                flow: PKCE_FLOW,
                baseURL: root,
                providerID: meta.providerID,
                clientId,
                tokenEndpoint: pkce.tokenEndpoint,
                resource: pkce.resource,
              },
            }
          } finally {
            signal?.removeEventListener("abort", onAbort)
          }
        },
      }
    } catch (err) {
      cb.close()
      throw err
    }
  }

  // Fallback 1: LiteLLM CLI SSO code flow (/sso/cli/start -> /sso/cli/poll)
  const startRes = await fetch(`${root}/sso/cli/start`, {
    method: "POST",
    headers: meta.headers,
    signal: meta.signal
      ? AbortSignal.any([meta.signal, AbortSignal.timeout(REQUEST_TIMEOUT_MS)])
      : AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  })
  if (startRes.ok) {
    const start = (await startRes.json().catch(() => undefined)) as unknown
    if (
      isRecord(start) &&
      typeof start.login_id === "string" &&
      typeof start.poll_secret === "string" &&
      typeof start.user_code === "string"
    ) {
      const loginId = start.login_id
      const pollSecret = start.poll_secret
      const ttlSec = posNumber(start.expires_in) ?? 600
      const deadline = Date.now() + ttlSec * 1_000
      const urlParams = new URLSearchParams({ source: "litellm-cli", key: loginId })
      if (meta.clientName) urlParams.set("client", meta.clientName)
      return {
        mode: "auto",
        url: `${root}/sso/key/generate?${urlParams}`,
        instructions: `Sign in to LiteLLM in your browser and confirm code: ${start.user_code}`,
        expiresAt: deadline,
        waitForToken: async (signal) => {
          const pollUrl = new URL(`${root}/sso/cli/poll/${encodeURIComponent(loginId)}`)
          let teamId: string | undefined
          while (Date.now() < deadline) {
            signal?.throwIfAborted()
            if (teamId) pollUrl.searchParams.set("team_id", teamId)
            const pollSignal = signal
              ? AbortSignal.any([signal, AbortSignal.timeout(REQUEST_TIMEOUT_MS)])
              : AbortSignal.timeout(REQUEST_TIMEOUT_MS)
            const res = await fetch(pollUrl, {
              headers: { ...meta.headers, "x-litellm-cli-poll-secret": pollSecret },
              signal: pollSignal,
            }).catch((err) => {
              if (signal?.aborted) throw err
              return undefined
            })
            if (!res || res.status === 429 || res.status >= 500) {
              await delay(POLL_INTERVAL_MS, undefined, { signal })
              continue
            }
            if (!res.ok) throw new Error(`LiteLLM CLI SSO poll failed (HTTP ${res.status})`)
            const data = (await res.json().catch(() => undefined)) as unknown
            if (!isRecord(data)) throw new Error("Invalid LiteLLM CLI SSO poll response")
            if (data.status === "ready" && isToken(data.key)) {
              const exp = posNumber(data.expires_in)
              return {
                access: data.key,
                refresh: "",
                expires: exp
                  ? Math.floor(Date.now() + exp * 1_000)
                  : jwtExpiry(data.key, Date.now() + DEFAULT_TOKEN_LIFETIME_MS),
                metadata: { baseURL: root, providerID: meta.providerID },
              }
            }
            if (data.status === "ready" && data.requires_team_selection === true && !teamId) {
              const teams = Array.isArray(data.team_details) ? data.team_details : []
              const picked = meta.team
                ? teams.find((t) => isRecord(t) && (t.team_id === meta.team || t.team_alias === meta.team))
                : undefined
              if (isRecord(picked) && typeof picked.team_id === "string") {
                teamId = picked.team_id
                continue
              }
              const names = teams
                .map((t) => (isRecord(t) ? String(t.team_alias ?? t.team_id ?? "") : ""))
                .filter(Boolean)
                .join(", ")
              throw new Error(`LiteLLM requires team selection. Reconnect with Team set to one of: ${names}`)
            }
            if (data.status !== "pending") throw new Error("LiteLLM CLI SSO login failed")
            await delay(POLL_INTERVAL_MS, undefined, { signal })
          }
          throw new Error("LiteLLM CLI SSO login expired")
        },
      }
    }
  }

  // Fallback 2: User pastes token from /sso/key/generate
  return {
    mode: "code",
    url: `${root}/sso/key/generate`,
    instructions: "Sign in to LiteLLM in your browser, then paste the token as the code.",
    exchangeCode: async (code) => {
      const pasted = code.trim().replace(/^Bearer\s+/i, "").trim()
      if (!isToken(pasted)) throw new Error("Paste a valid token from LiteLLM UI")
      let access = pasted
      let expires = jwtExpiry(pasted, NEVER_EXPIRES)
      const genRes = await fetch(`${root}/key/generate`, {
        method: "POST",
        headers: { ...meta.headers, Authorization: `Bearer ${pasted}`, "Content-Type": "application/json" },
        body: JSON.stringify({}),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      }).catch(() => undefined)
      if (genRes?.ok) {
        const gen = (await genRes.json().catch(() => undefined)) as unknown
        if (isRecord(gen) && isToken(gen.key)) {
          access = gen.key
          const parsedExp = typeof gen.expires === "string" ? Date.parse(gen.expires) : NaN
          if (Number.isSafeInteger(parsedExp)) expires = parsedExp
        }
      }
      return {
        access,
        refresh: "",
        expires,
        metadata: { baseURL: root, providerID: meta.providerID },
      }
    },
  }
}

/** Convenience runner for hosts whose login flow pushes notices/prompts directly (Pi, DSH). */
export async function runLiteLLMLogin(
  baseURL: string,
  meta: { providerID: string; team?: string; headers?: Record<string, string>; clientName?: string },
  callbacks: LiteLLMLoginCallbacks,
): Promise<LiteLLMTokens> {
  const session = await startLiteLLMInteractive(baseURL, { ...meta, signal: callbacks.signal })
  callbacks.onAuth(session.url, session.instructions)
  if (session.mode === "auto") {
    return session.waitForToken(callbacks.signal)
  }
  const code = await callbacks.onPrompt("Paste the token from LiteLLM UI:", "sk-...")
  return session.exchangeCode(code)
}

export async function refreshLiteLLMTokens(
  token: { access: string; refresh: string; expires: number; metadata?: Record<string, unknown> },
  headers?: Record<string, string>,
  signal?: AbortSignal,
): Promise<{ access: string; refresh: string; expires: number }> {
  const meta = token.metadata ?? {}
  if (meta.flow === PKCE_FLOW && typeof meta.tokenEndpoint === "string" && isToken(meta.clientId) && isToken(token.refresh)) {
    return exchangePkce(
      meta.tokenEndpoint,
      new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: token.refresh,
        client_id: meta.clientId,
        ...(typeof meta.resource === "string" ? { resource: meta.resource } : {}),
      }),
      headers,
      token.refresh,
      signal,
    )
  }
  if (Date.now() < token.expires) {
    return { access: token.access, refresh: token.refresh, expires: token.expires }
  }
  throw new Error("LiteLLM sign-in expired; reconnect")
}
