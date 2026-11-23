#!/usr/bin/env node
/**
 * Consumer-side release gate.
 *
 * Everything here is checked against the *packed tarball installed into an empty
 * directory*, never against this repo's node_modules, because that is the only
 * place the failures below can happen:
 *
 *  - peer ranges that resolve locally but not under opencode's stricter npm
 *  - files that exist in the repo but are missing from the published tarball
 *  - test assets, tsconfigs or .env files that leak into the tarball
 *  - a JSX entrypoint with no JSX runtime, which the host's transpiler rejects
 *  - a peer floor the opencode version users actually run cannot satisfy
 *
 * Run from a repo root: `node scripts/release-check.mjs`.
 * Exit code 0 = safe to publish. Non-zero = do not publish.
 *
 * Env:
 *   RELEASE_CHECK_HOST    JSON array of host dependency sets to resolve against
 *                         (default: the versions opencode ships today)
 *   RELEASE_CHECK_IMPORT  1 = also import each JS entrypoint from the installed
 *                         copy (may run plugin factory code; off by default)
 *   RELEASE_CHECK_OFFLINE 1 = skip the npm@10 install check
 */
import { execFileSync, execSync } from "node:child_process"
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { builtinModules } from "node:module"
import { dirname, extname, join, resolve } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..")
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"))
const failures = []
const warnings = []

const ok = (message) => console.log(`  ok    ${message}`)
const warn = (message) => {
  warnings.push(message)
  console.log(`  warn  ${message}`)
}
const fail = (message) => {
  failures.push(message)
  console.log(`  FAIL  ${message}`)
}
const section = (title) => console.log(`\n${title}`)

/** Runs a command through the shell, returning stdout; throws with stderr on failure. */
function run(command, options = {}) {
  return execSync(command, {
    cwd: options.cwd ?? root,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    maxBuffer: 32 * 1024 * 1024,
    windowsHide: true,
    env: { ...process.env, ...options.env },
  })
}

/** Host versions the plugin is resolved against: what opencode ships. */
const HOST_MATRIX = process.env.RELEASE_CHECK_HOST
  ? JSON.parse(process.env.RELEASE_CHECK_HOST)
  : [
      { "@opencode/plugin": "2.3.2", "@opentui/core": "0.9.4", "@opentui/solid": "0.9.4", "solid-js": "1.9.20" },
      { "@opencode/plugin": "2.4.0", "@opentui/core": "0.9.8", "@opentui/solid": "0.9.8", "solid-js": "1.9.20" },
    ]

// ---------------------------------------------------------------------------
// 1. Manifest: peers are ranges, host packages are peers, versions agree.
// ---------------------------------------------------------------------------
section("manifest")
{
  const peers = pkg.peerDependencies ?? {}
  const deps = pkg.dependencies ?? {}
  const dev = pkg.devDependencies ?? {}
  const EXACT = /^\s*v?\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?\s*$/

  if (!pkg.name || !pkg.version) fail("package.json is missing name or version")

  for (const [name, range] of Object.entries(peers)) {
    if (EXACT.test(range)) {
      fail(`peer ${name} is pinned to the exact version ${range}; use a range so the host can satisfy it`)
    }
    if (deps[name]) fail(`${name} is both a peerDependency and a dependency; ship the host's copy only`)
    if (!dev[name]) warn(`${name} is a peer but not a devDependency; nothing checks this repo against it`)
  }

  // Anything the host provides that the source imports must be declared as a peer.
  const imported = new Set()
  const builtins = new Set(builtinModules)
  for (const file of sourceFiles(root, exportTargets(pkg))) {
    const text = readFileSync(file, "utf8")
    for (const match of text.matchAll(/from\s+"([^".][^"]*)"/g)) {
      const spec = match[1]
      const rootSpec = spec.startsWith("@") ? spec.split("/").slice(0, 2).join("/") : spec.split("/")[0]
      if (spec.startsWith("node:") || builtins.has(rootSpec)) continue
      imported.add(rootSpec)
    }
  }
  for (const spec of imported) {
    if (spec in deps) fail(`${spec} is a runtime dependency but the host provides it; move it to peer + dev`)
    else if (!(spec in peers) && !(spec in dev)) fail(`${spec} is imported but never declared`)
    else if (!(spec in peers)) warn(`${spec} is imported but only a devDependency; declaring it as a peer is what guarantees the host supplies it`)
  }

  for (const [name, range] of Object.entries(dev)) {
    if (peers[name] && !rangeAdmits(peers[name], flatten(range))) {
      fail(`devDependency ${name}@${range} is outside the peer range ${peers[name]}`)
    }
    if (EXACT.test(range) && peers[name]) {
      warn(`devDependency ${name} is pinned to ${range}; a caret range keeps the build on the host's track`)
    }
  }
  if (!failures.length) ok("peers are ranges, host packages are peers, dev deps inside peer ranges")
}

