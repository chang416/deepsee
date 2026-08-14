# Configuring DeepSee

English | [中文](configure.zh-CN.md)

Read this when the user asks how to set up, configure, or switch DeepSee providers. Prefer running the commands for the user over explaining them.

## Where config lives

`~/.deepsee/config.json`, managed by the CLI. Precedence: CLI flags > environment variables > config file > built-in defaults. With no `provider` set, runs walk the failover chain in order (an available `gemini-api` key is tried before the agent CLIs); a machine with nothing configured at all ends up on `antigravity-cli`.

```bash
deepsee config init                     # write a starter config (refuses to overwrite; --force to redo)
deepsee config show                     # effective file, API keys masked
deepsee config set provider <name>      # change the default provider
deepsee config set <provider>.<field> <value>   # fields: apiKey, apiKeys, baseUrl, model, extraBody
```

`config set` writes the file with 0600 permissions.

## The file's exact shape

Everything lives under four top-level keys, all optional. This example shows every supported key and field at once (a real file only needs what you use). A missing file means all defaults. Provider settings sit under `providers.<name>`, not at the top level, which is the mistake hand-editors make most.

```json
{
  "provider": "gemini-api",
  "proxy": "http://127.0.0.1:7890",
  "reuse": { "claude": true, "codex": true, "opencode": false, "pi": true, "grok": true },
  "guards": {
    "allowModels": ["deepseek-v4-*", "glm-5.*", "minimax-m2.5*", "qwen3-coder*"],
    "denyModels": ["glm-*v*", "deepseek-vl*"],
    "denyWhenUnknown": false
  },
  "providers": {
    "antigravity-cli": { "model": "gemini-3.6-flash-low" },
    "gemini-api": {
      "apiKeys": ["AIza...one", "AIza...two"],
      "baseUrl": "https://generativelanguage.googleapis.com",
      "model": "gemini-flash-latest"
    },
    "openai": {
      "apiKey": "sk-...",
      "baseUrl": "https://dashscope.aliyuncs.com/compatible-mode/v1",
      "model": "qwen3.6-27b",
      "extraBody": { "thinking": { "type": "disabled" } }
    },
    "anthropic": {
      "apiKey": "sk-ant-...",
      "baseUrl": "https://api.anthropic.com",
      "model": "claude-haiku-4-5-20251001"
    },
    "claude-cli": { "model": "haiku" }
  }
}
```

Field semantics:

- `provider`: which provider runs when `-p` is not given. Canonical names or aliases both work (`agy`/`antigravity` for `antigravity-cli`, `gemini` for `gemini-api`, `openai-compat` for `openai`, `claude` for `anthropic`, `claude-code` for `claude-cli`). Empty or absent pins nothing: the failover chain decides, trying configured API providers before the agent CLIs.
- `providers.<name>.<field>`: `apiKey`, `apiKeys`, `baseUrl`, `model`, and `extraBody` are supported. `apiKeys` is the Gemini rotation list; it accepts a JSON array in the file or comma/newline input through `config set`, removes blanks and duplicates, and tries keys in order. The legacy singular `apiKey` remains compatible. Every provider entry is optional, and every field inside it is optional. Alias keys are read too (settings saved under `gemini` are found when `gemini-api` resolves), with the canonical key winning on conflict.
- `providers.<name>.extraBody`: a JSON object merged into the request body of the API providers (`gemini-api`, `openai`, `anthropic`), for whatever knobs that vendor has and deepsee has no flag for. Turning thinking off is the usual reason, see the section below. Nested objects merge key by key, so adding one knob leaves the rest of that block alone. The fields carrying the image, the prompt, and the schema enforcement are refused with an error naming the field. The two CLI providers take no request body, so a run on `antigravity-cli` or `claude-cli` ignores it and says so in `meta.warnings`.
- `guards`: the invocation guard, for people who run both text-only and vision-capable models through the same client. Both lists hold glob patterns (`*` and `?`, case-insensitive, matched against the model name and `provider/model`), set with `deepsee config set guards.denyModels '["gemini-3*"]'` or `guards.allowModels` (a JSON array or a comma-separated list, empty clears). Two ways to express the same intent, pick the shorter list:
  - `denyModels` alone: everything runs the engine except the listed vision models. Right when text-only models are the majority of what you plug in.
  - `allowModels` non-empty (allowlist mode): only the listed models run the engine, every other identified model is denied. Right for the actual 2026 landscape, where text-only models are the short list. A deny pattern still wins over an allow match, so a broad allow can have its vision variants carved out, as in the example above: `glm-5.*` allows the text line while `glm-*v*` catches `glm-5v-turbo`. Anchor allow patterns tightly (`deepseek-v4-*`, not `deepseek*`) so a vendor's next multimodal generation falls off the list and steps aside until you have checked it.
  - List a model by what actually reaches it, not by what it could see: a multimodal model behind a gateway that strips images still needs deepsee, and your session transcript records the model name the gateway reports. `deepsee doctor`'s Guard section shows the rules and a live verdict for checking the result.
  - `denyWhenUnknown` (default `false`) decides what happens when no signal identifies the active model, in either mode: `false` proceeds, `true` denies. The active model is detected from, strongest first: the `DEEPSEE_MODEL` env var (`none` means "treat as unknown"), the harness's session storage, the `--model` self-report.
