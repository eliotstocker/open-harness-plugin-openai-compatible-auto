import * as React from "react"

export const inject = ["slots", "connection"] as const

interface RpcFailure {
  code: string
  message: string
  details: Record<string, unknown>
}

type RpcResult<T> = { ok: true; value: T } | { ok: false; error: RpcFailure }

interface DshClientContext {
  slots: {
    inject(slotName: string, factory: () => () => void): void
    register(
      options: { name: string; key: string },
      component: (props: Record<string, unknown>) => React.ReactNode,
    ): () => void
  }
  connection: {
    rpc: {
      call(channel: string, endpoint: string, payload: unknown): Promise<RpcResult<unknown>>
    }
  }
  effect(cb: () => void | (() => void), label?: string): void
  on(event: string, listener: (...args: unknown[]) => void): () => void
}

interface LoginNotice {
  message: string
  url?: string
  code?: string
}

interface LoginPrompt {
  id: string
  kind: "text" | "secret"
  message: string
  placeholder?: string
}

interface WebLoginSnapshot {
  inFlight: boolean
  method: "litellm-cli" | "api-key"
  baseURL: string
  notice: LoginNotice | null
  prompt: LoginPrompt | null
  error: string | null
  outcome: "authorized" | "cancelled" | "failed" | null
}

interface StatusSnapshot {
  baseURL: string
  configuredBaseURL: string
  signedIn: boolean
  authKind: "oauth" | "api-key" | "config" | "none"
  user: {
    email?: string
    gatewayName?: string
    effectiveSpendUsd?: number
    monthlyCapUsd?: number
  } | null
  modelCount: number
  login: WebLoginSnapshot | null
}

const STYLE_ID = "@eliotstocker/open-harness-plugin-openai-compatible-auto/provider-card.css"

const CARD_CSS = `
.oa-card{display:flex;flex-direction:column;gap:12px;background:var(--dsw-alias-bg-module-platform,rgba(127,127,127,.06));border-radius:12px;padding:12px 14px}
.oa-status{display:flex;align-items:center;justify-content:space-between;gap:8px;flex-wrap:wrap;font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary,#666)}
.oa-status-main{display:inline-flex;align-items:center;gap:6px;min-width:0}
.oa-dot{width:8px;height:8px;border-radius:50%;flex:none;background:var(--dsw-alias-label-tertiary,#999)}
.oa-dot-ok{background:var(--dsw-alias-state-success-primary,#16a34a)}
.oa-status-actions{display:inline-flex;align-items:center;gap:6px}
.oa-field{display:flex;flex-direction:column;gap:6px}
.oa-label{font-size:12px;font-weight:500;line-height:18px;color:var(--dsw-alias-label-secondary,#666)}
.oa-row{display:flex;align-items:center;gap:8px}
.oa-input{box-sizing:border-box;flex:1;min-width:0;height:34px;padding:0 12px;border-radius:8px;border:.5px solid var(--dsw-alias-border-l4,rgba(127,127,127,.3));background:var(--dsw-alias-bg-layer-3,#fff);color:var(--dsw-alias-label-primary,inherit);font:inherit;font-size:13px;line-height:20px}
.oa-input:focus-visible{outline:none;border-color:var(--dsw-alias-brand-primary,#4d6bfe)}
.oa-input:disabled{opacity:.6;cursor:default}
.oa-btn-primary,.oa-btn-secondary,.oa-btn-danger{box-sizing:border-box;height:34px;padding:0 14px;border-radius:17px;font:inherit;font-size:13px;line-height:20px;cursor:pointer;display:inline-flex;align-items:center;justify-content:center;gap:6px;white-space:nowrap;border:none}
.oa-btn-primary{background:var(--dsw-alias-button-primary-fill,#111);color:var(--dsw-alias-label-primary-foreground,#fff)}
.oa-btn-primary:hover:not(:disabled){background:var(--dsw-alias-button-primary-hover,#333)}
.oa-btn-secondary{border:.5px solid var(--dsw-alias-border-l3,rgba(127,127,127,.35));background:transparent;color:var(--dsw-alias-label-primary,inherit)}
.oa-btn-secondary:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.08))}
.oa-btn-danger{background:transparent;color:var(--dsw-alias-state-error-primary,#dc2626)}
.oa-btn-danger:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover-danger,rgba(220,38,38,.08))}
.oa-btn-sm{height:26px;padding:0 10px;border-radius:13px;font-size:12px;line-height:18px}
.oa-btn-primary:disabled,.oa-btn-secondary:disabled,.oa-btn-danger:disabled{opacity:.4;cursor:default}
.oa-link-btn{background:none;border:none;padding:0;font:inherit;font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary,#777);cursor:pointer;text-align:left;width:fit-content}
.oa-link-btn:hover{color:var(--dsw-alias-label-primary,inherit);text-decoration:underline}
.oa-auth-box{display:flex;flex-direction:column;gap:8px;padding:10px 12px;border-radius:8px;border:.5px solid var(--dsw-alias-border-l3,rgba(127,127,127,.3));background:var(--dsw-alias-bg-layer-3,rgba(127,127,127,.04))}
.oa-auth-msg{margin:0;font-size:12px;line-height:18px;color:var(--dsw-alias-label-primary,inherit)}
.oa-auth-link{font-size:12px;line-height:18px;color:var(--dsw-alias-link,#4d6bfe);text-decoration:underline;width:fit-content}
.oa-error{margin:0;font-size:12px;line-height:18px;color:var(--dsw-alias-state-error-primary,#dc2626)}
.oa-success{margin:0;font-size:12px;line-height:18px;color:var(--dsw-alias-state-success-primary,#16a34a)}
.oa-advanced{display:flex;flex-direction:column;gap:10px;padding-top:8px;border-top:.5px solid var(--dsw-alias-border-l2,rgba(127,127,127,.2))}
`