// ---------------------------------------------------------------------------
// 2. Tarball: the published files are the ones meant to ship.
// ---------------------------------------------------------------------------
section("tarball")
let packDir
let tarball
{
  packDir = mkdtempSync(join(tmpdir(), "release-check-pack-"))
  const packed = JSON.parse(
    run(`npm pack --json --ignore-scripts --dry-run=false --pack-destination "${packDir}"`),
  )
  const entry = Array.isArray(packed) ? packed[0] : Object.values(packed)[0]
  if (!entry?.filename) fail("npm pack produced no tarball")
  tarball = join(packDir, entry.filename)
  if (!existsSync(tarball)) {
    fail(`npm pack reported ${entry.filename} but wrote no file`)
    console.log("")
    process.exit(1)
  }
  const files = entry.files.map((file) => file.path.replace(/\\/g, "/"))
  ok(`${entry.filename}: ${files.length} files, ${entry.size} bytes packed`)

  const forbidden = files.filter((path) =>
    /(^|\/)\.env/.test(path) ||
    /(^|\/)(node_modules|\.git|\.github|coverage)\//.test(path) ||
    /(^|\/)(tsconfig[^/]*\.json|.*\.tgz|.*\.log|smoke[^/]*|.*\.test\.[cm]?[jt]sx?|test\/)/.test(path),
  )
  if (forbidden.length) fail(`forbidden files in the tarball: ${forbidden.join(", ")}`)
  else ok("no env files, tests, tsconfigs, logs or node_modules")

  const secret = /(npm_[A-Za-z0-9]{36}|gh[pousr]_[A-Za-z0-9]{20,}|sk-[A-Za-z0-9]{20,}|AKIA[0-9A-Z]{16}|-----BEGIN [A-Z ]*PRIVATE KEY-----)/
  const leaked = files.filter((path) => !path.endsWith(".map") && secret.test(readTarballFile(tarball, path)))
  if (leaked.length) fail(`credential-shaped strings in: ${leaked.join(", ")}`)
  else ok("no credential-shaped strings in shipped files")

  for (const target of exportTargets(pkg)) {
    if (!files.includes(target)) fail(`export points at ${target}, which is missing from the tarball`)
    else if (!readTarballFile(tarball, target).trim()) fail(`export ${target} is empty`)
  }
  if (!failures.length) ok("every exports target is present and non-empty")

  // A .tsx entrypoint needs a JSX runtime the host can find.
  for (const path of files.filter((file) => file.endsWith(".tsx"))) {
    const text = readTarballFile(tarball, path)
    if (!/(@jsxImportSource|@jsxRuntime|React\.createElement)/.test(text)) {
      warn(`${path} uses JSX with no JSX pragma; the host supplies the runtime, local tsc cannot prove it`)
    }
  }
}

