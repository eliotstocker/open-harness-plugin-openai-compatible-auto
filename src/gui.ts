import { existsSync, readFileSync } from "node:fs"
import { homedir, tmpdir } from "node:os"
import { join } from "node:path"
import { Plugin, Slot } from "@opencode/plugin/gui"
import { createEffect, createSignal, onCleanup } from "solid-js"

interface GatewayUserStatus {
  email?: string
  gatewayName?: string
  monthlyCapUsd?: number
  effectiveSpendUsd?: number
  remainingUsd?: number
  updatedAt?: number
}

function getStatusPath(): string {
  const openCodeDir = join(homedir(), ".opencode")
  if (existsSync(openCodeDir)) {
    return join(openCodeDir, "openai-auto-user.json")
  }
  return join(tmpdir(), "opencode-openai-auto-user.json")
}

function readGatewayStatus(): GatewayUserStatus | undefined {
  try {
    const p = getStatusPath()
    if (!existsSync(p)) return undefined
    const raw = readFileSync(p, "utf8")
    const parsed = JSON.parse(raw) as GatewayUserStatus
    if (!parsed || (!parsed.email && parsed.effectiveSpendUsd === undefined && !parsed.gatewayName)) {
      return undefined
    }
    return parsed
  } catch {
    return undefined
  }
}

export const plugin = Plugin.define({
  setup(ctx) {
    const [status, setStatus] = createSignal(readGatewayStatus())

    const interval = setInterval(() => {
      const next = readGatewayStatus()
      setStatus((prev) => {
        if (!prev && !next) return prev
        if (prev?.updatedAt === next?.updatedAt) return prev
        return next
      })
    }, 4000)

    onCleanup(() => {
      clearInterval(interval)
    })

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
          const s = status()
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
