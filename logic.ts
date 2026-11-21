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

/**
 * Compare two location directories. RPC events are broadcast to every
 * location on the server, so listeners must ignore events from elsewhere.
 * `.` and `..` segments are resolved and either separator is accepted, so an
 * equivalent path written differently still matches. Windows paths are
 * case-insensitive.
 */
export function sameDirectory(a: unknown, b: unknown): boolean {
  if (typeof a !== "string" || typeof b !== "string") return false
  const normalize = (raw: string): string => {
    const path = raw.replace(/\\/g, "/")
    const absolute = path.startsWith("/")
    const parts: string[] = []
    for (const part of path.split("/")) {
      if (!part || part === ".") continue
      if (part === "..") {
        // Never pop past a POSIX root or a Windows drive prefix.
        const atRoot = parts.length === 0 || (parts.length === 1 && /^[a-zA-Z]:$/.test(parts[0]))
        if (!atRoot) parts.pop()
        continue
      }
      parts.push(part)
    }
    return absolute ? `/${parts.join("/")}` : parts.join("/")
  }
  const left = normalize(a)
  const right = normalize(b)
  if (!left || !right || left === "/" || right === "/") return false
  const windows = /^[a-zA-Z]:\//.test(left) || /^[a-zA-Z]:\//.test(right)
  return windows ? left.toLowerCase() === right.toLowerCase() : left === right
}

/**
 * Input tokens allowed for messages once output and the system prompt are paid
 * for. The result never exceeds `cap`, even when the system prompt alone would
 * overflow it: the 1k floor is itself clamped to the cap.
 */
export function inputBudget(cap: number, output: number, systemTokens: number): number {
  const remaining = cap - output - systemTokens
  const floor = Math.min(MIN_INPUT, cap)
  return Math.max(0, Math.min(Math.max(remaining, floor), cap))
}

/* ------------------------------------------------------------------ *
 * Shrinking: give up the cheapest context first.
 *
 * Trimming user turns is the last resort, not the first. Before a single
 * message is dropped, three passes try to pay for the budget out of material
 * the model rarely needs verbatim: oversized tool output, tool output that was
 * already read later in the session, and prose from older assistant turns.
 *
 * Every pass is pure, deterministic, and never touches a `user` message or a
 * tool-call part, so assistant tool calls stay paired with their results.
 * ------------------------------------------------------------------ */

/** Tool output longer than this is a candidate for elision. */
const SHRINK_TOOL_CHARS = 4_000
/** Elided tool output keeps this much of the head… */
const KEEP_HEAD = 1_200
/** …and this much of the tail, where errors and summaries usually land. */
const KEEP_TAIL = 800
/** Duplicate detection ignores tool output shorter than this. */
const DEDUPE_MIN_CHARS = 200
/** Older assistant prose is cut to this many characters. */
const SHRINK_ASSISTANT_CHARS = 400
/** Only assistant text longer than this is worth cutting. */
const SHRINK_ASSISTANT_MIN = 800

/**
 * `1` elides oversized tool output, `2` additionally elides repeated tool
 * output, `3` additionally shortens prose in older assistant turns. Callers
 * escalate one level at a time and stop as soon as the payload fits.
 */
export type ShrinkLevel = 1 | 2 | 3

export type ShrinkResult = { messages: Message[]; elided: number }

const elide = (text: string, head: number, tail: number, note: string): string => {
  const marker = `\n… [ctx-limit: ${note}] …\n`
  return tail > 0 ? `${text.slice(0, head)}${marker}${text.slice(-tail)}` : `${text.slice(0, head)}${marker}`
}

const copyMessage = (message: Message, content: Part[]): Message => ({ ...message, content })

/** Rewrite every message whose parts the mapper changes; otherwise reuse it. */
function rewrite(messages: Message[], map: (message: Message, index: number) => Message | undefined): {
  messages: Message[]
  elided: number
} {
  let elided = 0
  const next = messages.map((message, index) => {
    const replacement = map(message, index)
    if (!replacement) return message
    elided++
    return replacement
  })
  return { messages: elided ? next : messages, elided }
}

export function shrinkMessages(messages: Message[], level: ShrinkLevel): ShrinkResult {
  if (!Array.isArray(messages) || !messages.length) return { messages, elided: 0 }

  if (level === 1) {
    return rewrite(messages, (message) => {
      if (message.role !== "tool" || !Array.isArray(message.content)) return undefined
      let changed = false
      const content = message.content.map((part) => {
        const text = typeof part.text === "string" ? part.text : undefined
        if (!text || text.length <= SHRINK_TOOL_CHARS) return part
        changed = true
        return { ...part, text: elide(text, KEEP_HEAD, KEEP_TAIL, `elided ${text.length - KEEP_HEAD - KEEP_TAIL} chars of tool output`) }
      })
      return changed ? copyMessage(message, content) : undefined
    })
  }

  if (level === 2) {
    const seen = new Map<string, number>()
    messages.forEach((message, index) => {
      if (message.role !== "tool" || !Array.isArray(message.content)) return
      for (const part of message.content) {
        const text = typeof part.text === "string" ? part.text : undefined
        if (!text || text.length < DEDUPE_MIN_CHARS) continue
        seen.set(text, index)
      }
    })
    return rewrite(messages, (message, index) => {
      if (message.role !== "tool" || !Array.isArray(message.content)) return undefined
      let changed = false
      const content = message.content.map((part) => {
        const text = typeof part.text === "string" ? part.text : undefined
        if (!text || text.length < DEDUPE_MIN_CHARS) return part
        // Keep the newest copy: later reads are the ones the model just acted on.
        if (seen.get(text) === index) return part
        changed = true
        return { ...part, text: `[ctx-limit: ${text.length} chars of tool output elided, identical to a later result]` }
      })
      return changed ? copyMessage(message, content) : undefined
    })
  }

  const lastAssistant = messages.reduce((last, message, index) => (message.role === "assistant" ? index : last), -1)
  return rewrite(messages, (message, index) => {
    if (message.role !== "assistant" || index === lastAssistant || !Array.isArray(message.content)) return undefined
    let changed = false
    const content = message.content.map((part) => {
      // Tool-call parts are structural: dropping them breaks result pairing.
      if (part.type !== "text") return part
      const text = typeof part.text === "string" ? part.text : undefined
      if (!text || text.length <= SHRINK_ASSISTANT_MIN) return part
      changed = true
      return { ...part, text: elide(text, SHRINK_ASSISTANT_CHARS, 0, `elided ${text.length - SHRINK_ASSISTANT_CHARS} chars of earlier assistant text`) }
    })
    return changed ? copyMessage(message, content) : undefined
  })
}
