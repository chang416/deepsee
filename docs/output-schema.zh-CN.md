---
summary: '输出契约：每次识别返回的 JSON 结构、result 字段与 meta'
read_when:
  - 解析 deepsee 输出或在它之上构建工具
  - 查 meta.attempts 和 meta.warnings 的含义
---

# DeepSee 输出契约（v2）

[English](output-schema.md) | 中文

CLI 向 stdout 打印一个 JSON 对象：

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

`meta.attempts` 按顺序列出这次运行中故障转移链尝试过的每个 provider，失败时附带 `error` 字符串。`meta.warnings` 携带路由通知：故障转移、被忽略的 `extraBody`，以及自动模式下这次识别花了谁的额度。

只要 provider 支持，`result` 就由 JSON schema 强制约束（agent CLI 走 `--json-schema`，API provider 走 response-schema 字段或预填模板），CLI 返回前还会自己校验一遍结构，所以结构损坏的结果会触发故障转移，不会到你手上：

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

必填字段：`summary`、`ocr`、`layout`、`semantics`、`visual`、`uncertainty`，也就是每一个顶层字段，`visual` 也不例外。（早期文档把 `visual` 写成可选，但强制执行的 schema 一直要求它，请以 schema 为准。）

相对 v1 的变化：删掉了像素级 `bbox` 坐标和数值型 `confidence` 分数。视觉模型会凭空编造这两样，v2 不再假装提供。`layout.regions[].type` 新增了 `code`。
