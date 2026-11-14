# @eliotstocker/open-harness-plugin-openai-compatible-auto

Multi-host plugin for OpenAI-compatible endpoints with:
- Automatic `/v1/models` (and optional LiteLLM `/v1/model/info`) model discovery
- Browser-based LiteLLM sign-in via CLI code flow (`/.well-known/litellm-cli-auth` PKCE, `/sso/cli/start` + `/sso/cli/poll`, and `/sso/key/generate` fallback)
- API key + Base URL configuration

Supports **OpenCode V2**, **OpenWork V2**, **Pi**, and **DeepSeek Harness (DSH)** from one package.

## Build

```bash
npm install
npm run build
```

## Install & Use

### OpenCode V2 / OpenWork V2
Add the package to `~/.config/opencode/opencode.json` (or `opencode.jsonc`):

```jsonc
{
  "plugin": [
    "@eliotstocker/open-harness-plugin-openai-compatible-auto"
  ]
}
```

Then run `/connect` -> **OpenAI-Compatible (Auto)** -> **LiteLLM CLI Code Flow (Browser)** (or **API Key**), and `/models`.

### Pi (`@earendil-works/pi-coding-agent`)
Install as a Pi package:

```bash
pi install npm:@eliotstocker/open-harness-plugin-openai-compatible-auto
```

Or test for one run:

```bash
pi -e npm:@eliotstocker/open-harness-plugin-openai-compatible-auto
```

Then run `/login openai-auto` (supports **LiteLLM CLI Code Flow (Browser)** and **OpenAI-Compatible API Key**), and `/model` to select auto-discovered models.

### DeepSeek Harness (`@deepseek-ai/dsh` / `dsh-tui`)
Add to your DSH profile (e.g. `dsh-tui`, `web`, `acp`, `headless`):

```bash
# For dsh-tui (@deepseek-harness-tui/dsh-tui / dst)
dsh plugin --profile dsh-tui add @eliotstocker/open-harness-plugin-openai-compatible-auto

# For Web UI
dsh plugin --profile web add @eliotstocker/open-harness-plugin-openai-compatible-auto
```

Then sign in via `/login openai-auto` (or the Web UI Models/Auth panel) using **LiteLLM CLI Code Flow (Browser)** or **API Key + Base URL**, or configure `openai-auto` in `settings.yaml`.

### GitHub Packages (optional)
To install from GitHub Packages instead of npm, configure `@eliotstocker:registry=https://npm.pkg.github.com` in `~/.npmrc`.

## Exports

- `.` — OpenCode V2 plugin (`src/index.ts`)
- `./pi` — Pi extension (`src/pi.ts`, also declared under `pi.extensions`)
- `./dsh` — DSH Cordis bundle plugin (`src/dsh.ts`, wired via `cordis.patch.yml` and `dsh.bundle`)
