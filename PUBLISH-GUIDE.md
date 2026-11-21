# Publishing an OpenCode plugin from a local repo

How to keep development in a `C:\GITHUB\<repo>` git repo while OpenCode installs
the plugin as a distributed package instead of a `local` directory.

Applies to OpenCode V2 (`plugins` key, `opencode plugin ...` CLI).

**House rule: every plugin here publishes as `@catronomix/opencode-<name>`.**
Unscoped `opencode-*` names are first-come and unowned; see §2.

---

## 1. The model

There is no OpenCode plugin registry. A plugin is an ordinary npm package whose
entrypoints export plugin parts, published to the public npm registry
(`registry.npmjs.org`).

```json
{
  "name": "@catronomix/opencode-ctx-limit",
  "type": "module",
  "exports": {
    ".": "./dist/index.js",
    "./tui": "./dist/tui.js",
    "./rpc": "./dist/rpc.js"
  },
  "files": ["dist", "LICENSE", "README.md"]
}
```

The git repo is only where source lives. OpenCode resolves an entry in
`plugins`, downloads the package, caches it, and runs it. It never looks at your
repo.

| | local (today) | published |
|---|---|---|
| source | `~/.config/opencode/plugins/<name>/` or a path entry | `C:\GITHUB\<repo>` (repo) |
| config entry | path, or nothing (auto-discovered) | `"@catronomix/opencode-ctx-limit@1.0.0"` |
| `opencode plugin list` ID | `<id>` | `<id>` (unchanged) |
| `opencode plugin list` SOURCE | `local` + absolute path | `@catronomix/opencode-ctx-limit` |
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

## 2. Names, scopes, and ownership

npm has exactly one public registry (plus private registries and mirrors, see
§8). Anyone can publish to it with a free account; there is no review, no
curation, and no reserved namespace.

- **Unscoped names** (`opencode-ocmodels`) are global and first-come. Once
  someone else takes a name you like, it is gone for good, and a name that looks
  official implies nothing.
- **Scoped names** (`@catronomix/opencode-ocmodels`) live under a namespace you
  control. The scope is created once — either as your npm username or as an org
  you own — and only members of that scope can publish into it. Nobody can
  squat a name under it.

Therefore, for every plugin in this folder:

```json
{
  "name": "@catronomix/opencode-<plugin>",
  "publishConfig": {
    "access": "public"
  }
}
```

Scoped packages are **private by default**; without `publishConfig.access` (or
`npm publish --access public`) the first publish is rejected. Setting it in
`package.json` means CI and muscle memory cannot get it wrong.