// ---------------------------------------------------------------------------
// 3. Consumer install: the resolver opencode uses, against the host's versions.
// ---------------------------------------------------------------------------
section("consumer install")
if (process.env.RELEASE_CHECK_OFFLINE) {
  warn("skipped (RELEASE_CHECK_OFFLINE=1)")
} else {
  for (const host of HOST_MATRIX) {
    const dir = mkdtempSync(join(tmpdir(), "release-check-install-"))
    const label = Object.entries(host).map(([name, version]) => `${name}@${version}`).join(" ")
    try {
      writeFileSync(
        join(dir, "package.json"),
        JSON.stringify({ name: "consumer", private: true, version: "0.0.0", dependencies: { ...host } }, null, 2),
      )
      run(`npm install --no-audit --no-fund --ignore-scripts`, { cwd: dir })
      const result = installTarball(dir, tarball)
      if (result.code === 0) ok(`installs with ${label} (strict peers, npm ${result.npm})`)
      else fail(`does not install with ${label}: ${result.reason}`)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }
}

// ---------------------------------------------------------------------------
// 4. Optional: import the installed entrypoints.
// ---------------------------------------------------------------------------
if (process.env.RELEASE_CHECK_IMPORT) {
  section("entrypoints")
  const dir = mkdtempSync(join(tmpdir(), "release-check-import-"))
  try {
    writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "consumer", private: true, version: "0.0.0" }))
    run("npm install --no-audit --no-fund --ignore-scripts", { cwd: dir })
    for (const host of HOST_MATRIX.slice(0, 1)) {
      run(`npm install --no-audit --no-fund --ignore-scripts ${quotedHostArgs(host)}`, { cwd: dir })
    }
    if (installTarball(dir, tarball).code !== 0) fail("cannot install for the import check")
    else {
      const installed = join(dir, "node_modules", pkg.name)
      for (const target of exportTargets(pkg)) {
        if (!/\.[cm]?[jt]s$/.test(target)) continue
        try {
          run(`node --input-type=module -e "await import(${JSON.stringify(pathToFileURL(join(installed, target)))})"`, { cwd: dir })
          ok(`imports ${target}`)
        } catch (error) {
          fail(`importing ${target} threw: ${String(error.stderr ?? error.message).split("\n").slice(0, 3).join(" ")}`)
        }
      }
    }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

// ---------------------------------------------------------------------------
console.log("")
if (warnings.length) console.log(`${warnings.length} warning(s), none blocking`)
if (failures.length) {
  console.log(`FAILED: ${failures.length} blocking issue(s) - do not publish`)
  for (const message of failures) console.log(`  - ${message}`)
  process.exit(1)
}
console.log(`release-check passed for ${pkg.name}@${pkg.version}`)

// ---------------------------------------------------------------------------
// helpers

function installTarball(dir, file) {
  const attempts = [
    { command: `npx --yes npm@10 install "${file}" --strict-peer-deps --no-audit --no-fund`, npm: "10" },
    { command: `npm install "${file}" --strict-peer-deps --no-audit --no-fund`, npm: "local" },
  ]
  for (const attempt of attempts) {
    try {
      run(attempt.command, { cwd: dir })
      return { code: 0, npm: attempt.npm }
    } catch (error) {
      const output = `${error.stdout ?? ""}\n${error.stderr ?? ""}`
      if (/ERESOLVE|unable to resolve dependency tree/.test(output)) {
        return { code: 1, reason: `ERESOLVE: ${firstLine(output, /(peer|Found|Could not resolve)/)}`, npm: attempt.npm }
      }
      if (attempt.npm === "10" && /(ENOTFOUND|EAI_AGAIN|ETIMEDOUT|network|404 Not Found|EACCES)/i.test(output)) {
        warn(`npm@10 unavailable (${firstLine(output, /error/)}), retrying with the local npm`)
        continue
      }
      return { code: 1, reason: firstLine(output, /error/), npm: attempt.npm }
    }
  }
  return { code: 1, reason: "no npm could run the install", npm: "none" }
}

