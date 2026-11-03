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

Clone the repository into your OpenCode plugins directory so the checkout *is* the
installed plugin:

```sh
git clone https://github.com/catronomix/opencode-ctx-limit.git ~/.config/opencode/plugins/ctx-limit
```

Plugins under `~/.config/opencode/plugins/<name>/` load automatically — no `opencode.json(c)`
entry is needed. The directory exposes three parts through its `package.json` `exports`:

| Export  | File       | Runs in        | Role                                         |
| ------- | ---------- | -------------- | -------------------------------------------- |
| `.`     | `index.ts` | OpenCode server | Enforcement, persistence, RPC implementation |
| `./tui` | `tui.ts`   | Terminal UI    | Menu, slash command, RPC client              |
| `./rpc` | `rpc.ts`   | Shared         | Typed RPC contract                           |

If you keep the clone somewhere else, add the plugin **directory** (not individual files) to
`plugins` in `~/.config/opencode/opencode.json(c)`:

```jsonc
{
  "plugins": ["/home/you/src/opencode-ctx-limit"]
}
```

One entry loads every part. Both parts are required for the menu; enforcement works on its
own. If only the terminal part is running, changing the cap reports that the server part is
not loaded instead of failing silently.

To update:

```sh
git -C ~/.config/opencode/plugins/ctx-limit pull
```

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

## Troubleshooting

`Global context limit — The ctx-limit server part is not running at this location` means the
terminal part loaded but the server part did not, so there is no RPC to change the cap. Check
`GET /api/plugin` (via `opencode api get /api/plugin`) for an active `ctx-limit` entry with
`server`, `tui`, and `rpc` features, and read the server log at
`~/.local/share/opencode/log/opencode.log`.

Any other message here is the real error text returned by the server, including its RPC error
type.

## Development

```sh
node --test logic.test.ts   # pure helper tests
npx tsc --noEmit            # typecheck
```

`logic.ts` has no OpenCode imports on purpose — it is the testable core.

## License

MIT