The scope name is not free-form: it must match an existing npm username or org.
Confirm yours before the first publish (`npm whoami`, or the account settings at
<https://www.npmjs.com/settings/>). If your npm identity is not `catronomix`,
rename it to whatever your actual scope is — one string in `package.json`, the
README, and the install command.

Renaming the package does **not** change the plugin ID, so a rename is not a
breaking change for anyone who already disabled or configured it.

## 3. Install channels

Four ways a user (or you) can consume the same repo:

```jsonc
// npm, exact version — recommended for a stable install
{ "plugins": ["@catronomix/opencode-ocmodels@1.2.0"] }

// npm, tag — recommended for a dev channel
{ "plugins": ["@catronomix/opencode-ocmodels@next"] }

// git, no registry needed; pinned commit never drifts
{ "plugins": ["github:catronomix/opencode-ocmodels"] }

// local checkout, for live iteration
{ "plugins": ["C:/GITHUB/opencode-ocmodels"] }
```

The CLI writes these entries for you and keeps unrelated config intact:

```sh
opencode plugin add @catronomix/opencode-ocmodels@1.2.0
opencode plugin add github:catronomix/opencode-ocmodels
opencode plugin list
opencode plugin check          # which configured packages have updates
opencode plugin update         # all outdated packages
opencode plugin update @catronomix/opencode-ocmodels@1.2.0
opencode plugin remove @catronomix/opencode-ocmodels@1.2.0
```

Unpinned npm specs and unpinned git specs are checked for updates in the
background; exact versions and full commit hashes stay pinned. Tarballs and npm
aliases are rejected by `plugin add`.

## 4. Dev loop

1. Code + test in `C:\GITHUB\<repo>`.
2. `npm run build` and confirm `npm pack --dry-run` contents (§7).
3. `npm publish --tag next` for a prerelease; install the tag while iterating.
4. When green, `npm publish` and pin the exact version in `opencode.json(c)`.
5. `opencode plugin check` / `opencode plugin update` to move installs forward.

Config changes apply without a restart; files under watched config directories
reload automatically. Changes to unwatched local dependencies may need
`opencode service restart`.

While iterating, use **either** the path entry **or** the package entry, not
both. Two entries that resolve to the same plugin ID give you two instances
fighting over the same hooks, and nothing syncs them.

## 5. Build output: `dist/`, not source, not git

Publishing `.ts`/`.tsx` directly works only because Bun loads plugins. It hands
consumers your source and makes the TUI part depend on their build pipeline.

Rules:

- Entry points in `exports`, `main`, and `types` all point into `dist/`.
- `files` lists `dist`, `LICENSE`, `README.md` — nothing else.
- `dist/` is **not committed**. It is a build artifact; add it to `.gitignore`.
  CI or `prepack` produces it, and `npm pack --dry-run` proves what ships.
- `prepack` runs the build so a publish can never ship a stale or missing `dist`.
- `@opencode/plugin` is a `peerDependency`, never a `dependency`. So are
  `@opentui/core`, `@opentui/solid`, and `solid-js`: the host provides them, and
  a bundled second copy breaks the TUI reconciler in ways that look like your bug.
- Keep real versions in `devDependencies` so local typecheck and tests resolve
  the same API the host will.

## 6. Concrete `tsup` config

Twin ESM entries, `.d.ts` for both, solid transformed at build time, peers left
external:

```ts
// tsup.config.ts
import { defineConfig } from "tsup"
import solid from "esbuild-plugin-solid"

export default defineConfig({
  entry: { index: "src/index.ts", tui: "src/tui.tsx" },
  format: ["esm"],
  dts: true,
  clean: true,
  target: "esnext",
  platform: "neutral",
  external: [
    "@opencode/plugin",
    "@opentui/core",
    "@opentui/solid",
    "solid-js",
    "solid-js/*",
  ],
  esbuildPlugins: [solid()],
})
```

```json
{
  "scripts": {
    "build": "tsup",
    "typecheck": "tsc --noEmit",
    "prepack": "npm run build"
  }
}
```

`platform: "neutral"` keeps Node builtins from being pulled in and matches the
Bun/plugin host. `dts: true` gives consumers types for both parts. If you also
export `./rpc`, add it as a third entry.

Verify the published shape the way a consumer sees it, not from the workspace:

```sh
npm pack --dry-run                      # file list + size, no src/test/.devteam
npm pack && npm i -g ./catronomix-opencode-*.tgz   # or into a clean temp dir
```

## 7. Pre-publish checklist

- [ ] `name` is `@catronomix/opencode-<plugin>` and the scope exists.
- [ ] `version` bumped; `license`, `description`, `repository`, `keywords`
      (`opencode`, `opencode-plugin`), `engines` present.
- [ ] `publishConfig.access` is `"public"`.
- [ ] `"private": true` removed.
- [ ] `exports`, `main`, `types`, `files` all reference `dist/`.
- [ ] `@opencode/plugin` and TUI deps are `peerDependencies`.
- [ ] `dist/` is gitignored; `prepack` builds it.
- [ ] `npm test`, `npm run typecheck`, `npm run build` all green.
- [ ] `npm pack --dry-run` shows only `dist`, `LICENSE`, `README.md`,
      `package.json`.
- [ ] `Plugin.define({ id })` is stable — changing it breaks user configs.
- [ ] README documents the scoped install command, options, credentials.
- [ ] `npm publish` (or `--tag next` for a prerelease).
- [ ] `opencode plugin add @catronomix/opencode-<plugin>@<version>` and verify
      with `opencode plugin list` — SOURCE must be the package, not `local`.
- [ ] Remove any path entry for the same plugin.
- [ ] Confirm the plugin actually runs; `/reload` or restart if needed.

## 8. Gotchas

- **Scope must exist before you publish.** `@something/foo` fails with
  `E404`/`E403` if `something` is not your npm username or an org you belong to.
- **Scoped = private by default.** Forgetting `--access public` on the very
  first publish is the most common failure.
- **The unscoped name you "own" is only yours by habit.** If a name matters,
  publish the scoped one and optionally leave the unscoped one as a pointer.
- **`"private": true` blocks publishing.** Several repos here had it set for
  local dev; remove it before the first publish.
- **Missing `files` ships your junk.** Without it, tests, evidence dirs,
  `.devteam`, screenshots and lockfiles all get packed.
- **`"@opencode/plugin": "latest"` as a runtime dependency is wrong.** It is
  unpinned and can install a second copy of the plugin SDK next to the host's.
- **Version skew across plugin and host.** A plugin built against an older
  `@opencode/plugin` can break after an OpenCode update. Test the installed
  package, not a workspace link.
- **Publishing is close to irreversible.** Unpublish only within 72 hours and
  only if nothing depends on the version. Treat the version as permanent.
- **TUI-only plugins are configured elsewhere.** A package with only a `./tui`
  part belongs in `cli.json`, not `opencode.json(c)`.
- **GUI parts need a global config.** OpenCode Desktop loads GUI parts only for
  plugins in the global `opencode.json(c)`.
- **Dev and installed copies are independent.** After publishing, a stale local
  checkout does nothing. Remove the path entry when you switch to the package.
- **`opencode plugin list` lags and is not ground truth.** After editing
  `package.json` or the `plugins` array it can keep omitting a plugin, or show
  two rows for the same ID with different sources, until the server reloads.
  The authoritative signal is the server log line
  `msg="loading plugin" ... entrypoint=file:///...`, which names the exact file
  it imported. `opencode service restart` or `/reload` settles the table.
- **`--standalone` proves the code imports, not that the running server has
  it.** A long-lived server can keep serving a registry from before your last
  edit and silently omit the plugin, while a standalone run loads it fine.
  Check `opencode api get /api/plugin` for the entry with
  `state.status: active`; if it is missing, restart the service. That endpoint
  also reports the resolved `source.path` (checkout vs package cache), which is
  the quickest way to tell which copy is actually running.
- **npm < 12 has no `stage` command.** `npm stage publish` needs npm 12+; on an
  older npm the only options are `npm publish` (needs an OTP or a 2FA-bypassing
  token) or `npx -y npm@12 stage publish`. Stage ids expire after 7 days.
- **Private registries and mirrors exist** (GitHub Packages, Verdaccio,
  Artifactory, corporate proxies) and are opt-in via `.npmrc`. Public npm needs
  no account to *install* — only to publish.

## 9. Related reading

- Configure plugins: <https://opencode.ai/docs/plugins>
- Build plugins: <https://opencode.ai/docs/build/plugins>
- TUI plugins: <https://opencode.ai/docs/build/plugins/cli>
- CLI settings (`cli.json`): <https://opencode.ai/docs/cli/config>
- npm scopes and access: <https://docs.npmjs.com/about-scopes>
