import { Plugin } from "@opencode/plugin/tui"
import { createSignal, onCleanup } from "solid-js"
import { formatUserStatusText, readGatewayStatus } from "./core/state.js"

export const plugin = Plugin.define({
  id: "openai-auto",
  setup(context) {
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

    context.ui.slot({
      append: "sidebar.footer",
      render: () => {
        const text = formatUserStatusText(status())
        if (!text) return null
        return text
      },
    })
  },
})

export default plugin
