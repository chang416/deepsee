# Changelog

## 4.0.1 - 2026-08-15

- **Fixed: the documented dsh install produced a profile that would not boot.** `cordis.patch.yml` named the plugin `deepsee`, the executable's name rather than the package's. The cordis loader imports that value as a bare specifier against the profile directory, where the package installs as `@chang416/deepsee`, so `dsh web` aborted with `Cannot find package 'deepsee'` and the whole profile failed to load. The patch now names the package, and the bundle test asserts it against `package.json` instead of a literal so the two cannot drift apart again.
- **Fixed: DeepSee Auto and Customize never appeared in the model selector.** The `deepsee_delegate` output schema marked each property `required: true`, which is not how JSON Schema spells it. dsh rejected the tool at registration, the plugin logged `Auto/Customize delegation skipped` and left `routing.ready` false, and the two orchestration entries were withheld from every model list. The schema now carries the standard `required` array, and a new test rejects a boolean `required` anywhere in any registered tool schema.

## 4.0.0 - 2026-08-15

- **DeepSee becomes a complete vision-and-routing plugin for DeepSeek Harness.** Gemini turns screenshots and pasted images into structured evidence while DeepSeek remains the only model that writes and integrates code.
- **Four coding modes ship together.** Flash and Pro provide direct control; Auto applies a free-first task policy; Customize lets each work category be assigned to Flash or Pro from DeepSee Settings.
- **Gemini API key rotation is built in.** Users can paste one key per line. DeepSee trims and deduplicates keys, moves to the next key only for authentication, quota, or rate-limit failures, and never returns saved key values to the browser.
- **OpenCode routes are first-class.** DeepSee discovers official DeepSeek routes, OpenCode Zen's free DeepSeek V4 Flash route, and OpenCode Go Flash/Pro routes without handing coding work to Gemini.
- **Visual work is checked before delivery.** Auto and Customize can capture a local preview or inspect a screenshot, ask Gemini for a strict machine-readable verdict, send material defects back to DeepSeek, and repeat within a configurable round limit.
- **The public identity is now DeepSee by chang416.** The package is `@chang416/deepsee`, the executable remains `deepsee`, all public templates and documentation use the canonical GitHub repository, and the visual system has been rebuilt around “Vision + Model Routing for DeepSeek Harness.”
- **Open-source launch hardening.** The release includes scoped npm installation, cross-platform CI, provider failover, remote-image SSRF protection, secret redaction, private paste recovery, runtime schema validation, setup guidance, focused contribution templates, and reproducible local visual-evaluation fixtures.
