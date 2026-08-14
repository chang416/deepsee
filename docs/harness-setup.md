---
summary: 'Harness setup: how images reach the model in Codex, Claude Code, Pi, and OpenCode'
read_when:
  - Setting deepsee up inside a specific coding agent
  - A pasted image is not reaching the model
  - Understanding what recover-paste does per harness
---

# Harness setup

English | [中文](harness-setup.zh-CN.md)

Where a pasted image ends up differs per harness, and deepsee takes a different route in each. `recover-paste` detects which harness it runs inside (process ancestry, then environment fingerprints) and reads only that harness's storage.

## Codex

Pasted images become real temp files, and the message carries a tag like `<image name=[Image #1] path="/tmp/xxxx.png">`. The skill reads the path out of the tag. `recover-paste` detects Codex and refuses, pointing back at the tag.

One catch with text-only models: once `models.json` declares `input_modalities: ["text"]`, the Codex TUI blocks Ctrl+V paste outright. Drag the file into the terminal, type its path, or use `codex exec -i image.png "..."`.

## Claude Code, Pi, OpenCode

None of them hands the model a usable temp-file path the way Codex does (newer Claude Code builds do write pastes to their own `~/.claude/image-cache/`, injected as a path line only in the terminal entrypoint), but all three persist the user message locally before any gateway strips it:

| Harness | Storage | Notes |
| :-- | :-- | :-- |
| Claude Code | `~/.claude/projects/<slug>/<session>.jsonl` | images as base64. The injected `CLAUDE_CODE_SESSION_ID` targets the exact session |
| Pi | `~/.pi/agent/sessions/--<encoded-cwd>--/*.jsonl` | same shape as Claude Code |
| OpenCode | `~/.local/share/opencode/opencode.db` | SQLite, images as data URLs (read via `node:sqlite`) |

