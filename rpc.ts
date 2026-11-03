import { Rpc } from "@opencode/plugin/rpc"

const limitSchema = {
  type: "object",
  properties: { limit: { type: "number", minimum: 0 } },
  required: ["limit"],
  additionalProperties: false,
} as const

// Declared explicitly (rather than omitted) because the RPC layer expects an
// input schema object for every method, including argument-less ones.
const noInput = {
  type: "object",
  properties: {},
  additionalProperties: false,
} as const

/**
 * Shared contract between the server plugin (index.ts) and the terminal plugin
 * (tui.ts). `limit` is the global max context cap in tokens; 0 means "no cap"
 * (every model keeps its configured limit).
 */
export const CtxLimit = Rpc.define({
  id: "ctx-limit",
  methods: {
    get: { input: noInput, output: limitSchema },
    set: {
      input: {
        type: "object",
        properties: { limit: { type: "number", minimum: 4096 } },
        required: ["limit"],
        additionalProperties: false,
      },
      output: limitSchema,
    },
    clear: { input: noInput, output: limitSchema },
  },
  events: {
    changed: { schema: limitSchema },
  },
})
