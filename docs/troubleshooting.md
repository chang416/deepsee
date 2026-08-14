---
summary: 'Troubleshooting: every error deepsee can print, what causes it, what to do'
read_when:
  - A run failed and the message is not self-explanatory
  - recover-paste found nothing, or found the wrong image
  - Deciding whether a failure is setup, quota, or a bug
---

# Troubleshooting

English | [中文](troubleshooting.zh-CN.md)

Start with `deepsee doctor`: it checks your Node version, which providers are ready, which one will be selected and why, and the detected harness, all without spending quota or making a network request. It catches most setup problems before you read any further.

Every message below is one deepsee actually prints. Search this file for the words you saw.

## Antigravity CLI cannot read its stored login token

```
Antigravity CLI cannot read its stored login token.

On Linux this usually means the OS keyring is locked, which is normal for headless
sessions (agents, cron, systemd, SSH without a desktop login) ...
```

agy keeps its token in the OS keyring. When the keyring is locked, agy reports itself as signed out and tries a browser sign-in that cannot finish without a display. Three ways forward:

- Unlock the keyring, or run deepsee from a desktop session.
- Sign in again with `agy`.
- Switch to a provider that needs no interactive login:

```bash
deepsee config set gemini-api.apiKey <key>   # free key: https://aistudio.google.com
deepsee config set provider gemini-api
```

## Quota exhausted

```
Individual quota reached. ... Resets in 94h19m9s.

agy's free tier is one weekly bucket shared by the desktop app, the CLI, and the SDK ...
```

Wait for the reset, or move to `gemini-api`, which has its own budget. Parallel subagents drain the shared bucket fast, so a heavy day can end it.

## Provider CLI not found

```
Provider CLI not found: agy (spawn ENOENT). Install it and sign in first.
```

The binary is not on PATH, or `--provider-bin` points somewhere wrong. A different spawn-level failure (`... could not start \`claude\`: spawn EACCES`) keeps its real error code so the cause is nameable. On Windows the npm-installed CLIs are `.cmd` shims; deepsee resolves them through PATHEXT and runs their real Node entry directly, so neither the bare name (ENOENT) nor the `.cmd` (EINVAL) trips it up.

```
Working directory does not exist: /some/path
```

Different cause, same underlying error code from the OS: `--workdir` points at a directory that is not there. The binary is fine.

## recover-paste found nothing

```
No pasted images found in any session storage for this directory (looked in: ...)
```

In order of likelihood:

- **You are in the wrong directory.** Recovery is scoped to the project the conversation is happening in. Pass `--cwd /path/to/project`.
- **Nothing was pasted.** Dragged files and typed paths are already real files, so there is nothing to recover: use the path directly.
- **A setup problem is blocking one harness.** Anything blocking appears after `Blocked:` in the same message, for example OpenCode needing Node 22.13+ for `node:sqlite`.

## recover-paste returned an image from another project

This should not happen any more, and if it does it is a bug worth reporting. Recovery checks the working directory recorded inside the transcript, not just the directory name, because directory slugs collide (`/tmp/a.b` and `/tmp/a-b` produce the same one). Include the `harness` and `transcript` fields from the output in the issue.

## Recovered the wrong image from the right project

The output lists images oldest to newest, so the **last** entry is the most recent paste. Entries carry `filename` when the harness stored one: match on that when the user mentioned a name. `--count 3` gives you more to choose from.

## recover-paste: overriding detection and output location

`recover-paste` auto-detects which harness it runs inside (process ancestry first, then environment fingerprints) and reads only that harness's storage. Two knobs override it:

- **`DEEPSEE_HARNESS`** forces the storage scope without a flag: `claude-code`, `pi`, `opencode`, `codex`, or `none` (scan every store, no scoping). Detection reads it first, so it wins over ancestry and env fingerprints. `--harness` does the same for a single run.
- **`--out-dir`** sets where recovered images land. By default each run mints a fresh, unpredictable `<tmpdir>/deepsee-paste-*` directory (0700, holding 0600 files), so nobody can pre-create a shared path to intercept the bytes. Point it elsewhere when the system temp dir is not where you want them. An explicit `--out-dir` that already exists is rejected unless it is a real directory (not a symlink), owned by you, with no group or world access. On Windows those ownership and permission checks are skipped, since the platform has no POSIX bits (see the Windows section below). The symlink guard still applies.

## This is a Codex session

```
This is a Codex session: pasted images already exist as temp files, and each image
tag in the message carries its path.
```

Working as intended. Codex writes pasted images to disk and puts the path in the message, so read the path out of the tag instead of recovering anything.

## The openai provider rejected a result

```
OpenAI-compatible API returned JSON that does not match the vision schema
(missing: ocr, ocr.full_text, ...)
```

That endpoint returned a partial result. Only agy, gemini-api, anthropic, and claude-cli enforce the schema server-side, so weaker gateways can produce half a result. Retry once, then switch:

```bash
deepsee -i <image> -p gemini-api
```

## The guard said deny, or a read was refused

```
Invocation guard denied this read: active model "gemini-3.1-pro" matches guards.denyModels pattern "gemini-3*". A model with native vision should read the image itself. To override, unset DEEPSEE_MODEL or edit guards in /Users/you/.deepsee/config.json.
```

Working as configured: `guards.denyModels` in the config file lists vision-capable models, and the active model matched one, so the engine refused to spend a provider call on an image that model can read itself. `deepsee doctor` has a Guard section showing the rules, which model was detected, from which signal (the `DEEPSEE_MODEL` env var, session storage, or a `--model` self-report), and the verdict.

If the detection is wrong, `DEEPSEE_MODEL=<actual-model> deepsee guard` overrides everything, and `DEEPSEE_MODEL=none` marks the model as unknown (the verdict then follows `denyWhenUnknown`, default allow). To turn the guard off entirely: `deepsee config set guards.denyModels ''`.

One known blind spot: storage detection reads the newest assistant turn recorded for this project, so two sessions running different models in the same project directory at the same time can shadow each other (Claude Code and Codex pin the exact session through their injected session ids, Pi and OpenCode cannot). When that bites, `DEEPSEE_MODEL` is the override.

Note that the hard refusal above only fires on an actual `denyModels` match against the explicit `DEEPSEE_MODEL` value. Storage detection and the `denyWhenUnknown` policy never block `analyze`, they only speak through `deepsee guard`, whose deny is advice to the agent rather than a locked door.

## dsh says "declares no dsh.bundle — installed as a plain dependency"

The dsh profile installed an old deepsee version. The `dsh.bundle` declaration
exists since 3.9.0, and pnpm v11's release-age gate (`minimumReleaseAge`,
quarantining recently published versions, with a 10-day window measured on pnpm 11.21) silently falls back to an older version when every
recent one is inside the window. That old version has no bundle declaration,
so dsh correctly treats it as a plain dependency and none of the tools appear.