Running a text-only model behind `ANTHROPIC_BASE_URL` in Claude Code, a pasted image arrives as a pathless `[Unsupported Image]` placeholder (on lenient gateways) or breaks the request outright ([#62009](https://github.com/anthropics/claude-code/issues/62009)). The bytes are not gone, and that is what `recover-paste` retrieves.

## Skill locations

| Harness | Reads skills from |
| :-- | :-- |
| Claude Code | `~/.claude/skills/` |
| Codex | `~/.codex/skills/` |
| Pi, OpenCode | `~/.agents/skills/` |

Symlinks work in all of them, so linking the skill folder once keeps every agent on the latest version.

## Platform support

macOS and Linux are fully supported and verified in CI on Node 22 and 24.

Windows runs the same CI matrix. Detection there skips the process-ancestry pass, since there is no `ps`, and falls back to the environment fingerprints above, so a harness that sets none of them reads as undetected (force it with `--harness` or `DEEPSEE_HARNESS`). OpenCode paste recovery is covered on Windows, including the path-separator normalization from [#11](https://github.com/chang416/deepsee/issues/11): opencode records `session.directory` with forward slashes while `path.resolve` returns backslashes there, and both sides are normalized before matching. The JSONL stores (Claude Code, Pi) key off `os.homedir()` and each harness's own on-disk slug, and are exercised on POSIX. External engines (Antigravity CLI, the Claude CLI) run only where they ship a Windows build.

## Gateway setups

OpenCode with DeepSeek: `opencode auth login`, pick DeepSeek and paste the key (it lands in `~/.local/share/opencode/auth.json`), then set the default model in `~/.config/opencode/opencode.jsonc` to `deepseek/deepseek-v4-flash`. Pi reads its key from `~/.pi/agent/auth.json`.

## DeepSeek Harness (dsh)

dsh is different from the other harnesses: deepsee plugs in as a native tool, not a prompt-triggered skill. The package itself is a dsh bundle, so one command installs it into a profile:

```sh
npx -y @deepseek-ai/dsh plugin --profile web add @chang416/deepsee@latest
```

This registers a `read_image` tool whose schema reaches the model on every request (no trigger heuristics), runs the deepsee CLI shipped inside the same package, and returns the structured evidence as the tool's canonical JSON output. Engines, reuse grants, and guard rules stay in `~/.deepsee/config.json`, shared with every other harness. dsh is in developer preview and its plugin surface may change; the plugin keeps its touch small (raw tool registration, the llm adapter surface for the vision variants, the attachment reader, and one agent pre-step hook) and degrades loudly if any of them moves.

### Auto, Customize, and OpenCode routes

When dsh's in-process subagent service is available, every wrapped DeepSeek provider adds **DeepSee Auto** and **DeepSee Customize** beside its direct Flash and Pro entries. Auto uses the built-in free-first task map; Customize uses the map in DeepSee Settings. The coordinator calls `deepsee_delegate` once per bounded subtask, independent calls are concurrency-safe, and every child is forced onto a live DeepSeek V4 route. Gemini remains vision-only and never receives a coding task.

Route discovery is provider-neutral. A user may use the official DeepSeek adapter, OpenCode Zen's free `deepseek-v4-flash-free`, or OpenCode Go's `deepseek-v4-flash` and `deepseek-v4-pro`. DeepSee reads the live provider catalogs instead of assuming a credential exists. It prefers the currently selected upstream, then another live wrapped route when that lane is unavailable. OpenCode's free model has its own rate limit; OpenCode Go uses the subscription quota.

The browser bundle adds a small **DeepSee Settings** entry. The first click on DeepSee Customize checks whether a policy was saved and opens that panel when onboarding is still incomplete. The same panel accepts multiple Gemini API keys, one per line. The settings endpoint returns only the number of saved keys, never their values.

### Visual self-check before delivery

Auto and Customize also register `deepsee_visual_check`. For work that changes a UI, rendered document, chart, styling, layout, or another visible state, the coordinator uses it after meaningful milestones and again before final delivery. It can capture a running local preview or inspect an existing screenshot. Gemini returns structured evidence and one of three machine-readable verdicts: `pass`, `needs-fix`, or `unknown`. A contradictory response that says PASS while listing a BLOCKER, HIGH, or MEDIUM defect is treated as `needs-fix`.

The coordinator sends every material defect back into the DeepSeek coding loop, then checks the corrected render. The default limit is two paid/free-provider calls per phase; identical image, prompt, and reference combinations reuse an in-memory result rather than spending another Gemini request. The Settings panel controls milestone checks, the final PASS gate, the maximum 1–4 rounds, the viewport, and an optional default preview URL.

Preview capture is deliberately local-only: `http` or `https` on `localhost`, `127.0.0.0/8`, or `[::1]`. DeepSee refuses credentials and non-loopback hosts. A discovered Chrome, Chromium, or Edge executable runs headlessly with a fresh temporary profile; the profile is removed after capture. If a browser or preview cannot be started, DeepSee reports that exact blocker instead of claiming visual completion. For non-web work, the tool accepts an absolute screenshot path and an optional absolute reference image.

### Paste-to-path (web profile)

Pasting an image into the dsh Web UI under a **text-only model** used to die at
image admission. The plugin now ships a browser half (loaded automatically by
dsh's client plugin system) that takes over the paste in exactly that case:
the image bytes go to the plugin's `/deepsee/paste` route on the dsh web
server (loopback, magic-byte checked, 25 MB cap), land as a private temp file,
and the composer receives the file path as plain text — the same shape Pi,
OpenCode, and Claude Code hand their models, and the deepsee skill's and
`read_image` tool's primary trigger. Admission never fires because the message
carries no image attachment.

The takeover is conditional, and the decision is the host's: the browser half
asks the plugin's route whether the currently selected model is text-only,
and the host answers from the provider registry's declared model metadata
(`inputModalities`), not from a name heuristic. A `(deepsee vision)` variant
or any model that declares image input keeps its native paste flow (variants
convert at request time with the thumbnail preserved; vision models read
images themselves), and so does any model the host cannot resolve. Pastes
stay native until the host has confirmed a takeover is right. A model whose
metadata declares no input modalities counts as unresolved: absent metadata is
never read as "confirmed text-only". Verdicts also age out (60s), so a route
whose models changed mid-session is re-asked, not trusted forever.
`pasteToPath: false` in the plugin row turns the whole feature off: the
browser half stands down when the policy endpoint 404s. If the route vanishes
mid-session after a verdict already confirmed it, the pastes made in the
brief window before the failed upload comes back (one local round-trip) are
lost. The client then forgets its verdicts and every later paste goes
native.
