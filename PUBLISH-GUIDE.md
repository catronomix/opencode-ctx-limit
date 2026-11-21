# Publishing an OpenCode plugin from a local repo

How to keep development in a `C:\GITHUB\<repo>` git repo while OpenCode installs
the plugin as a distributed package instead of a `local` directory.

Applies to OpenCode V2 (`plugins` key, `opencode plugin ...` CLI).

---

## 1. The model

There is no "plugin registry" beyond npm. A plugin is an ordinary npm package
whose entrypoints export plugin parts:

```json
{
  "name": "opencode-ctx-limit",
  "type": "module",
  "exports": {
    ".": "./index.ts",
    "./tui": "./tui.ts",
    "./rpc": "./rpc.ts"
  },
  "files": ["index.ts", "logic.ts", "rpc.ts", "tui.ts"]
}
```

The git repo is only where source lives. OpenCode resolves an entry in
`plugins`, downloads the package, caches it, and runs it. It never looks at your
repo.

| | local (today) | published |
|---|---|---|
| source | `~/.config/opencode/plugins/<name>/` or a path entry | `C:\GITHUB\<repo>` (repo) |
| config entry | path, or nothing (auto-discovered) | `"opencode-ctx-limit@1.0.0"` |
| `opencode plugin list` ID | `<id>` | `<id>` (unchanged) |
| `opencode plugin list` SOURCE | `local` + absolute path | `opencode-ctx-limit` |
| updates | manual edits | `opencode plugin check` / `plugin update` |

`local` is not a warning label. It only means "resolved from a filesystem
directory". The plugin ID always comes from `Plugin.define({ id })` (or the
package name for GUI-only plugins), so publishing does not rename anything and
`plugins: ["-ctx-limit"]` keeps working.

Discovery rules to remember:

- `~/.config/opencode/plugins/` and `<project>/.opencode/plugins/` are scanned
  automatically, one level deep, for `.ts`/`.js` files and package directories.
- Any other location must be listed explicitly in `plugins`, and paths must point
  at **directories**, never single files.
- `plugins` arrays merge across config files; they do not replace each other.

## 2. Install channels

Four ways a user (or you) can consume the same repo:

```jsonc
// npm, exact version — recommended for a stable install
{ "plugins": ["opencode-ctx-limit@1.2.0"] }

// npm, tag — recommended for a dev channel
{ "plugins": ["opencode-ctx-limit@next"] }

// git, no registry needed; pinned commit never drifts
{ "plugins": ["github:catronomix/opencode-ctx-limit"] }

// local checkout, for live iteration
{ "plugins": ["C:/GITHUB/opencode-ctx-limit"] }
```

The CLI writes these entries for you and keeps unrelated config intact:

```sh
opencode plugin add opencode-ctx-limit@1.2.0
opencode plugin add github:catronomix/opencode-ctx-limit
opencode plugin list
opencode plugin check          # which configured packages have updates
opencode plugin update         # all outdated packages
opencode plugin update opencode-ctx-limit@1.2.0
opencode plugin remove opencode-ctx-limit@1.2.0
```

Unpinned npm specs and unpinned git specs are checked for updates in the
background; exact versions and full commit hashes stay pinned. Tarballs and npm
aliases are rejected by `plugin add`.

## 3. Dev loop

1. Code + test in `C:\GITHUB\<repo>`.
2. `npm publish --tag next` for a prerelease; install the tag while iterating.
3. When green, `npm publish` and pin the exact version in `opencode.json(c)`.
4. `opencode plugin check` / `opencode plugin update` to move installs forward.

Config changes apply without a restart; files under watched config directories
reload automatically. Changes to unwatched local dependencies may need
`opencode service restart`.

While iterating, use **either** the path entry **or** the package entry, not
both. Two entries that resolve to the same plugin ID give you two instances
fighting over the same hooks, and nothing syncs them.

## 4. Gotchas

- **Name ownership is first-come.** `opencode-*` unscoped names are not
  reserved by anyone and carry no endorsement. A scoped name
  (`@yourscope/opencode-ctx-limit`) is yours forever and cannot be squatted.
  Check availability before you settle on a name in the README or CI.
- **`"private": true` blocks publishing.** Several of these repos have it set
  for local dev; remove it (or use `publishConfig`) before the first publish.
- **Missing `files` ships your junk.** Without it npm packs `node_modules`
  exclusions but still pulls in tests, evidence dirs, `.devteam`, screenshots.
  List entrypoints and licenses explicitly.
- **`"@opencode/plugin": "latest"` as a runtime dependency is wrong for a
  published plugin.** It is unpinned and can install a second copy of the
  plugin SDK beside the host's. Use `peerDependencies` with a range such as
  `">=2.0.0 <3"`, keeping the real version in `devDependencies` for local
  typecheck and tests.
- **Raw `.ts` / `.tsx` exports work because Bun loads plugins.** That is fine
  for a personal plugin, but it hands consumers your source and makes the TUI
  part depend on their build pipeline. Building to `dist/` with `tsup` (see
  `sub-agent-statusline`) is the safer published shape; add `prepack` so the
  build runs on publish.
- **`peerDependencies` for TUI deps.** `@opentui/core`, `@opentui/solid` and
  `solid-js` must be peers, not dependencies, or the TUI renders against a
  second copy of the reconciler and breaks in ways that look like your bug.
- **Version skew across plugin and host.** A plugin built against an older
  `@opencode/plugin` can break after an OpenCode update. Test the installed
  package, not a workspace link, and publish a compatible release when you adopt
  a newer API contract.
- **Publishing is close to irreversible.** You can unpublish within 72 hours and
  only if nothing depends on the version. Treat the version number as permanent.
- **TUI-only plugins are configured elsewhere.** A package with only a `./tui`
  part belongs in `cli.json` under `plugins`, not `opencode.json(c)`.
- **GUI parts need a global config.** OpenCode Desktop loads GUI parts only for
  plugins in the global `opencode.json(c)`.
- **Dev and installed copies are independent.** After publishing, a stale local
  checkout does nothing. Remove the path entry when you switch to the package,
  or you will debug the wrong code.

## 5. Pre-publish checklist

- [ ] `package.json` has `name`, a real `version`, `license`, `description`,
      `keywords` (`opencode`, `opencode-plugin`), `repository`, `exports`,
      `files`, `engines`.
- [ ] `"private"` removed.
- [ ] `@opencode/plugin` is a `peerDependency`; TUI deps are peers too.
- [ ] `npm pack --dry-run` shows only intended files.
- [ ] Tests and `tsc --noEmit` pass.
- [ ] `Plugin.define({ id })` is stable — changing it breaks user configs that
      disable or reference the plugin.
- [ ] README documents the config snippet, options, and any credential handling.
- [ ] `npm publish` (or `npm publish --tag next` for a prerelease).
- [ ] `opencode plugin add <name>@<version>` and verify with
      `opencode plugin list` — SOURCE should be the package name, not `local`.
- [ ] Restart or `/reload` as needed and confirm the plugin actually runs.

## 6. Related reading

- Configure plugins: <https://opencode.ai/docs/plugins>
- Build plugins: <https://opencode.ai/docs/build/plugins>
- TUI plugins: <https://opencode.ai/docs/build/plugins/cli>
- CLI settings (`cli.json`): <https://opencode.ai/docs/cli/config>
