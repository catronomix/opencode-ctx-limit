import { Plugin } from "@opencode/plugin/tui"

import { describeError, describeLimitError, sameDirectory } from "./logic.ts"
import { CtxLimit } from "./rpc.ts"

const MIN_LIMIT = 4096
const PRESETS = [64_000, 100_000, 128_000, 160_000, 200_000, 256_000]

function format(tokens: number) {
  if (tokens <= 0) return "no limit"
  if (tokens % 1000 === 0) return `${tokens / 1000}k tokens`
  return `${tokens.toLocaleString("en-US")} tokens`
}

function parse(text: string | undefined) {
  if (!text) return undefined
  const cleaned = text.trim().toLowerCase().replace(/[\s,_]|tokens?$/g, "")
  const match = cleaned.match(/^(\d+(?:\.\d+)?)(k|m)?$/)
  if (!match) return undefined
  let tokens = Number(match[1])
  if (match[2] === "k") tokens *= 1_000
  if (match[2] === "m") tokens *= 1_000_000
  const limit = Math.floor(tokens)
  if (!Number.isFinite(limit) || limit < MIN_LIMIT) return undefined
  return limit
}

type Limit = { limit: number }

export default Plugin.define({
  id: "ctx-limit.tui",
  async setup(context) {
    // Every RPC call must name the location this plugin instance runs in.
    // Without it the client falls back to the server's working directory,
    // which is usually a different location than the one the TUI is in, so
    // the server part looks unregistered (`rpc.unavailable`).
    const location = context.location ?? context.data.location.default()
    const options = { location }

    const rpc = context.client.rpc(CtxLimit) as unknown as {
      get(input: Record<string, never>, options?: { location: typeof location }): Promise<Limit>
      set(input: { limit: number }, options?: { location: typeof location }): Promise<Limit>
      clear(input: Record<string, never>, options?: { location: typeof location }): Promise<Limit>
      events: { on(name: "changed", listener: (event: { data: Limit }) => void): () => void }
    }

    const [state, update] = context.storage.memory("ctx-limit", { initial: { limit: 0 } as Limit })

    const sync = async () => {
      try {
        const result = await rpc.get({}, options)
        update((draft) => {
          draft.limit = Number(result?.limit ?? 0) || 0
        })
      } catch (error) {
        console.error("ctx-limit: could not read the current cap", describeError(error, "unknown error"), error)
      }
    }

    void sync()

    const unsubscribe = rpc.events.on("changed", (event) => {
      // Events are broadcast to every location on the server; applying
      // another project's cap would show the wrong number here.
      const from = (event as { location?: { directory?: string } } | undefined)?.location?.directory
      if (from && !sameDirectory(from, location.directory)) return
      update((draft) => {
        draft.limit = Number(event?.data?.limit ?? 0) || 0
      })
    })

    const setLimit = async (limit: number) => {
      try {
        const result = limit > 0 ? await rpc.set({ limit }, options) : await rpc.clear({}, options)
        const applied = Number(result?.limit ?? 0) || 0
        update((draft) => {
          draft.limit = applied
        })
        context.ui.toast.show({
          title: "Global context limit",
          message:
            applied > 0
              ? `Models capped at ${format(applied)}. Requests already in flight keep their old budget.`
              : "Cap removed. Models use their configured context windows again.",
          variant: "success",
        })
      } catch (error) {
        console.error("ctx-limit: could not update the cap", describeError(error, "unknown error"), error)
        context.ui.toast.show({
          title: "Global context limit",
          message: describeLimitError(error),
          variant: "error",
        })
      }
    }

    const pickLimit = async () => {
      const current = state.limit
      const choice = await context.ui.dialog.select({
        title: `Global max context${current > 0 ? ` (now ${format(current)})` : ""}`,
        current: current > 0 ? String(current) : "none",
        options: [
          ...PRESETS.map((tokens) => ({
            title: format(tokens),
            value: String(tokens),
            description: tokens === current ? "current" : undefined,
          })),
          { title: "Custom…", value: "custom", category: "Advanced" },
          { title: "No limit", value: "none", category: "Advanced" },
        ],
      })
      if (!choice) return
      if (choice === "none") return setLimit(0)
      if (choice !== "custom") return setLimit(Number(choice))

      const typed = await context.ui.dialog.prompt({
        title: "Max context tokens",
        placeholder: "128000 or 128k",
      })
      if (!typed) return
      const limit = parse(typed)
      if (!limit) {
        context.ui.toast.show({
          title: "Global context limit",
          message: `Enter a token count of at least ${MIN_LIMIT} (for example 128k).`,
          variant: "error",
        })
        return
      }
      return setLimit(limit)
    }

    context.keymap.layer(() => ({
      mode: "global",
      commands: [
        {
          id: "ctx-limit.set",
          title: "Set global max context",
          group: "Context",
          palette: true,
          slash: { name: "ctxmax", arguments: true },
          enabled: () => true,
          suggested: true,
          run: async (input) => {
            const direct = parse(input)
            if (direct) return setLimit(direct)
            return pickLimit()
          },
        },
        {
          id: "ctx-limit.clear",
          title: "Clear global max context",
          group: "Context",
          palette: true,
          enabled: () => state.limit > 0,
          run: () => setLimit(0),
        },
      ],
    }))

    return () => unsubscribe()
  },
})
