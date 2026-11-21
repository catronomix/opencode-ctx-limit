/**
 * Local stand-ins for the two runtime helpers this plugin used to import from
 * `@opencode/plugin`.
 *
 * Both are pure functions in the SDK — `Plugin.define` returns its argument
 * unchanged, `Rpc.define` only rejects error names starting with `rpc.` — so
 * there is nothing to keep importing at runtime. Types are still taken from the
 * SDK (type-only imports are erased), which keeps the package signature-checked
 * against the host API while the published package has no dependencies at all.
 *
 * If a future SDK gives these helpers real behaviour, mirror it here: the
 * versions we target are recorded in `devDependencies`.
 */

type ServerDefinition = Parameters<typeof import("@opencode/plugin").Plugin.define>[0]
type TuiDefinition = Parameters<typeof import("@opencode/plugin/tui").Plugin.define>[0]
type RpcDefinition = Parameters<typeof import("@opencode/plugin/rpc").Rpc.define>[0]

/** Mirrors `Plugin.define` from `@opencode/plugin` (server part). */
export function definePlugin<T extends ServerDefinition>(plugin: T): T {
  return plugin
}

/** Mirrors `Plugin.define` from `@opencode/plugin/tui` (terminal part). */
export function defineTuiPlugin<T extends TuiDefinition>(plugin: T): T {
  return plugin
}

/** Mirrors `Rpc.define` from `@opencode/plugin/rpc`, reserved-name check included. */
export function defineRpc<T extends RpcDefinition>(definition: T): T {
  const reserved = Object.values(definition.methods as Record<string, { errors?: Record<string, unknown> }>)
    .flatMap((method) => Object.keys(method.errors ?? {}))
    .find((name) => name.startsWith("rpc."))
  if (reserved) throw new Error(`RPC error names starting with "rpc." are reserved: ${reserved}`)
  return definition
}