interface BrowserGlobals {
  document?: {
    head?: { appendChild(node: unknown): void }
    querySelector(selector: string): unknown
    createElement(tag: string): {
      dataset: Record<string, string>
      textContent: string
    }
  }
  window?: {
    open(url: string, target?: string, features?: string): unknown
    setInterval(fn: () => void, ms: number): number
    clearInterval(id: number): void
  }
}

function ensureStyle(): void {
  const g = globalThis as unknown as BrowserGlobals
  const doc = g.document
  if (!doc || !doc.head) return
  if (doc.querySelector(`style[data-plugin-css=${JSON.stringify(STYLE_ID)}]`) !== null) return
  const tag = doc.createElement("style")
  tag.dataset.plugin = "@eliotstocker/open-harness-plugin-openai-compatible-auto"
  tag.dataset.pluginCss = STYLE_ID
  tag.textContent = CARD_CSS
  doc.head.appendChild(tag)
}

function openExternalUrl(url: string): void {
  const g = globalThis as unknown as BrowserGlobals
  g.window?.open(url, "_blank", "noopener,noreferrer")
}

function formatSpend(user: StatusSnapshot["user"]): string {
  if (!user || user.effectiveSpendUsd === undefined || user.monthlyCapUsd === undefined) return ""
  return ` ($${user.effectiveSpendUsd.toFixed(2)}/$${user.monthlyCapUsd.toFixed(0)})`
}

