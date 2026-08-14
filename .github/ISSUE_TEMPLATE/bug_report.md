---
name: Bug report
about: A command failed, recovered the wrong thing, or produced wrong output
title: ''
labels: bug
assignees: ''
---

Before filing, check [docs/troubleshooting.md](../../docs/troubleshooting.md), which lists DeepSee's diagnostics with likely causes and fixes. Search existing [issues](https://github.com/chang416/deepsee/issues) first.

## What happened

A clear description of the problem.

## The exact command

Paste the full command, redacting only real API keys.

```bash
deepsee ...
```

## The full error

Paste the complete output, not a paraphrase. Include everything after `Blocked:` if it appears.

```
...
```

## Harness and environment

- Harness (Claude Code / Codex / Pi / OpenCode / plain terminal):
- Provider (`-p`): 
- `deepsee --version`:
- `node --version`:
- OS:

For a `recover-paste` issue, also include the `harness` and `transcript` fields from the output, and how the image got into the chat (pasted, dragged, typed path).

## Expected

What you expected instead.

---

If you are unsure whether this is a bug, open a [Discussion](https://github.com/chang416/deepsee/discussions) with the context and expected behavior.
