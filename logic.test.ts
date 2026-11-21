import assert from "node:assert/strict"
import { test } from "node:test"

import { describeError, describeLimitError, estimateTokens, inputBudget, outputBudget, sameDirectory, shrinkMessages, trimMessages, type Message } from "./logic.ts"

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

test("inputBudget never exceeds the cap", () => {
  for (const [cap, output, system] of [
    [4_096, 1_024, 10_000],
    [2_000, 1_900, 500],
    [8_192, 8_192, 0],
    [100_000, 25_000, 200_000],
    [4_096, 0, 0],
  ] as const) {
    const budget = inputBudget(cap, output, system)
    assert.ok(budget <= cap, `budget ${budget} must not exceed cap ${cap}`)
    assert.ok(budget >= 0, `budget ${budget} must not be negative`)
  }
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

const long = (size: number) => "x".repeat(size)

test("shrinkMessages level 1 elides oversized tool output and keeps its head and tail", () => {
  const body = `${"H".repeat(1_200)}${"M".repeat(3_000)}${"T".repeat(800)}`
  const messages: Message[] = [
    text("keep me"),
    { role: "assistant", content: [{ type: "text", text: "older chatter" }] },
    { role: "tool", content: [{ type: "tool-result", text: body }] },
  ]
  const result = shrinkMessages(messages, 1)
  assert.equal(result.elided, 1)
  const part = result.messages[2].content[0]
  assert.match(String(part.text), /ctx-limit: elided \d+ chars of tool output/)
  assert.ok(String(part.text).startsWith("H".repeat(1_200)))
  assert.ok(String(part.text).endsWith("T".repeat(800)))
  assert.ok(String(part.text).length < body.length)
  // Everything that is not oversized tool output is untouched.
  assert.deepEqual(result.messages[0], messages[0])
  assert.deepEqual(result.messages[1], messages[1])
})

test("shrinkMessages level 1 returns the same array when nothing is oversized", () => {
  const messages: Message[] = [text("a"), { role: "tool", content: [{ type: "tool-result", text: "short" }] }]
  const result = shrinkMessages(messages, 1)
  assert.equal(result.elided, 0)
  assert.equal(result.messages, messages)
})

test("shrinkMessages level 2 elides duplicate tool output and keeps the newest copy", () => {
  const body = long(500)
  const messages: Message[] = [
    { role: "tool", content: [{ type: "tool-result", text: body }] },
    text("next turn"),
    { role: "tool", content: [{ type: "tool-result", text: body }] },
  ]
  const result = shrinkMessages(messages, 2)
  assert.equal(result.elided, 1)
  assert.match(String(result.messages[0].content[0].text), /identical to a later result/)
  assert.equal(result.messages[2].content[0].text, body)
})

test("shrinkMessages level 2 leaves short duplicates alone", () => {
  const messages: Message[] = [
    { role: "tool", content: [{ type: "tool-result", text: "same" }] },
    { role: "tool", content: [{ type: "tool-result", text: "same" }] },
  ]
  assert.equal(shrinkMessages(messages, 2).elided, 0)
})

test("shrinkMessages level 3 shortens older assistant prose but keeps tool calls and users", () => {
  const call = { type: "tool-call", id: "tool_1", text: long(3_000) }
  const messages: Message[] = [
    text("user words must survive"),
    { role: "assistant", content: [{ type: "text", text: long(2_000) }, call] },
    text("again"),
    { role: "assistant", content: [{ type: "text", text: long(2_000) }] },
  ]
  const result = shrinkMessages(messages, 3)
  assert.equal(result.elided, 1)
  const older = result.messages[1]
  assert.match(String(older.content[0].text), /earlier assistant text/)
  assert.ok(String(older.content[0].text).length < 2_000)
  assert.deepEqual(older.content[1], call)
  assert.deepEqual(result.messages[0], messages[0])
  // The newest assistant turn is never shortened.
  assert.deepEqual(result.messages[3], messages[3])
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

test("sameDirectory resolves dot segments and redundant separators", () => {
  assert.equal(sameDirectory("C:/GITHUB/./opencode-ctx-limit", "C:\\GITHUB\\opencode-ctx-limit"), true)
  assert.equal(sameDirectory("C:/GITHUB/x/../opencode-ctx-limit", "C:/GITHUB/opencode-ctx-limit"), true)
  assert.equal(sameDirectory("/home/me/../me/project", "/home/me/project"), true)
  assert.equal(sameDirectory("//var//lib///volumes//", "/var/lib/volumes"), true)
  assert.equal(sameDirectory("C:/GITHUB/opencode-ctx-limit/..", "C:/GITHUB"), true)
  assert.equal(sameDirectory("C:/..", "D:/"), false)
  assert.equal(sameDirectory("/", "/"), false)
  assert.equal(sameDirectory("/home/me/../other", "/home/me/project"), false)
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
