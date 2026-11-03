# ctx-limit

An [OpenCode](https://opencode.ai) plugin that puts **one global token cap** on every model.

A single shared limit applies to every provider and model: whichever model a session
uses, it never plans for more context than the cap. Useful when you pay per token, run
local models with a small window, or just want sessions to stay predictable.

## Features

- **Global cap** — one number, all models. Stored per machine, not per project.
- **Request-time enforcement** — the cap is applied to the payload that is actually
  sent, so it works even for models that pin `limit` in their config and ignore transforms.
- **Turn-aware trimming** — oldest turns are dropped whole from the front, so assistant
  tool calls never get separated from their tool results. The newest turn is always kept.
- **Output budgeting** — `maxTokens` becomes `min(configured, cap / 4)`, clamped to
  1k–32k, so output never starves the input budget.
- **Instant control from the TUI** — `⌘K` palette commands and the `/ctxmax` slash command.

## Install

Copy (or symlink) the plugin files into your OpenCode plugins directory:

```sh
git clone https://github.com/catronomix/opencode-ctx-limit.git
```

Then, in `~/.config/opencode/opencode.json(c)`, load both the server and terminal entry
points:

```jsonc
{
  "plugins": [
    "~/.config/opencode/plugins/ctx-limit/index.ts",
    "~/.config/opencode/plugins/ctx-limit/tui.ts"
  ]
}
```

`index.ts` is the server-side plugin (enforcement + persistence), `tui.ts` is the terminal
plugin (menu + slash command). Both are required for the menu; enforcement works on its own.

## Usage

- Palette (`⌘K` → **Context**): **Set global max context** / **Clear global max context**
- Slash command: `/ctxmax 128k`, `/ctxmax 200000`, or just `/ctxmax` for a picker
- Presets: 64k, 100k, 128k, 160k, 200k, 256k, plus custom and "no limit"

The command accepts raw token counts and `k`/`m` suffixes. The minimum is 4096 tokens;
setting "no limit" returns every model to its configured context window.

## How it works

Two layers, because OpenCode models behave differently:

1. `ctx.model.transform` clamps every model registry entry whose `limit.context` or
   `limit.output` exceeds the cap. Models that pin `limit` in config ignore this, so…
2. `ctx.session.hook("context")` enforces the cap on the final request: it recomputes the
   output budget, subtracts the estimated system prompt, and trims old turns until the
   tail fits.

Token counts are a cheap provider-agnostic estimate (~4 characters per token), not a
tokenizer, so leave headroom for real tokenizers.

Settings sync across windows through the plugin RPC channel (`rpc.ts`), so changing the cap
in one window updates the others.

## Development

```sh
node --test logic.test.ts   # pure helper tests
npx tsc --noEmit            # typecheck
```

`logic.ts` has no OpenCode imports on purpose — it is the testable core.

## License

MIT
