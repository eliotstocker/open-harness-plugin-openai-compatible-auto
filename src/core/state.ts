import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { homedir, tmpdir } from "node:os"
import { join } from "node:path"
import type { GatewayUserInfo } from "./discovery.js"

export interface GatewayUserStatus extends GatewayUserInfo {
  updatedAt: number
}

function getStatusPath(): string {
  const openCodeDir = join(homedir(), ".opencode")
  if (existsSync(openCodeDir)) {
    return join(openCodeDir, "openai-auto-user.json")
  }
  try {
    mkdirSync(openCodeDir, { recursive: true })
    return join(openCodeDir, "openai-auto-user.json")
  } catch {
    return join(tmpdir(), "opencode-openai-auto-user.json")
  }
}

export function saveGatewayStatus(info?: GatewayUserInfo): void {
  try {
    const p = getStatusPath()
    if (!info) {
      try {
        writeFileSync(p, JSON.stringify({ updatedAt: Date.now() }), "utf8")
      } catch {}
      return
    }
    const status: GatewayUserStatus = {
      ...info,
      updatedAt: Date.now(),
    }
    writeFileSync(p, JSON.stringify(status, null, 2), "utf8")
  } catch {}
}

export function readGatewayStatus(): GatewayUserStatus | undefined {
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

export function formatUserStatusText(status?: GatewayUserInfo): string {
  if (!status) return ""
  const parts: string[] = []
  if (status.email) {
    parts.push(status.email)
  } else if (status.gatewayName) {
    parts.push(status.gatewayName)
  }

  if (status.effectiveSpendUsd !== undefined && status.monthlyCapUsd !== undefined) {
    parts.push(`$${status.effectiveSpendUsd.toFixed(2)} / $${status.monthlyCapUsd.toFixed(0)}`)
    if (status.remainingUsd !== undefined) {
      parts.push(`($${status.remainingUsd.toFixed(2)} left)`)
    }
  } else if (status.effectiveSpendUsd !== undefined) {
    parts.push(`Spend: $${status.effectiveSpendUsd.toFixed(2)}`)
  }

  return parts.join(" · ")
}

export function safeHttpUrl(raw: unknown): string | undefined {
  if (typeof raw !== "string" || !raw.trim()) return undefined
  try {
    const parsed = new URL(raw.trim())
    return parsed.protocol === "https:" || parsed.protocol === "http:" ? parsed.href : undefined
  } catch {
    return undefined
  }
}
