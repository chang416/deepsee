---
summary: 'Output contract: the JSON shape every read returns, result fields and meta'
read_when:
  - Parsing deepsee output or building on top of it
  - Checking what meta.attempts and meta.warnings mean
---

# DeepSee Output Schema (v2)

English | [中文](output-schema.zh-CN.md)

The CLI prints one JSON object to stdout:

```json
{
  "image": "/abs/path/or/url",
  "provider": "antigravity-cli",
  "result": { "...": "see below" },
  "meta": {
    "generatedAt": "2026-08-01T12:00:00.000Z",
    "model": "gemini-3.6-flash-low",
    "conversationId": "string|null",
    "durationSeconds": 25.4,
    "usage": {},
    "attempts": [{ "provider": "antigravity-cli", "ok": true, "durationSeconds": 25.4 }],
    "warnings": []
  }
}
```

`meta.attempts` lists every provider the failover chain tried this run, in order, with an `error` string on failures. `meta.warnings` carries routing notices: failovers, an ignored `extraBody`, and whose quota an auto-mode read spent.

`result` is enforced by JSON schema where the provider supports it (agent CLIs via `--json-schema`, API providers via response-schema fields or a filled-in template), and the CLI verifies the shape itself before returning, so a structurally broken result fails over instead of reaching you:

```json
{
  "summary": "string",
  "ocr": {
    "full_text": "string",
    "lines": [
      { "text": "string", "language": "string (optional)" }
    ]
  },
  "layout": {
    "regions": [
      {
        "type": "title|subtitle|paragraph|list|table|chart|form|code|image|icon|other",
        "reading_order": 1,
        "text": "string"
      }
    ]
  },
  "semantics": {
    "scene": "string",
    "intent": "string (optional)",
    "entities": [
      { "name": "string", "type": "string", "evidence": "string (optional)" }
    ],
    "relations": [
      { "subject": "string", "predicate": "string", "object": "string" }
    ]
  },
  "visual": {
    "dominant_colors": ["string"],
    "style": "string",
    "notes": ["string"]
  },
  "uncertainty": ["string"]
}
```

Required fields: `summary`, `ocr`, `layout`, `semantics`, `visual`, `uncertainty` — every top-level field, `visual` included. (Earlier docs called `visual` optional; the enforced schema has always required it, so build to the schema.)

Changes from v1: pixel `bbox` coordinates and numeric `confidence` scores were removed. Vision models fabricate both, so v2 stops pretending to provide them. `layout.regions[].type` gained `code`.
