<p align="center">
  <img src="https://raw.githubusercontent.com/chang416/deepsee/main/assets/banner.png" width="100%" alt="DeepSee：为 DeepSeek 提供视觉与模型路由" />
</p>

<h1 align="center">DeepSee</h1>

<p align="center"><b>让 DeepSeek 看得见，也知道该用哪个模型。</b></p>

<p align="center">
  <a href="./README.md">English</a> ·
  <a href="docs/troubleshooting.zh-CN.md">故障排查</a> ·
  <a href="skills/deepsee/references/configure.zh-CN.md">配置</a> ·
  <a href="docs/output-schema.zh-CN.md">输出契约</a> ·
  <a href="docs/security.zh-CN.md">安全</a>
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/@chang416/deepsee"><img src="https://img.shields.io/npm/v/%40chang416%2Fdeepsee?style=flat-square&label=npm&color=cb3837" alt="npm"></a>
  <a href="https://github.com/chang416/deepsee/actions/workflows/ci.yml"><img src="https://img.shields.io/github/actions/workflow/status/chang416/deepsee/ci.yml?style=flat-square&label=CI" alt="CI"></a>
  <a href="https://nodejs.org"><img src="https://img.shields.io/badge/node-%3E%3D22.19-43853d?style=flat-square" alt="Node.js 22.19+"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue?style=flat-square" alt="License"></a>
</p>

DeepSee 把 DeepSeek Harness 变成一个能看图、能换模型、还能自动分工的开发工作区。**Gemini 负责视觉，DeepSeek 负责全部代码。**你可以直接选 Flash 或 Pro，也可以交给 Auto／Customize 按成本与难度自动分配。截图可直接贴进纯文本 DeepSeek，会在交付前检查实际画面。

```sh
npx -y @deepseek-ai/dsh plugin --profile web add @chang416/deepsee@latest
```

打开 **DeepSee Settings**，一行一把加入免费的 Gemini Key，并设置 Flash／Pro 分工、预览网址与视觉检查次数。