function firstLine(output, pattern) {
  const lines = output
    .split("\n")
    .map((text) => text.trim())
    .filter((text) => text && !/^npm notice/.test(text) && !/^run \^"/.test(text))
  const line = lines.find((text) => pattern.test(text))
  return (line ?? lines.slice(-3).join(" ")).slice(0, 400)
}

function quotedHostArgs(host) {
  return Object.entries(host).map(([name, version]) => `"${name}@${version}"`).join(" ")
}

function exportTargets(manifest) {
  const targets = new Set()
  const walk = (value) => {
    if (typeof value === "string") targets.add(value.replace(/^\.\//, ""))
    else if (value && typeof value === "object") for (const nested of Object.values(value)) walk(nested)
  }
  walk(manifest.exports)
  if (manifest.main) walk(manifest.main)
  return [...targets].filter((target) => !target.includes("*"))
}

function sourceFiles(dir, targets = []) {
  const out = []
  const roots = new Set([join(dir, "src"), join(dir, "lib"), join(dir, "plugin")])
  for (const target of targets) {
    const folder = dirname(target.replace(/^\.\//, "").replace(/\\/g, "/"))
    roots.add(!folder || folder === "." ? dir : join(dir, folder))
  }
  const skip = new Set(["node_modules", ".git", ".github", ".devteam", "test", "tests", "scripts", "dist", "coverage"])
  const stack = [...roots]
  while (stack.length) {
    const current = stack.pop()
    if (!existsSync(current)) continue
    for (const entry of readdirSync(current)) {
      if (skip.has(entry)) continue
      const path = join(current, entry)
      if (statSync(path).isDirectory()) stack.push(path)
      else if (/\.(ts|tsx|mts|js|mjs)$/.test(entry) && !/\.(test|spec)\.[cm]?[jt]sx?$/.test(entry)) out.push(path)
    }
  }
  return out
}

/** Reads one file out of a .tgz without unpacking it (tar -xO). */
function readTarballFile(file, path) {
  try {
    return execFileSync("tar", ["-xzOf", file, `package/${path}`], { encoding: "utf8", maxBuffer: 8 * 1024 * 1024 })
  } catch {
    return ""
  }
}

/** `^1.2.3` -> `1.2.3` for the "is the dev pin inside the peer range" check. */
function flatten(range) {
  return range.trim().replace(/^[\^~]/, "").split(" ")[0]
}

/** Minimal range check: enough for `>=x.y.z` and `^x.y.z` style peers. */
function rangeAdmits(range, version) {
  const parts = String(version).split(".").map(Number)
  for (const clause of range.split("||")) {
    const bounds = clause.trim().split(/\s+/).filter(Boolean)
    if (!bounds.length) continue
    if (bounds.every((bound) => satisfiesOne(bound, parts))) return true
  }
  return false
}

function satisfiesOne(bound, version) {
  const match = /^(>=|>|<=|<|=|\^|~)?v?(\d+)\.(\d+)\.(\d+)?/.exec(bound)
  if (!match) return true
  const [, operator = "=", major, minor = "0", patch = "0"] = match
  const target = [Number(major), Number(minor), Number(patch)]
  const atLeast = (a, b) => a[0] > b[0] || (a[0] === b[0] && (a[1] > b[1] || (a[1] === b[1] && a[2] >= b[2])))
  const atMost = (a, b) => a[0] < b[0] || (a[0] === b[0] && (a[1] < b[1] || (a[1] === b[1] && a[2] <= b[2])))
  switch (operator) {
    case ">=": return atLeast(version, target)
    case ">": return atLeast(version, target) && !(version[0] === target[0] && version[1] === target[1] && version[2] === target[2])
    case "<=": return atMost(version, target)
    case "<": return atMost(version, target) && !(version[0] === target[0] && version[1] === target[1] && version[2] === target[2])
    case "^": return target[0] === 0 ? atLeast(version, target) && version[0] === 0 && version[1] === target[1] : atLeast(version, target) && version[0] === target[0]
    case "~": return atLeast(version, target) && version[0] === target[0] && version[1] === target[1]
    default: return version[0] === target[0] && version[1] === target[1] && version[2] === target[2]
  }
}