export function apply(ctx: DshClientContext): void {
  let resetSeq = 0
  const resetListeners = new Set<() => void>()

  ctx.effect(
    () =>
      ctx.on("connection/reset", () => {
        resetSeq += 1
        for (const fn of [...resetListeners]) fn()
      }),
    "openai-auto: connection reset",
  )

  const rpc = async (endpoint: string, payload: Record<string, unknown> = {}): Promise<StatusSnapshot> => {
    const res = await ctx.connection.rpc.call("/api", endpoint, payload)
    if (!res.ok) {
      throw new Error(res.error.message || `Request failed (${res.error.code})`)
    }
    return res.value as StatusSnapshot
  }

  function OpenAIAutoCard(): React.ReactNode {
    const h = React.createElement
    const [status, setStatus] = React.useState<StatusSnapshot | null>(null)
    const [urlInput, setUrlInput] = React.useState("")
    const [urlDirty, setUrlDirty] = React.useState(false)
    const [showAdvanced, setShowAdvanced] = React.useState(false)
    const [teamInput, setTeamInput] = React.useState("")
    const [apiKeyInput, setApiKeyInput] = React.useState("")
    const [promptInput, setPromptInput] = React.useState("")
    const [busy, setBusy] = React.useState(false)
    const [error, setError] = React.useState<string | null>(null)
    const [banner, setBanner] = React.useState<string | null>(null)
    const [connTick, setConnTick] = React.useState(resetSeq)

    const openedUrlRef = React.useRef<string | null>(null)
    const wasInFlightRef = React.useRef(false)
    const lastPromptIdRef = React.useRef<string | null>(null)

    React.useEffect(() => {
      ensureStyle()
    }, [])

    React.useEffect(() => {
      const listener = () => setConnTick(resetSeq)
      resetListeners.add(listener)
      return () => {
        resetListeners.delete(listener)
      }
    }, [])

    const applySnapshot = React.useCallback(
      (snap: StatusSnapshot) => {
        setStatus(snap)
        if (!urlDirty && snap.baseURL) {
          setUrlInput(snap.baseURL)
        }
        const noticeUrl = snap.login?.inFlight ? snap.login.notice?.url : undefined
        if (noticeUrl && openedUrlRef.current !== noticeUrl) {
          openedUrlRef.current = noticeUrl
          openExternalUrl(noticeUrl)
        }
        if (!snap.login?.inFlight) {
          openedUrlRef.current = null
        }
        const promptId = snap.login?.prompt?.id ?? null
        if (promptId !== lastPromptIdRef.current) {
          lastPromptIdRef.current = promptId
          setPromptInput("")
        }
        if (wasInFlightRef.current && !snap.login?.inFlight) {
          if (snap.login?.outcome === "authorized") {
            setBanner("Signed in successfully.")
            setError(null)
            setUrlDirty(false)
            setApiKeyInput("")
          } else if (snap.login?.outcome === "failed" && snap.login.error) {
            setError(snap.login.error)
          }
        }
        wasInFlightRef.current = Boolean(snap.login?.inFlight)
      },
      [urlDirty],
    )

    const loadStatus = React.useCallback(async () => {
      try {
        const snap = await rpc("openai-auto.status")
        applySnapshot(snap)
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err))
      }
    }, [applySnapshot])

    React.useEffect(() => {
      void loadStatus()
    }, [loadStatus, connTick])

    const inFlight = Boolean(status?.login?.inFlight)

    React.useEffect(() => {
      if (!inFlight) return
      const win = (globalThis as unknown as BrowserGlobals).window
      if (!win) return
      const id = win.setInterval(() => {
        void loadStatus()
      }, 600)
      return () => {
        win.clearInterval(id)
      }
    }, [inFlight, loadStatus])

    const trimmedUrl = urlInput.trim()

    const startLogin = async (method: "litellm-cli" | "api-key") => {
      if (!trimmedUrl || busy || inFlight) return
      setBusy(true)
      setError(null)
      setBanner(null)
      openedUrlRef.current = null
      wasInFlightRef.current = true
      try {
        const snap = await rpc("openai-auto.login", {
          baseURL: trimmedUrl,
          method,
          ...(teamInput.trim() ? { team: teamInput.trim() } : {}),
          ...(method === "api-key" && apiKeyInput.trim() ? { apiKey: apiKeyInput.trim() } : {}),
        })
        applySnapshot(snap)
      } catch (err) {
        wasInFlightRef.current = false
        setError(err instanceof Error ? err.message : String(err))
      } finally {
        setBusy(false)
      }
    }

    const submitPrompt = async () => {
      const promptId = status?.login?.prompt?.id
      if (!promptId || busy) return
      setBusy(true)
      setError(null)
      try {
        const snap = await rpc("openai-auto.respond", { id: promptId, value: promptInput })
        applySnapshot(snap)
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err))
      } finally {
        setBusy(false)
      }
    }

    const cancelLogin = async () => {
      setBusy(true)
      try {
        const snap = await rpc("openai-auto.cancel")
        applySnapshot(snap)
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err))
      } finally {
        setBusy(false)
      }
    }

    const logout = async () => {
      setBusy(true)
      setError(null)
      setBanner(null)
      try {
        const snap = await rpc("openai-auto.logout")
        setUrlDirty(false)
        setUrlInput(snap.baseURL)
        applySnapshot(snap)
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err))
      } finally {
        setBusy(false)
      }
    }

    const refresh = async () => {
      setBusy(true)
      setError(null)
      setBanner(null)
      try {
        const snap = await rpc("openai-auto.refresh")
        applySnapshot(snap)
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err))
      } finally {
        setBusy(false)
      }
    }

    const statusLabel = (() => {
      if (!status) return "Loading status…"
      if (status.signedIn) {
        const who = status.user?.email ? ` · ${status.user.email}${formatSpend(status.user)}` : ""
        const kind = status.authKind === "oauth" ? "Signed in" : "Connected"
        return `${kind}${who} · ${status.modelCount} model${status.modelCount === 1 ? "" : "s"}`
      }
      if (status.authKind === "config") {
        return `Configured via settings · ${status.modelCount} model${status.modelCount === 1 ? "" : "s"}`
      }
      return "Enter your server URL and sign in to discover models."
    })()

    const activeLogin = status?.login?.inFlight ? status.login : null

    return h(
      "div",
      { className: "oa-card" },
      h(
        "div",
        { className: "oa-status" },
        h(
          "span",
          { className: "oa-status-main" },
          h("span", {
            className: `oa-dot${status?.signedIn || (status && status.modelCount > 0) ? " oa-dot-ok" : ""}`,
          }),
          h("span", null, statusLabel),
        ),
        status && (status.signedIn || status.authKind === "config")
          ? h(
              "span",
              { className: "oa-status-actions" },
              h(
                "button",
                {
                  type: "button",
                  className: "oa-btn-secondary oa-btn-sm",
                  disabled: busy || inFlight,
                  onClick: () => void refresh(),
                },
                "Refresh",
              ),
              status.signedIn
                ? h(
                    "button",
                    {
                      type: "button",
                      className: "oa-btn-danger oa-btn-sm",
                      disabled: busy || inFlight,
                      onClick: () => void logout(),
                    },
                    "Sign out",
                  )
                : null,
            )
          : null,
      ),
      h(
        "div",
        { className: "oa-field" },
        h("label", { className: "oa-label", htmlFor: "oa-server-url" }, "Server URL"),
        h(
          "div",
          { className: "oa-row" },
          h("input", {
            id: "oa-server-url",
            className: "oa-input",
            type: "url",
            placeholder: "https://llm.example.com",
            value: urlInput,
            disabled: busy || inFlight,
            onChange: (e: { target: { value: string } }) => {
              setUrlDirty(true)
              setUrlInput(e.target.value)
            },
            onKeyDown: (e: { key: string; preventDefault(): void }) => {
              if (e.key === "Enter" && trimmedUrl && !busy && !inFlight) {
                e.preventDefault()
                void startLogin("litellm-cli")
              }
            },
          }),
          h(
            "button",
            {
              type: "button",
              className: "oa-btn-primary",
              disabled: !trimmedUrl || busy || inFlight,
              onClick: () => void startLogin("litellm-cli"),
            },
            inFlight ? "Signing in…" : "Sign in",
          ),
        ),
      ),
      activeLogin
        ? h(
            "div",
            { className: "oa-auth-box" },
            h(
              "p",
              { className: "oa-auth-msg" },
              activeLogin.notice?.message ?? "Starting interactive sign-in…",
            ),
            activeLogin.notice?.code
              ? h("p", { className: "oa-auth-msg" }, `Code: ${activeLogin.notice.code}`)
              : null,
            activeLogin.notice?.url
              ? h(
                  "a",
                  {
                    className: "oa-auth-link",
                    href: activeLogin.notice.url,
                    target: "_blank",
                    rel: "noopener noreferrer",
                  },
                  "Open sign-in page",
                )
              : null,
            activeLogin.prompt
              ? h(
                  "div",
                  { className: "oa-field" },
                  h("label", { className: "oa-label" }, activeLogin.prompt.message),
                  h(
                    "div",
                    { className: "oa-row" },
                    h("input", {
                      className: "oa-input",
                      type: activeLogin.prompt.kind === "secret" ? "password" : "text",
                      placeholder: activeLogin.prompt.placeholder ?? "",
                      value: promptInput,
                      disabled: busy,
                      onChange: (e: { target: { value: string } }) => setPromptInput(e.target.value),
                      onKeyDown: (e: { key: string; preventDefault(): void }) => {
                        if (e.key === "Enter" && !busy) {
                          e.preventDefault()
                          void submitPrompt()
                        }
                      },
                    }),
                    h(
                      "button",
                      {
                        type: "button",
                        className: "oa-btn-primary",
                        disabled: busy || !promptInput.trim(),
                        onClick: () => void submitPrompt(),
                      },
                      "Submit",
                    ),
                  ),
                )
              : null,
            h(
              "div",
              { className: "oa-row" },
              h(
                "button",
                {
                  type: "button",
                  className: "oa-btn-secondary oa-btn-sm",
                  disabled: busy,
                  onClick: () => void cancelLogin(),
                },
                "Cancel",
              ),
            ),
          )
        : null,
      h(
        "button",
        {
          type: "button",
          className: "oa-link-btn",
          onClick: () => setShowAdvanced((v) => !v),
        },
        showAdvanced ? "Hide API key / team options" : "Use API key, local endpoint, or team",
      ),
      showAdvanced
        ? h(
            "div",
            { className: "oa-advanced" },
            h(
              "div",
              { className: "oa-field" },
              h("label", { className: "oa-label", htmlFor: "oa-team" }, "LiteLLM team (optional, for browser sign-in)"),
              h("input", {
                id: "oa-team",
                className: "oa-input",
                type: "text",
                placeholder: "Leave blank if not required",
                value: teamInput,
                disabled: busy || inFlight,
                onChange: (e: { target: { value: string } }) => setTeamInput(e.target.value),
              }),
            ),
            h(
              "div",
              { className: "oa-field" },
              h("label", { className: "oa-label", htmlFor: "oa-api-key" }, "API key (optional for local endpoints)"),
              h(
                "div",
                { className: "oa-row" },
                h("input", {
                  id: "oa-api-key",
                  className: "oa-input",
                  type: "password",
                  autoComplete: "off",
                  placeholder: "sk-...",
                  value: apiKeyInput,
                  disabled: busy || inFlight,
                  onChange: (e: { target: { value: string } }) => setApiKeyInput(e.target.value),
                }),
                h(
                  "button",
                  {
                    type: "button",
                    className: "oa-btn-secondary",
                    disabled: !trimmedUrl || busy || inFlight,
                    onClick: () => void startLogin("api-key"),
                  },
                  "Connect with API key",
                ),
              ),
            ),
          )
        : null,
      error ? h("p", { className: "oa-error", role: "alert" }, error) : null,
      banner ? h("p", { className: "oa-success", role: "status" }, banner) : null,
    )
  }

  ctx.slots.inject("settings.models.provider-card", () =>
    ctx.slots.register(
      { name: "settings.models.provider-card", key: "openai-auto" },
      OpenAIAutoCard,
    ),
  )
}
