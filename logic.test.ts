import assert from "node:assert/strict"
import { test } from "node:test"

import { describeError, describeLimitError, estimateTokens, inputBudget, outputBudget, sameDirectory, trimMessages, type Message } from "./logic.ts"

const text = (value: string): Message => ({ role: "user", content: [{ type: "text", text: value }] })

test("estimateTokens is ~4 chars per token", () => {
  assert.equal(estimateTokens("abcd"), 1)
  assert.equal(estimateTokens("abcde"), 2)
  assert.equal(estimateTokens(undefined), 0)
})

test("outputBudget caps at a quarter of the limit and honours a lower configured value", () => {
  assert.equal(outputBudget(100_000), 25_000)
  assert.equal(outputBudget(100_000, 64_000), 25_000)
  assert.equal(outputBudget(100_000, 4_000), 4_000)
  assert.equal(outputBudget(1_000_000), 32_768)
  assert.equal(outputBudget(4_096), 1_024)
})

test("inputBudget keeps a floor and subtracts output plus system", () => {
  assert.equal(inputBudget(50_000, 12_500, 5_000), 32_500)
  assert.equal(inputBudget(4_096, 1_024, 10_000), 1_024)
})

test("trimMessages leaves a fitting conversation untouched", () => {
  const messages = [text("a".repeat(40)), text("b".repeat(40))]
  const result = trimMessages(messages, 1_000)
  assert.equal(result.dropped, 0)
  assert.equal(result.messages, messages)
})

test("trimMessages drops whole turns from the front and keeps tool pairs", () => {
  const messages: Message[] = [
    text("a".repeat(4_000)), // turn 1, ~1000 tokens
    { role: "assistant", content: [{ type: "text", text: "b".repeat(4_000) }] },
    { role: "tool", content: [{ type: "tool-result", text: "c".repeat(4_000) }] },
    text("d".repeat(400)), // turn 2, ~100 tokens
    { role: "assistant", content: [{ type: "text", text: "e".repeat(400) }] },
    text("f".repeat(400)), // turn 3, ~100 tokens
  ]
  const result = trimMessages(messages, 500)
  assert.equal(result.dropped, 3)
  assert.deepEqual(
    result.messages.map((message) => message.role),
    ["user", "assistant", "user"],
  )
})

test("trimMessages keeps the newest turn even when it alone is too large", () => {
  const messages = [text("a".repeat(40)), text("b".repeat(4_000))]
  const result = trimMessages(messages, 10)
  assert.equal(result.dropped, 1)
  assert.equal(result.messages.length, 1)
})

test("trimMessages handles a conversation without user turns", () => {
  const messages: Message[] = [{ role: "system", content: [{ type: "text", text: "x".repeat(4_000) }] }]
  const result = trimMessages(messages, 10)
  assert.equal(result.dropped, 0)
})

test("sameDirectory ignores events from other locations", () => {
  assert.equal(sameDirectory("/var/lib/pterodactyl/volumes", "/var/lib/pterodactyl/volumes"), true)
  assert.equal(sameDirectory("/var/lib/pterodactyl/volumes/", "/var/lib/pterodactyl/volumes"), true)
  assert.equal(sameDirectory("/home/me/project", "/home/me/other"), false)
  assert.equal(sameDirectory("C:\\GITHUB", "c:/github"), true)
  assert.equal(sameDirectory("C:\\GITHUB\\", "C:/GITHUB"), true)
  assert.equal(sameDirectory("C:/GITHUB", "D:/GITHUB"), false)
  assert.equal(sameDirectory(undefined, "/home/me/project"), false)
})

test("describeError reads messages from RPC plain objects, not just Error", () => {
  assert.equal(describeError(new Error("boom")), "boom")
  assert.equal(describeError({ type: "rpc.invalid_input", message: "Expected object" }), "Expected object (rpc.invalid_input)")
  assert.equal(describeError({ type: "rpc.internal", message: "" }), "rpc.internal")
  assert.equal(describeError("nope"), "nope")
  assert.equal(describeError(undefined, "fallback"), "fallback")
})

test("describeLimitError explains a missing server part", () => {
  const unavailable = describeLimitError({
    type: "rpc.unavailable",
    message: "RPC is unavailable: ctx-limit",
  })
  assert.match(unavailable, /server part is not running/)
  assert.match(unavailable, /RPC is unavailable: ctx-limit/)

  assert.equal(
    describeLimitError({ type: "rpc.invalid_input", message: "Expected a value greater than or equal to 4096" }),
    "Expected a value greater than or equal to 4096 (rpc.invalid_input)",
  )
  assert.equal(describeLimitError(undefined), "Could not update the cap")
})