The fix: name the version explicitly. pnpm applies the age gate when resolving
a range, but an explicit version or dist-tag skips it ([pnpm#9989](https://github.com/pnpm/pnpm/issues/9989), verified on pnpm 11.21), which is why the install
command carries `@latest`:

```sh
npx -y @deepseek-ai/dsh plugin --profile <name> add @chang416/deepsee@latest
```

dsh's reconcile notices the bundle declaration on the new version and
activates it; restart dsh afterwards. Verify with
`npx -y @deepseek-ai/dsh plugin --profile <name> list` — the version shown
should be 3.9.0 or newer.

If a future pnpm closes that skip, the durable alternative is a one-time
exclusion in `~/.dsh/profiles/<name>/pnpm-workspace.yaml` — the bare package
name, not `name@version`, so it survives future releases:

```yaml
minimumReleaseAgeExclude:
  - 'deepsee'
```

then `npx -y @deepseek-ai/dsh plugin --profile <name> update deepsee`.
The trade-off is honest either way: an explicit `@latest` (or the exclusion)
opts deepsee out of pnpm's supply-chain cooling-off window, so new releases
install immediately.

## fetch failed, or could not connect

```
Could not connect to generativelanguage.googleapis.com (UND_ERR_CONNECT_TIMEOUT). The request never reached the network. ...
```

The API request never left the machine. On networks that reach the internet
through a proxy this is expected: Node's fetch ignores the proxy environment
variables by default. deepsee honors them once you ask it to route that way,
in either form:

```bash
HTTPS_PROXY=http://127.0.0.1:7890 deepsee -i shot.png -p gemini-api   # env (NO_PROXY honored too)
deepsee config set proxy http://127.0.0.1:7890                        # persistent, all API providers
deepsee config set openai.proxy http://127.0.0.1:7890                 # one provider only
```

The proxy applies to API provider requests only. The remote-image download
path keeps its direct, IP-pinned connection on purpose: its SSRF guards
validate the exact address being contacted, and a proxy would blind them. On
a proxied machine, prefer local files or let the failover chain hand remote
URLs to a provider that fetches them upstream.

## Config file problems

```
Cannot read /Users/you/.deepsee/config.json: EACCES ... Fix the file or its permissions.
```

The file exists but is unreadable. A missing file is fine, so this is a real problem rather than something to ignore.

```
Failed to parse ... Fix or delete the file.
```

Invalid JSON. `deepsee config init --force` writes a clean one, losing the old contents.

## Timeouts

```
antigravity-cli provider timed out after 210000 ms.
```

Retry once with `--timeout 300000`. Dense images on agy legitimately take 15-40 seconds, and `-m gemini-3.1-pro-high` is slower still. Engines that ignore SIGTERM are escalated to SIGKILL, so a timeout returns promptly regardless.

## Every read is slow on a reasoning model

A model that thinks by default spends its budget before it starts transcribing, which a vision read does not need. There is no `--no-thinking` flag because each vendor names the switch differently, so pass the vendor's own field:

```bash
deepsee config set openai.extraBody '{"thinking":{"type":"disabled"}}'
deepsee -i shot.png --extra-body '{"reasoning_effort":"low"}'    # one run only
```

The per-vendor spellings, which models cannot turn it off at all, and how to tell whether the field actually landed are in [Configuration](../skills/deepsee/references/configure.md#turning-thinking-off).

```
extraBody cannot override "messages" for the openai provider
```

That field carries the image, the prompt, or the schema enforcement. Remove it and keep the vendor knobs. A 400 from the gateway naming a field you set means that endpoint uses a different spelling, and a run on `antigravity-cli` or `claude-cli` says in `meta.warnings` that it ignored the value, since a CLI provider has no request body.

## Windows

DeepSee runs on Windows. Three platform differences are worth knowing:

- **No POSIX permission checks.** Windows files carry no owner, group, or world bits (they read back as `0o666`/`0o777`, with access governed by ACLs), so `doctor` does not judge the config file's mode and `recover-paste --out-dir` does not reject a directory on ownership or group/world access. The symlink guard on `--out-dir` still applies.
- **Harness detection uses environment fingerprints.** There is no `ps` to read the process tree, so detection relies on the environment variables each harness sets. If a run guesses wrong, force it with `--harness <name>` or `DEEPSEE_HARNESS`.
- **Paste recovery.** OpenCode recovery is covered on Windows (issue #11). The Claude Code and Pi JSONL paths depend on `os.homedir()` and each harness's on-disk slug there. If recovery comes up empty, pass `--transcript` at the file, or drag the image into the terminal.

## Still stuck

Include the exact command and the full error in an issue: https://github.com/chang416/deepsee/issues
