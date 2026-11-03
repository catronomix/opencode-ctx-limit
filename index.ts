import { Plugin } from "@opencode/plugin"

import { estimateTokens, inputBudget, outputBudget, trimMessages, type Message } from "./logic.ts"
import { CtxLimit } from "./rpc.ts"

const STORAGE_KEY = "ctx-limit"
const MIN_LIMIT = 4096

type Settings = { limit: number }

function sanitize(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return 0
  const limit = Math.floor(value)
  return limit >= MIN_LIMIT ? limit : 0
}

export default Plugin.define({
  id: "ctx-limit",
  async setup(ctx) {
    const stored = (await ctx.storage.get(STORAGE_KEY)) as Partial<Settings> | undefined
    const settings: Settings = { limit: sanitize(stored?.limit) }

    // Caps models that do not pin `limit` in config: they keep their own
    // context window, but never above the global cap. Config-pinned models
    // ignore this (their `limit` wins over transforms), so the request hook
    // below is what actually enforces the cap for every model.
    await ctx.model.transform((editor) => {
      const cap = settings.limit
      if (!cap) return
      for (const model of editor.list()) {
        const limit = (model as { limit?: { context?: number; output?: number } }).limit
        if (!limit) continue
        const context = typeof limit.context === "number" ? limit.context : 0
        const output = typeof limit.output === "number" ? limit.output : 0
        if (context <= cap && output <= cap) continue
        editor.update(model.providerID, model.id, (draft) => {
          const target = (draft as { limit?: { context?: number; output?: number } }).limit
          if (!target) return
          if (typeof target.context === "number" && target.context > cap) target.context = cap
          if (typeof target.output === "number" && target.output > cap) target.output = cap
        })
      }
    })

    const trimmedSessions = new Set<string>()

    // Request-time enforcement: the cap is applied to the exact payload about
    // to be sent, so it works whatever `limit` the model config declares. Reads
    // `settings.limit` live, so a new cap applies from the next request on.
    await ctx.session.hook("context", (event) => {
      const cap = settings.limit
      if (!cap) return

      const configured = typeof event.options.maxTokens === "number" ? event.options.maxTokens : undefined
      const output = outputBudget(cap, configured)
      event.options.maxTokens = output

      const budget = inputBudget(cap, output, estimateTokens(event.system))
      const { messages, dropped } = trimMessages(event.messages as Message[], budget)
      if (!dropped) return

      event.messages = messages as typeof event.messages
      if (trimmedSessions.has(event.sessionID)) return
      trimmedSessions.add(event.sessionID)
      console.error(
        `ctx-limit: trimmed ${dropped} message(s) to fit the ${cap} token cap (output ${output})`,
      )
    })

    if (!ctx.rpc) {
      console.error("ctx-limit: ctx.rpc unavailable, menu control disabled")
      return
    }

    let registration: { events: { emit: (name: "changed", data: { limit: number }) => Promise<unknown> } } | undefined

    const commit = async (limit: number) => {
      settings.limit = limit
      await ctx.storage.set(STORAGE_KEY, settings)
      // The cap is saved and enforced from the next request on, so a failing
      // reload or broadcast must not make the menu report the change as lost.
      try {
        // Rebuild the model registry so transform-based caps are up to date.
        await ctx.model.reload()
      } catch (error) {
        console.error("ctx-limit: could not reload the model registry", error)
      }
      try {
        await registration?.events.emit("changed", { limit: settings.limit })
      } catch (error) {
        console.error("ctx-limit: could not broadcast the new cap", error)
      }
      return { limit: settings.limit }
    }

    // One plugin instance exists per location; keep them in step so the menu
    // setting is global rather than per-directory.
    const controller = new AbortController()
    void (async () => {
      try {
        for await (const event of ctx.event.subscribe({ signal: controller.signal })) {
          if (event.type !== "rpc.ctx-limit.changed") continue
          const payload = (event as { data?: { limit?: unknown } }).data
          const limit = sanitize(payload ? payload.limit : (event as { limit?: unknown }).limit)
          if (limit !== settings.limit) settings.limit = limit
        }
      } catch {
        // Aborted on teardown, or no event stream is available.
      }
    })()

    registration = await ctx.rpc.register(CtxLimit, {
      get: async () => ({ limit: settings.limit }),
      set: async (input) => {
        const { limit } = input as { limit: number }
        const next = sanitize(limit)
        if (!next) throw new Error(`context limit must be at least ${MIN_LIMIT} tokens`)
        return commit(next)
      },
      clear: () => commit(0),
    })

    return () => controller.abort()
  },
})
