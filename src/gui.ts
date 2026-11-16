import { existsSync, readFileSync } from "node:fs"
import { homedir, tmpdir } from "node:os"
import { join } from "node:path"
import { Ipc, Plugin, Slot } from "@opencode/plugin/gui"
import { Schema } from "effect"
import { createEffect } from "solid-js"

const GatewayUserStatusSchema = Schema.Struct({
  email: Schema.optional(Schema.String),
  gatewayName: Schema.optional(Schema.String),
  monthlyCapUsd: Schema.optional(Schema.Number),
  effectiveSpendUsd: Schema.optional(Schema.Number),
  remainingUsd: Schema.optional(Schema.Number),
  updatedAt: Schema.optional(Schema.Number),
})

type GatewayUserStatus = typeof GatewayUserStatusSchema.Type

const UserStatusIpc = Ipc.define({
  id: "openai-auto.user-status",
  state: Schema.NullOr(GatewayUserStatusSchema),
  methods: {},
})

function getStatusPath(): string {
  const openCodeDir = join(homedir(), ".opencode")
  if (existsSync(openCodeDir)) {
    return join(openCodeDir, "openai-auto-user.json")
  }
  return join(tmpdir(), "opencode-openai-auto-user.json")
}

function readGatewayStatus(): GatewayUserStatus | null {
  try {
    const p = getStatusPath()
    if (!existsSync(p)) return null
    const raw = readFileSync(p, "utf8")
    const parsed = JSON.parse(raw) as GatewayUserStatus
    if (!parsed || (!parsed.email && parsed.effectiveSpendUsd === undefined && !parsed.gatewayName)) {
      return null
    }
    return parsed
  } catch {
    return null
  }
}

function hasStatusChanged(prev: GatewayUserStatus | null, next: GatewayUserStatus | null): boolean {
  if (prev === next) return false
  if (!prev || !next) return true
  return prev.updatedAt !== next.updatedAt
}

export const plugin = Plugin.define({
  main(ctx) {
    let current = readGatewayStatus()

    const provider = ctx.provide(UserStatusIpc, {
      state: () => current,
    })

    const interval = setInterval(() => {
      const next = readGatewayStatus()
      if (!hasStatusChanged(current, next)) return
      current = next
      provider.changed()
    }, 4000)

    return () => {
      clearInterval(interval)
      provider.dispose()
    }
  },
  setup(ctx) {
    const userStatus = ctx.main(UserStatusIpc)

    ctx.add(Slot, {
      at: "window.bottom",
      render: () => {
        const root = document.createElement("div")
        root.className = "openai-auto-bottom-bar"
        root.style.display = "none"
        root.style.alignItems = "center"
        root.style.justifyContent = "space-between"
        root.style.height = "22px"
        root.style.padding = "0 12px"
        root.style.fontSize = "11px"
        root.style.lineHeight = "22px"
        root.style.color = "var(--text-muted, rgba(127, 127, 127, 0.8))"
        root.style.borderTop = "0.5px solid var(--border-subtle, rgba(127, 127, 127, 0.15))"
        root.style.boxSizing = "border-box"
        root.style.userSelect = "none"

        const left = document.createElement("span")
        left.style.display = "inline-flex"
        left.style.alignItems = "center"
        left.style.gap = "6px"

        const right = document.createElement("span")
        right.style.display = "inline-flex"
        right.style.alignItems = "center"
        right.style.gap = "6px"

        root.appendChild(left)
        root.appendChild(right)

        createEffect(() => {
          const s = userStatus.state()
          if (!s || (!s.email && s.effectiveSpendUsd === undefined && !s.gatewayName)) {
            root.style.display = "none"
            return
          }
          root.style.display = "flex"

          const leftParts = [s.gatewayName, s.email].filter(Boolean)
          left.textContent = leftParts.length > 0 ? `👤 ${leftParts.join(" · ")}` : ""

          const rightParts: string[] = []
          if (s.effectiveSpendUsd !== undefined && s.monthlyCapUsd !== undefined) {
            rightParts.push(`$${s.effectiveSpendUsd.toFixed(2)} / $${s.monthlyCapUsd.toFixed(0)}`)
            if (s.remainingUsd !== undefined) {
              rightParts.push(`($${s.remainingUsd.toFixed(2)} left)`)
            }
          } else if (s.effectiveSpendUsd !== undefined) {
            rightParts.push(`Spend: $${s.effectiveSpendUsd.toFixed(2)}`)
          }
          right.textContent = rightParts.join(" ")
        })

        return root
      },
    })
  },
})

export default plugin
