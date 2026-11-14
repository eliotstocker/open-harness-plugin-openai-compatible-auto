# AGENTS.md

Multi-host TypeScript plugin (`@eliotstocker/open-harness-plugin-openai-compatible-auto`) providing `/v1/models` (plus optional `/v1/model/info` and `/v1/me`) discovery and LiteLLM browser CLI auth for OpenCode V2, Pi, and DeepSeek Harness (DSH).

## Commands

Run checks in this order (matches `.github/workflows/release.yml`):

```bash
npm run typecheck   # tsc --noEmit
npm run build       # tsc -> dist/ (gitignored)
```

- Node 24 is used in CI. No test suite or linter is configured.

## Architecture & Entrypoints

- `src/core/auth.ts` and `src/core/discovery.ts` — host-agnostic Node-only core (`node:crypto`, `node:http`, `fetch`). Keep free of host-specific imports.
- `src/index.ts` -> `dist/index.js` (`.`) — OpenCode V2 / OpenWork V2 plugin (`Plugin.define`).
- `src/pi.ts` -> `dist/pi.js` (`./pi`, `pi.extensions`) — Pi extension (`registerProvider`).
- `src/dsh.ts` -> `dist/dsh.js` (`./dsh`, wired via `cordis.patch.yml` and `dsh.bundle`) — DSH Cordis bundle plugin (`export const name = "openai-auto"`, `inject = ["llm"]`).
- `src/index.js` — stale CommonJS file left in `src/` referencing nonexistent `../providers/openapi`. `tsc` ignores it (`allowJs` is off) and `package.json` points to `dist/index.js`; ignore it unless cleaning up intentionally.

## Repo-Specific Rules & Quirks

- **ESM `.js` extensions:** `tsconfig.json` uses `"module": "NodeNext"` / `"moduleResolution": "NodeNext"`. Relative imports in `src/` must use `.js` specifiers (e.g. `./core/auth.js`).
- **Dependency boundaries:** `@opencode/plugin` is a runtime `dependency`; `@earendil-works/*` (Pi) and `@deepseek-ai/*` (DSH/Cordis) are **optional `peerDependencies`** (mirrored in `devDependencies` for builds). Do not move Pi/DSH packages into `dependencies` or import them from `src/index.ts` or `src/core/*`.
- **DSH Cordis wiring:** `cordis.patch.yml` is shipped in `files` and `exports` and maps `id: openai-auto` to `@eliotstocker/open-harness-plugin-openai-compatible-auto/dsh`. Keep `export const name = "openai-auto"` in `src/dsh.ts` aligned with `cordis.patch.yml`.
- **URL handling (`rootURL` vs `v1URL`):** `rootURL()` strips trailing slashes and `/v1`; `v1URL()` ensures `/v1`. Auth endpoints (`/.well-known/litellm-cli-auth`, `/sso/cli/start`, `/sso/cli/poll`, `/sso/key/generate`, `/key/generate`) use `rootURL`; model/user endpoints (`/v1/models`, `/v1/model/info`, `/v1/me`) and provider `baseURL`/`baseUrl` configs use `v1URL`.
- **Browser auth flow order:** `startLiteLLMInteractive()` requires `https:` (or `http:` on loopback only) and enforces same-origin endpoints on PKCE discovery. It tries: (1) `/.well-known/litellm-cli-auth` PKCE with ephemeral `127.0.0.1` callback, (2) `/sso/cli/start` + `/sso/cli/poll`, (3) `/sso/key/generate` manual token paste + optional `/key/generate` exchange.
- **OpenCode reload loop guard:** In `src/index.ts`, `ctx.provider.reload()` emits `provider.updated`, so the event subscriber only force-bypasses the 5-minute model cache on `credential.switched`.
- **Releases:** Pushes to `main` run `semantic-release` (`.releaserc.json`), which publishes to both npm and GitHub Packages (`npm.pkg.github.com`) and commits `CHANGELOG.md`, `package.json`, and `package-lock.json`. Use Conventional Commits (`feat:`, `fix:`, etc.) and do not manually bump versions or edit `CHANGELOG.md`.
