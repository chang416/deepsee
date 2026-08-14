---
summary: '宿主接入：图片在 Codex、Claude Code、Pi、OpenCode 中如何抵达模型'
read_when:
  - 在某个具体的编码 agent 里安装配置 deepsee
  - 粘贴的图片没有抵达模型
  - 了解 recover-paste 在各 harness 里分别做什么
---

# 宿主接入

[English](harness-setup.md) | 中文

粘贴的图片最终落在哪里，每个 harness 都不一样，deepsee 在每个 harness 里走的路线也不同。`recover-paste` 会检测自己运行在哪个 harness 里（先看进程祖先，再看环境变量指纹），只读取该 harness 的存储。

## Codex

粘贴的图片会落成真实的临时文件，消息里带着形如 `<image name=[Image #1] path="/tmp/xxxx.png">` 的标签。skill 直接从标签里读出路径。`recover-paste` 检测到 Codex 后会拒绝执行，并把你指回这个标签。

纯文本模型有一个坑：一旦 `models.json` 声明了 `input_modalities: ["text"]`，Codex TUI 会直接拦下 Ctrl+V 粘贴。改为把文件拖进终端、手动输入路径，或使用 `codex exec -i image.png "..."`。

## Claude Code、Pi、OpenCode

这三家都不像 Codex 那样递给模型一个可用的临时文件路径（较新的 Claude Code 版本确实会把粘贴写进自己的 `~/.claude/image-cache/`，但只在终端入口以路径行的形式注入），不过三者都会在网关剥离图片之前，把用户消息完整存在本地：

| Harness | 存储位置 | 说明 |
| :-- | :-- | :-- |
| Claude Code | `~/.claude/projects/<slug>/<session>.jsonl` | 图片以 base64 存储。注入的 `CLAUDE_CODE_SESSION_ID` 可精确定位当前 session |
| Pi | `~/.pi/agent/sessions/--<encoded-cwd>--/*.jsonl` | 结构与 Claude Code 相同 |
| OpenCode | `~/.local/share/opencode/opencode.db` | SQLite，图片以 data URL 存储（通过 `node:sqlite` 读取） |