![DeepSee 如何结合 Gemini 视觉与 DeepSeek 模型路由](https://raw.githubusercontent.com/chang416/deepsee/main/assets/flow.zh.svg)

## 亮点

**DeepSee 不只让 DeepSeek 看见，也把它变成一支原生协作团队。** 模型选择器保留直接使用 **V4 Flash** 与 **V4 Pro**，并新增两种编排模式：

- **DeepSee Auto** 内置省额度优先的最佳分工：检索、文档、测试、小改动与明确的修复交给 Flash；架构、安全、跨模块重构、整合与最终审查交给 Pro。可独立的子任务会并行执行，再由协调模型统一整合。
- **DeepSee Customize** 可逐项决定每类工作交给 Flash 或 Pro。第一次选择时会直接打开 Harness 里的 **DeepSee Settings**，不必手动编辑 JSON。
- **交付前会自己看。** 做 UI 时，DeepSeek 会在重要里程碑与最终交付前开启本机预览，请 Gemini 严格检查真实画面。Gemini 只会给出 `PASS`，或指出画面位置与必须修正的问题；DeepSeek 会在可设置的免费额度保护次数内修正再检查，不再把视觉错误留给用户验收时才发现。
- **写代码的始终是 DeepSeek。** Gemini 只负责读图；开发工作会沿用用户已有的 DeepSeek 路线，包括官方 API、OpenCode 的 `deepseek-v4-flash-free`，以及 OpenCode Go 的 `deepseek-v4-flash`／`deepseek-v4-pro`。
- **Gemini 免费 Key 可放多把。** 一行一把，自动去重；遇到认证、额度或限流问题会换下一把。浏览器只会看到数量，绝不会把已保存的 Key 读回来。

一次安装即可加入原生 `read_image` 视觉桥、DeepSee Auto／Customize、Gemini 多 Key 轮换、OpenCode／OpenCode Go 路由，以及交付前的 `deepsee_visual_check`。若 dsh 提示 `declares no dsh.bundle`，请看[故障排查](docs/troubleshooting.zh-CN.md#dsh-提示-declares-no-dshbundle--installed-as-a-plain-dependency)。

DeepSeek Harness 粘贴识图有两种玩法。

**① 直接粘贴** 贴进来的图片自主转换成文件路径进输入框（与 OpenCode、Pi 同款交互），`read_image` 工具接手读图。

**② 切到带 `(deepsee vision)` 后缀的模型变体**（选择器有记忆，选一次就行）再粘贴：缩略图直接可见、所见即所得，体验更接近 Codex App。变体由插件自动发现生成：每条承载纯文本 DeepSeek 或 GLM 模型的 provider 路由各得一组包装条目（默认安装下就是 **`DeepSeek-V4-Flash (deepsee vision)`** 和 **`DeepSeek-V4-Pro (deepsee vision)`**，装了 opencode-go、zai 等额外路由的机器会各自多出一组），两家自己的视觉型号自动排除。走哪条通路由 host 依据真实模型元数据逐个裁决：只有被元数据确认纯文本的模型才会被接管，确认不了的一律不动，视觉模型因此保留原生贴图（[细节](docs/harness-setup.zh-CN.md)）。

**直接粘贴图片，DeepSeek 就能使用。**不用换掉编码模型，也不用手工转录。

- **原生且可移除。** 在 dsh 里它是一个插件，在其他宿主里是一个 skill 文件夹，不需要本地代理进程；移除后宿主立即恢复原状。
- **零配置起手。** 复用 Claude Code、Codex、OpenCode、Pi 已配置，直接复用你本机的其他多模态模型。什么都没有？Antigravity CLI 是免 key 的免费通道，配一个免费 Gemini key 可将识别耗时降至 5 到 10 秒。
- **基于证据而非想象。** 全文转录、按阅读顺序划分的版面区块、实体与关系列表，模型引用的是具体内容。
- **一次安装，多端可用。** Claude Code、Codex、Pi、OpenCode 均经真机验证。

## 安装

**第一步，交给你的 AI。** 把这句话发给它：

> 按 https://github.com/chang416/deepsee 的 INSTALL.md 安装并配置 deepsee skill，完成后运行体检并把结果告诉我。

安装会先盘点你机器上已有的东西。Claude Code、Codex、OpenCode 或 Pi 里任何一个已有的登录态都可能就够了：deepsee 复用前一定先征得你同意，体检报告会说清现状。

**第二步，只在体检两手空空时，才需要你配一个免费引擎。** 推荐免费的 Gemini api key（到 [Google AI Studio](https://aistudio.google.com) 领取，约三分钟，无需信用卡），配上后每次识别 5 到 10 秒。其他平台的免费 openai 兼容 key 也行。想完全免注册就装 Antigravity CLI，然后完成登录：

```bash
curl -fsSL https://antigravity.google/cli/install.sh | bash
agy                                                           # 浏览器完成登录后退出
```

安装还会盘点本机其他 harness CLI（Codex、OpenCode、Pi）里可触达的视觉能力，并逐个询问是否允许 deepsee 复用。获准的登录态与你自己配的引擎平级入池，每次复用都会在结果里标明花的是谁的额度。

**DeepSeek Harness（dsh）用户不走 skill 流程**，本包就是原生 dsh 插件：

```sh
npx -y @deepseek-ai/dsh plugin --profile web add @chang416/deepsee@latest
```

装完即有 `read_image` 工具，选「(deepsee vision)」模型变体即可直接粘贴识图。引擎配置同样在 `~/.deepsee`，详见[宿主接入](docs/harness-setup.zh-CN.md)。

## 用法

装好之后不需要记任何命令。正常聊天，粘贴图片或给出图片路径，提问即可，skill 自动触发：图片交给视觉引擎，答案基于读到的内容返回。

## 视觉引擎：五个内置 provider，四家可复用 CLI，一条故障转移链

DeepSee 不绑定任何单一视觉服务。视觉来源一共九个：五个内置 provider（配好任意一个就能用），加四家本机 agent CLI 的登录可以复用。先看内置的：

| Provider          | 需要什么                                                                 | 单次识别耗时 | 适合谁                 |
| :---------------- | :----------------------------------------------------------------------- | :----------- | :--------------------- |
| `gemini-api`      | 免费 Gemini key（[三分钟领取，无需信用卡](https://aistudio.google.com)） | 5-10 秒      | 推荐默认               |
| `openai`          | 任意 OpenAI 兼容端点（key + baseUrl + model）                            | 5-10 秒      | qwen-vl、GLM、自建网关 |
| `anthropic`       | Anthropic API key                                                        | 5-10 秒      | 手上已有 key 的机器    |
| `antigravity-cli` | 免费的 `agy` CLI，浏览器登录一次，无需 key                               | 15-45 秒     | 完全免注册起步         |
| `claude-cli`      | 已登录的 Claude Code                                                     | 20-45 秒     | 复用现有 Claude 订阅   |

不钉死 provider 时，所有配好的引擎组成一条故障转移链：API 快车道先试，agent CLI 兜底，第一个可用结果胜出，`meta.attempts` 记录每次尝试，回退永远不是无声的。

### `openai` 是万能接口，不只是 OpenAI

任何讲 OpenAI chat-completions 协议、支持图片输入的端点都能直接插上，这基本覆盖了视觉模型的大半个世界：

```bash
deepsee config set openai.baseUrl https://dashscope.aliyuncs.com/compatible-mode/v1   # qwen-vl
deepsee config set openai.apiKey  <key>
deepsee config set openai.model   qwen3-vl-plus
```

同样三个键，换成 GLM 开放平台、SiliconFlow、OpenRouter、自建 vLLM/Ollama 或你自己的网关都一样。你常用的视觉模型只要有 OpenAI 兼容 API，DeepSee 就能驱动它。

### 复用你机器上已有的东西

还有两处现成的视觉能力，一个新 key 都不用配，每家都在你明确同意后才启用：

- **你正在对话的这个 harness 本身。**在登录了订阅的 Claude Code 里用？`claude-cli` 开箱即可借它读图。装进哪个 harness，安装流程就会问哪个 harness 的授权。
- **机器上其他的 agent CLI。**`deepsee doctor` 会逐个发现，你按家授权，它们与你自己的 key 平级入链，不插队。每次复用都在 `meta.warnings` 里标明花的是谁的额度，绝不无声扣费：

| 复用来源 | 需要什么                       | 授权命令                         | 走哪条道                                               |
| :------- | :----------------------------- | :------------------------------- | :----------------------------------------------------- |
| Codex    | 已登录且有视觉模型的 Codex CLI | `config set reuse.codex true`    | agent 通道，15-45 秒                                   |
| OpenCode | OpenCode 里配好的视觉模型      | `config set reuse.opencode true` | agent 通道，15-45 秒                                   |
| Pi       | Pi 持有的模型凭据              | `config set reuse.pi true`       | API key 直接升级到 5-10 秒的快车道，OAuth 驱动 Pi 本体 |
| Grok     | 已登录的 Grok CLI（SuperGrok） | `config set reuse.grok true`     | agent 通道，15-45 秒                                   |

### 选择与路由

两个旋钮：`deepsee config set provider <name>` 表达偏好（链继续兜底），`-p <name>` 钉死单个不回退。代理环境设 `HTTPS_PROXY` 或 `deepsee config set proxy <url>`，API provider 自动走代理。细节见 [CLI 手册](docs/cli.zh-CN.md)（默认模型与参数）、[配置手册](skills/deepsee/references/configure.zh-CN.md)（全部配置键）、[安全说明](docs/security.zh-CN.md)（远程 URL 由谁抓取）。

## 文档

| 文档                                                     | 适用场景                                   |
| :------------------------------------------------------- | :----------------------------------------- |
| [安装手册](INSTALL.md)                                   | 一步步安装 skill（为 agent 编写）          |
| [CLI 手册](docs/cli.zh-CN.md)                            | skill 所驱动的 CLI：参数、配置与体检       |
| [故障排查](docs/troubleshooting.zh-CN.md)                | 命令报错，查成因和解法                     |
| [配置手册](skills/deepsee/references/configure.zh-CN.md) | 配置 key、切换 provider、排查配置          |
| [输出契约](docs/output-schema.zh-CN.md)                  | 解析 JSON 或构建下游工具                   |
| [宿主接入](docs/harness-setup.zh-CN.md)                  | 在 Codex、Claude Code、Pi、OpenCode 中配置 |
| [安全说明](docs/security.zh-CN.md)                       | 恢复文件的权限、图片内容作为不可信输入     |
| [更新日志](CHANGELOG.md)                                 | 查询版本变更                               |

## 参与方式

欢迎范围明确的 PR。请说明用户可见行为、补齐测试，并在提交前执行 `pnpm lint`、`pnpm typecheck`、`pnpm test` 与 `pnpm build`。

- **[提交 issue](https://github.com/chang416/deepsee/issues)。** bug、建议、难懂的报错和文档问题都欢迎。
- **阅读 [CONTRIBUTING.md](CONTRIBUTING.md)。**安全问题请依 [SECURITY.md](SECURITY.md) 私下回报，不要公开贴出漏洞细节。

## 免责声明

本项目依下方 MIT 协议按现状提供。作者不对任何特定用途（含商业使用）提供保证或背书。上游引擎（Antigravity CLI，Gemini、OpenAI、Anthropic 的 API，以及任何 OpenAI 兼容端点）的使用受各自条款和额度约束，由使用者负责。

## 致谢

DeepSee 由 **chang416** 主导设计、开发与维护。早期探索仅少量参考过 MIT 授权的 [ModLens](https://github.com/liustack/modlens)，依法保留的版权声明见 [LICENSE](LICENSE)。DeepSee 的产品架构、Auto／Customize 编排、设置界面、Gemini 多 Key 轮换、OpenCode 感知路由与视觉自检循环均为 DeepSee 开发。

## License

MIT
