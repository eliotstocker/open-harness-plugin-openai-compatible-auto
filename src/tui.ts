import { Plugin } from "@opencode/plugin/tui"
import { createElement, insert, setProp } from "@opentui/solid"
import { createSignal, onCleanup } from "solid-js"
import { formatUserStatusText, readGatewayStatus, safeHttpUrl } from "./core/state.js"

export const plugin = Plugin.define({
  id: "openai-auto",
  setup(context) {
    const [status, setStatus] = createSignal(readGatewayStatus())

    const interval = setInterval(() => {
      const next = readGatewayStatus()
      setStatus((prev) => {
        if (!prev && !next) return prev
        if (prev?.updatedAt === next?.updatedAt && prev?.usageUrl === next?.usageUrl) return prev
        return next
      })
    }, 4000)

    onCleanup(() => {
      clearInterval(interval)
    })

    context.ui.slot({
      append: "sidebar.footer",
      render: () => {
        const text = formatUserStatusText(status())
        if (!text) return null
        const el = createElement("text")
        insert(el, () => {
          const s = status()
          const line = formatUserStatusText(s)
          if (!line) return ""
          const url = safeHttpUrl(s?.usageUrl)
          if (!url) return line
          const link = createElement("a")
          setProp(link, "href", url)
          setProp(link, "style", { underline: true })
          insert(link, "Usage ↗")
          return [line, " · ", link]
        })
        return el as any
      },
    })
  },
})

export default plugin