在 Claude Code 里通过 `ANTHROPIC_BASE_URL` 接入纯文本模型时，粘贴的图片要么变成一个不带路径的 `[Unsupported Image]` 占位符（宽松的网关），要么直接让请求报错（[#62009](https://github.com/anthropics/claude-code/issues/62009)）。图片字节并没有丢，`recover-paste` 取回的就是它。

## skill 的存放位置

| Harness | skill 读取位置 |
| :-- | :-- |
| Claude Code | `~/.claude/skills/` |
| Codex | `~/.codex/skills/` |
| Pi、OpenCode | `~/.agents/skills/` |

这些位置都支持符号链接，把 skill 目录链接一次，每个 agent 用的就都是最新版本。

## 平台支持

macOS 和 Linux 完整支持，并在 CI 上以 Node 22 和 24 验证。

Windows 跑同一套 CI 矩阵。那里没有 `ps`，检测会跳过进程祖先这一步，退回到上面的环境变量指纹，所以一个什么指纹都不设的 harness 会被判为未检出（用 `--harness` 或 `DEEPSEE_HARNESS` 强制指定）。OpenCode 的粘贴恢复在 Windows 上有覆盖，包括 [#11](https://github.com/chang416/deepsee/issues/11) 里的路径分隔符归一化：opencode 记录的 `session.directory` 用正斜杠，而那里的 `path.resolve` 返回反斜杠，匹配前两边都会归一化。JSONL 存储（Claude Code、Pi）以 `os.homedir()` 和各 harness 自己的磁盘 slug 为键，在 POSIX 上验证。外部引擎（Antigravity CLI、Claude CLI）只在有 Windows 版本的平台上运行。

## 网关配置

OpenCode 接 DeepSeek：执行 `opencode auth login`，选择 DeepSeek 并粘贴 key（会存进 `~/.local/share/opencode/auth.json`），然后在 `~/.config/opencode/opencode.jsonc` 里把默认模型设为 `deepseek/deepseek-v4-flash`。Pi 从 `~/.pi/agent/auth.json` 读取它的 key。

## DeepSeek Harness（dsh）

dsh 与其他 harness 不同：deepsee 以原生工具的形式接入，而不是靠提示词触发的 skill。本包自身就是一个 dsh bundle，一条命令即可装进某个 profile：

```sh
npx -y @deepseek-ai/dsh plugin --profile web add @chang416/deepsee@latest
```

这会注册一个 `read_image` 工具，它的 schema 随每次请求抵达模型（不靠触发启发式），运行同一个包里自带的 deepsee CLI，并把结构化证据作为工具的标准 JSON 输出返回。引擎、复用授权和 guard 规则仍在 `~/.deepsee/config.json` 里，与其他所有 harness 共享。dsh 还在开发者预览阶段，插件接口可能变化。这个插件刻意保持很小的接触面（原生工具注册、视觉变体所用的 llm 适配层、附件读取器，以及一个 agent 执行前钩子），其中任何一处变动，它都会大声报错而不是无声退化。

### Auto、Customize 与 OpenCode 路线

dsh 的进程内子代理服务可用时，每个已包裹的 DeepSeek provider 会在直接使用 Flash／Pro 之外，新增 **DeepSee Auto** 与 **DeepSee Customize**。Auto 使用内置的省额度优先分工；Customize 使用 DeepSee Settings 保存的分工表。协调模型会为每个边界明确的子任务调用一次 `deepsee_delegate`，相互独立的调用可并行，且每个子代理都会被强制放在当前可用的 DeepSeek V4 路线上。Gemini 仍然只负责读图，不会收到写程式任务。

路线探测不绑定特定 provider。用户可以使用 DeepSeek 官方适配器、OpenCode Zen 免费的 `deepseek-v4-flash-free`，或 OpenCode Go 的 `deepseek-v4-flash` 与 `deepseek-v4-pro`。DeepSee 读取 host 的实时模型目录，不会只因本机出现一个名称就假定凭据有效；它优先沿用当前选中的上游，当前路线缺少某一 lane 时再寻找其他已启用路线。OpenCode 免费模型有自己的限额，OpenCode Go 则消耗订阅额度。

浏览器端会加入一个小型 **DeepSee Settings** 入口。第一次点选 DeepSee Customize 时会检查是否已保存分工，尚未完成引导就自动打开。面板也能保存多把 Gemini API key，一行一把；设置接口只返回数量，绝不会把 key 内容送回浏览器。

### 交付前视觉自检

Auto 与 Customize 还会注册 `deepsee_visual_check`。只要任务改动 UI、渲染文件、图表、样式、版面或其他可见状态，协调模型会在重要里程碑之后以及最终交付之前调用它。工具可替本机运行中的预览截屏，也能检查现成截图。Gemini 会返回结构化证据，以及 `pass`、`needs-fix`、`unknown` 三种机器可读判定之一；若回答一面写 PASS、一面又列出 BLOCKER、HIGH 或 MEDIUM 问题，DeepSee 一律视为 `needs-fix`。

每个实质问题都会回到 DeepSeek 的写程式循环，修正后再检查。默认每个阶段最多调用两轮，完全相同的图片、要求与参考图会复用记忆体内结果，不重复消耗 Gemini 请求。设置面板可控制里程碑检查、最终 PASS 门槛、每阶段最多 1–4 轮、视窗大小，以及可选的默认预览网址。

预览截屏刻意只允许本机：`http` 或 `https` 的 `localhost`、`127.0.0.0/8`、`[::1]`；带帐号密码或非回环主机的网址会被拒绝。DeepSee 会寻找 Chrome、Chromium 或 Edge，以全新临时使用者资料夹无头运行，完成后删除该资料夹。浏览器或预览启动不了时，它会交代明确阻碍，不会假装已经完成视觉验收。非网页作品可传绝对截图路径，也可附绝对路径参考图。

### 粘贴转路径（paste-to-path，web profile）

过去在 dsh Web UI 里，**纯文本模型**下粘贴图片会死在图片准入检查这一步。插件现在带了一个浏览器端半边（由 dsh 的客户端插件系统自动加载），恰好在这种情况下接管粘贴：图片字节发到插件在 dsh web 服务器上的 `/deepsee/paste` 路由（仅回环地址，校验 magic byte，上限 25 MB），落成一个私有临时文件，输入框收到的则是纯文本的文件路径。这与 Pi、OpenCode、Claude Code 递给模型的形态一致，也正是 deepsee skill 和 `read_image` 工具的首要触发条件。消息里不带图片附件，准入检查根本不会触发。

接管是有条件的，且裁决权在 host 一侧：浏览器半边先向插件路由询问当前选中的模型是否纯文本，host 用 provider 注册表里声明的模型元数据（`inputModalities`）回答，而不是靠名称猜。`(deepsee vision)` 变体和任何声明支持图片输入的模型都保留原生粘贴流程（变体在发请求时转换且保留缩略图，视觉模型自己读图），host 认不出的模型同样不接管：在 host 确认该接管之前，粘贴一律走原生路径。模型元数据里没有声明输入模态的，一律算认不出：元数据缺失绝不当成「已确认纯文本」。裁决还有 60 秒时效，模型中途变了会重新问询，不会永远信旧答案。在插件配置行里设 `pasteToPath: false` 可整体关掉这个功能：策略端点 404 时浏览器半边彻底停手。若路由在裁决确认后中途消失，失败结果返回前那个短暂窗口（一次本地往返）内发生的粘贴会丢失，之后客户端清空全部裁决，后续粘贴一律走原生路径。
