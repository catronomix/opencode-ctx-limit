/**
 * Pure helpers for the ctx-limit plugin: no OpenCode imports, so they can be
 * unit tested with `node --test logic.test.ts`.
 */

/** Never let output eat more than this share of the global cap. */
const OUTPUT_SHARE = 4
const MAX_OUTPUT = 32_768
const MIN_OUTPUT = 1024
const MIN_INPUT = 1024

export type Part = { type?: string; text?: string; [key: string]: unknown }

export type Message = { role: string; content: Part[]; [key: string]: unknown }

/** Cheap provider-agnostic estimate: ~4 characters per token. */
export function estimateTokens(value: unknown): number {
  if (value === undefined || value === null) return 0
  const text = typeof value === "string" ? value : JSON.stringify(value)
  return text ? Math.ceil(text.length / 4) : 0
}

/** Output budget for a cap: a quarter of it, never above 32k, never below 1k. */
export function outputBudget(cap: number, configured?: number): number {
  const wanted = Math.max(MIN_OUTPUT, Math.min(Math.floor(cap / OUTPUT_SHARE), MAX_OUTPUT))
  return configured === undefined ? wanted : Math.min(configured, wanted)
}

/**
 * Drop whole turns from the front until the tail fits `budget`. Cut points are
 * user messages, so assistant tool calls stay paired with their tool results.
 */
export function trimMessages(messages: Message[], budget: number): { messages: Message[]; dropped: number } {
  const sizes = messages.map((message) => estimateTokens(message))
  const tailSize = (from: number) => sizes.slice(from).reduce((total, size) => total + size, 0)
  if (tailSize(0) <= budget) return { messages, dropped: 0 }

  const boundaries = messages
    .map((message, index) => (message.role === "user" ? index : -1))
    .filter((index) => index >= 0)
  if (!boundaries.length) return { messages, dropped: 0 }

  // Keep at least the newest turn, even if it alone exceeds the budget.
  let cut = boundaries[boundaries.length - 1]
  for (const boundary of boundaries) {
    if (tailSize(boundary) <= budget) {
      cut = boundary
      break
    }
  }
  return { messages: messages.slice(cut), dropped: cut }
}

/**
 * Human-readable text for an unknown rejection. RPC calls from the terminal
 * plugin reject with plain `{ type, message, data? }` objects rather than
 * `Error` instances, so `instanceof Error` alone loses every useful detail.
 */
export function describeError(error: unknown, fallback = "Unknown error"): string {
  if (error instanceof Error) return error.message || fallback
  if (typeof error === "string" && error) return error
  if (error && typeof error === "object") {
    const { message, type } = error as { message?: unknown; type?: unknown }
    const label = typeof type === "string" && type ? type : undefined
    if (typeof message === "string" && message) return label ? `${message} (${label})` : message
    if (label) return label
  }
  return fallback
}

/** Explain a failed cap change, including when the server part is not loaded. */
export function describeLimitError(error: unknown): string {
  const fallback = "Could not update the cap"
  const detail = describeError(error, fallback)
  const type = error && typeof error === "object" ? (error as { type?: unknown }).type : undefined
  if (type === "rpc.unavailable") {
    return `The ctx-limit server part is not running at this location, so the cap cannot be changed. ${detail}`
  }
  return detail
}

/** Input tokens allowed for messages once output and the system prompt are paid for. */
export function inputBudget(cap: number, output: number, systemTokens: number): number {
  return Math.max(MIN_INPUT, cap - output - systemTokens)
}