- Environment variables override the file. Gemini precedence is `GEMINI_API_KEYS` (comma or newline list) > `GEMINI_API_KEY` > file `apiKeys` > file `apiKey`. The other bindings are `OPENAI_API_KEY`, `OPENAI_BASE_URL`, `ANTHROPIC_API_KEY`, and `ANTHROPIC_BASE_URL`. Beyond those, deepsee reads `DEEPSEE_HARNESS` (paste-recovery and guard scope), `DEEPSEE_MODEL` (guard override, see `guards`), and the fingerprints harnesses inject themselves, which pin the guard's storage lookup to the current session: `CLAUDE_CODE_SESSION_ID`, `CODEX_THREAD_ID`, plus the presence markers harness detection relies on (`CLAUDECODE`, `PI_CODING_AGENT`, `CODEX_SANDBOX`).
- `reuse.<claude|codex|opencode|pi|grok>`: per-harness grants for spending other local logins, written by the onboarding conversation (`references/onboard.md`). `true` lets reads reuse that harness (pi credentials join the inline region with every guard intact; a signed-in Codex, an OpenCode vision model, or pi driven directly join the agent region before `claude-cli`), `false` records a refusal so the user is never re-asked, absent means never asked and nothing runs. `claude` absent counts as granted: `claude-cli` predates this model as a built-in provider, and `reuse.claude false` removes it from the chain (`-p claude-cli` still pins). Reused engines get no priority over the user's own: regions order by speed class only. Every reused answer adds a `meta.warnings` line naming whose quota it spent, and `deepsee doctor`'s Reuse section shows each harness's decision plus what discovery found (probe results cache for 6 hours in `~/.deepsee/auto-cache.json`; doctor always re-probes). Set with `deepsee config set reuse.codex true` (empty clears back to never-asked).
- Unknown top-level keys and unknown provider names are ignored rather than rejected, so a typo fails quiet: run `deepsee doctor` after hand-editing, it shows which file and env values are actually in effect.

Hand-editing is fine (keep the file valid JSON and its permissions 0600). `deepsee config set` does the same thing with guardrails.

## Provider setup recipes

### antigravity-cli (default, free, no key)

Needs Antigravity CLI installed and signed in:

```bash
curl -fsSL https://antigravity.google/cli/install.sh | bash
agy    # user must complete browser sign-in themselves, then exit
```

Any free Google account works; no Google AI Pro needed. Sign-in cannot be automated, ask the user to run `agy` once.

### gemini-api (free key, fastest free route, 5-10s)

1. The user creates a key at https://aistudio.google.com (three minutes, no credit card, free tier does not expire).
2. Store one key, or paste several keys separated by newlines:

```bash
deepsee config set gemini-api.apiKey <key>
# or environment: export GEMINI_API_KEY=<key>
# several keys: deepsee config set gemini-api.apiKeys $'key-one\nkey-two'
# or environment: export GEMINI_API_KEYS=$'key-one\nkey-two'
```

On 401, 403, 429, or an explicitly quota-labelled 4xx response, DeepSee advances to the next key. Ordinary bad requests, network failures, and server failures are surfaced immediately because changing credentials would only repeat the same failure. `deepsee config show` reports only the number of plural keys, never their values. In DeepSeek Harness, the same list is editable from **DeepSee Settings**; the browser can read only the key count.

The default is Google's moving `gemini-flash-latest` alias, so a newly released Flash generation becomes available without a DeepSee update. Google may point this alias at a stable, preview, or experimental release. Users who need reproducible behavior can pin a version with `deepsee config set gemini-api.model <model-id>`. Free-tier limits vary by the model currently behind the alias. Free-tier data may be used by Google to improve products; mention this if the user handles sensitive images.

### openai (any OpenAI-compatible multimodal endpoint)

Needs three values. Example for DashScope qwen:

```bash
deepsee config set openai.baseUrl https://dashscope.aliyuncs.com/compatible-mode/v1
deepsee config set openai.apiKey <sk-key>
deepsee config set openai.model qwen3.6-27b
```

For official OpenAI: baseUrl `https://api.openai.com/v1`, a vision-capable model. Environment equivalents: `OPENAI_BASE_URL`, `OPENAI_API_KEY`. The model must be multimodal; text-only models will fail or hallucinate. This route has no server-side schema enforcement, so occasional shape failures are surfaced as explicit errors; retry or switch provider.

### anthropic (Claude API key)

```bash
deepsee config set anthropic.apiKey <sk-ant-key>
# or: export ANTHROPIC_API_KEY=<key>
```

Default model is Claude Haiku (`claude-haiku-4-5-20251001`). Schema is enforced through a forced tool call.

**`ANTHROPIC_BASE_URL` trap.** deepsee binds `ANTHROPIC_BASE_URL` to `anthropic.baseUrl`, so it inherits whatever that variable points at. If the user set it in their shell to route Claude Code through a text-only gateway (a common way to run a non-Claude model behind the Claude Code UI), then `-p anthropic` silently sends the vision request to that gateway too, where it fails or comes back blind, with no hint that the endpoint was swapped. Check `echo $ANTHROPIC_BASE_URL` when anthropic vision misbehaves. Fixes: unset it for the deepsee call, pin the real endpoint with `deepsee config set anthropic.baseUrl https://api.anthropic.com`, or use `-p gemini-api` instead.

### claude-cli (Claude Code login, no key)

Rides an existing `claude` sign-in, so it costs the user's Claude subscription quota, not a separate API bill. Requires Claude Code installed and logged in (`claude --version` to check). Runs with `--allowedTools Read` only. Local image files only; for remote URLs use gemini-api instead. Default model alias `haiku`.

```bash
deepsee config set provider claude-cli   # make it the default if the user wants
```

## Turning thinking off

A reasoning model spends its thinking budget before it answers. Reading text out of an image needs none of that, so on a model that thinks by default the run is slower and more expensive for nothing. Every vendor names the switch differently, and there is no portable one, so deepsee sends whatever you put in `extraBody` and leaves the naming to the vendor's own docs.

```bash
deepsee config set openai.extraBody '{"thinking":{"type":"disabled"}}'   # persist it
deepsee -i shot.png --extra-body '{"thinking":{"type":"disabled"}}'      # one run only
deepsee config set openai.extraBody ''                                   # clear it
```

`--extra-body` replaces the stored object for that run rather than merging into it.

Known spellings, current as of August 2026:

| Endpoint | Field to send |
| :-- | :-- |
| MiMo official API (`api.xiaomimimo.com/v1`) | `{"thinking":{"type":"disabled"}}` |
| MiMo Responses-format route | `{"reasoning":{"effort":"none"}}` |
| Qwen, GLM, MiMo and friends self-hosted on vLLM or SGLang | `{"chat_template_kwargs":{"enable_thinking":false}}` |
| OpenAI-style gateways that accept an effort level | `{"reasoning_effort":"low"}` |
| `gemini-api`, Gemini 3 family | `{"generationConfig":{"thinkingConfig":{"thinkingLevel":"LOW"}}}` |
| `gemini-api`, Gemini 2.5 Flash and Flash Lite | `{"generationConfig":{"thinkingConfig":{"thinkingBudget":0}}}` |
| `anthropic` | nothing to do, thinking is off unless it is asked for |

Three things that bite:

- Not every model can turn it off. Gemini 3 Pro and Gemini 2.5 Pro have no off switch, only a lower level. Some models ignore an effort field entirely and think anyway.
- Strict clouds (Groq and Cerebras among them) reject fields they do not recognize with a 400. If a request that worked before now fails with a 400 naming your field, that gateway wants a different spelling, not this one.
- Others accept an unknown field and quietly ignore it, so check that it took effect instead of assuming. Compare `meta.durationSeconds` and the token counts in `meta.usage` against a run without `extraBody`. If neither moved, the field did not land.
- A weaker model may need its thinking to fill the schema. Measured on one flowchart: `gemini-3.6-flash` at `thinkingLevel: LOW` came back in 5.7s instead of 12s with the same regions and the same transcription, but `qwen3.6-27b` on DashScope with `enable_thinking: false` started omitting the required `type` on layout regions, which deepsee rejects rather than passing off as evidence. If shape errors appear right after you turn thinking off, that is the trade, so turn it back on for that model or move to a route with server-side schema enforcement.

## Choosing a provider for the user

- Wants zero setup and free: `antigravity-cli` (needs agy sign-in, 15-40s per image; for dense or hard images try `-m gemini-3.1-pro-high`).
- Wants fast and free: `gemini-api` (three-minute key, 5-10s).
- Already pays for Claude: `claude-cli` (no extra key, 20-45s agent loop) or `anthropic` (API billing).
- Has a favorite multimodal endpoint (qwen, GLM, ...): `openai`.

Every configured provider also backs up the others: a run tries them in a
fixed order (inline API providers first at 5-10s, then the agents; for remote
URLs the order is also a security boundary) and fails over on an error, a
timeout, or a schema-violating result.
`config set provider <name>` moves a provider to the front of its allowed
region; `-p <name>` pins exactly one with no fallback. `doctor` prints the
chains, and the result's `meta.attempts` shows what a run actually tried.

## Troubleshooting

- Error names a missing env var or `config set` command: run exactly that.
- `Provider CLI not found: agy`: install Antigravity CLI or switch provider.
- `Claude CLI reported ...` or empty result: check `claude` login state.
- openai route `does not match the vision schema`: retry once, then switch to gemini-api or anthropic.
- `extraBody cannot override "<field>"`: that field carries the image, the prompt, or the schema. Drop it from the object and keep the vendor knobs.
- A 400 that names a field you set in `extraBody`: that gateway does not know it. See the thinking section above for the other spellings.
- `config init` refusing to run: the file exists; use `deepsee config show` first, `--force` only if the user agrees to overwrite.
