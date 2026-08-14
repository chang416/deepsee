---
summary: '故障排查：deepsee 可能打印的每一条报错、成因与解法'
read_when:
  - 运行失败了，报错信息看不明白
  - recover-paste 什么都没找到，或找到了错的图片
  - 判断一次失败属于配置问题、额度问题还是 bug
---

# 故障排查

[English](troubleshooting.md) | 中文

先跑 `deepsee doctor`：它会检查你的 Node 版本、哪些 provider 已就绪、将选中哪一个及其原因，以及检测到的 harness，全程不消耗额度，也不发网络请求。大多数配置问题在你继续往下读之前就能被它查出来。

下面每条消息都是 deepsee 实际会打印的。拿你看到的字眼在本文里搜索即可。

## Antigravity CLI 读不到已保存的登录令牌

```
Antigravity CLI cannot read its stored login token.

On Linux this usually means the OS keyring is locked, which is normal for headless
sessions (agents, cron, systemd, SSH without a desktop login) ...
```

agy 把令牌存在操作系统钥匙串里。钥匙串被锁定时，agy 会把自己报告为未登录，并尝试浏览器登录，而没有显示器时这个流程无法完成。三条出路：

- 解锁钥匙串，或在桌面会话里运行 deepsee。
- 用 `agy` 重新登录。
- 换一个不需要交互式登录的 provider：

```bash
deepsee config set gemini-api.apiKey <key>   # free key: https://aistudio.google.com
deepsee config set provider gemini-api
```

## 额度用尽

```
Individual quota reached. ... Resets in 94h19m9s.

agy's free tier is one weekly bucket shared by the desktop app, the CLI, and the SDK ...
```

等重置，或换到 `gemini-api`，它有自己独立的预算。并行的 subagent 会飞快耗干这个共享额度池，用得猛的一天就能把它用完。

## 找不到 provider CLI

```
Provider CLI not found: agy (spawn ENOENT). Install it and sign in first.
```

二进制不在 PATH 上，或者 `--provider-bin` 指错了地方。其他 spawn 级失败（`... could not start \`claude\`: spawn EACCES`）会保留真实错误码，方便定位。Windows 上 npm 装的 CLI 是 `.cmd` shim，deepsee 通过 PATHEXT 解析并直接运行它背后的 Node 入口，所以裸名（ENOENT）和 `.cmd`（EINVAL）都不会卡住它。

```
Working directory does not exist: /some/path
```

成因不同，但操作系统返回的是同一个底层错误码：`--workdir` 指向了一个不存在的目录。二进制本身没问题。

## recover-paste 什么都没找到

```
No pasted images found in any session storage for this directory (looked in: ...)
```

按可能性从高到低：

- **你在错误的目录里。**恢复只限于对话所在的项目。传 `--cwd /path/to/project`。
- **根本没有粘贴过。**拖进来的文件和手打的路径本来就是真实文件，没有什么可恢复的：直接用那个路径。
- **某个配置问题挡住了一个 harness。**被挡的原因会出现在同一条消息的 `Blocked:` 之后，例如 OpenCode 需要 Node 22.13+ 才能用 `node:sqlite`。

## recover-paste 返回了另一个项目的图片

这种情况现在不应该再出现了，真出现就是值得上报的 bug。恢复检查的是 transcript 里记录的工作目录，不只是目录名，因为目录 slug 会撞车（`/tmp/a.b` 和 `/tmp/a-b` 生成同一个 slug）。提 issue 时带上输出里的 `harness` 和 `transcript` 字段。

## 项目对了，图片恢复错了

输出按从旧到新排列，所以**最后**一条才是最近一次粘贴。harness 存了文件名时条目会带 `filename`：用户提到名字时按它来匹配。`--count 3` 能多给几个候选。

## recover-paste：覆盖检测结果与输出位置

`recover-paste` 会自动检测自己运行在哪个 harness 里（先看进程祖先，再看环境特征），并且只读那个 harness 的存储。两个旋钮可以覆盖它：

- **`DEEPSEE_HARNESS`** 不用命令行参数就能强制指定存储范围：`claude-code`、`pi`、`opencode`、`codex`，或 `none`（扫描所有存储，不限范围）。检测最先读它，所以它优先于进程祖先和环境特征。`--harness` 对单次运行做同样的事。
- **`--out-dir`** 决定恢复出的图片落在哪。默认每次运行都新建一个不可预测的 `<tmpdir>/deepsee-paste-*` 目录（0700，内含 0600 文件），没人能预先创建一个共享路径来截获字节。系统临时目录不合适时可以指到别处。显式传入的 `--out-dir` 若已存在，必须是真实目录（不是符号链接）、归你所有、组和其他用户无任何权限，否则会被拒绝。Windows 上会跳过所有权和权限检查，因为该平台没有 POSIX 权限位（见下方 Windows 一节）。符号链接检查仍然生效。

## 这是一个 Codex 会话

```
This is a Codex session: pasted images already exist as temp files, and each image
tag in the message carries its path.
```

一切符合设计。Codex 会把粘贴的图片写到磁盘，并把路径放进消息里，所以直接从 tag 里取路径来读，不需要恢复任何东西。

## openai provider 的结果被拒绝

```
OpenAI-compatible API returned JSON that does not match the vision schema
(missing: ocr, ocr.full_text, ...)
```

那个端点返回了残缺的结果。只有 agy、gemini-api、anthropic 和 claude-cli 在服务端强制执行 schema，较弱的网关可能只产出半个结果。重试一次，然后换 provider：

```bash
deepsee -i <image> -p gemini-api
```

## guard 给出了 deny，或一次读取被拒绝

```
Invocation guard denied this read: active model "gemini-3.1-pro" matches guards.denyModels pattern "gemini-3*". A model with native vision should read the image itself. To override, unset DEEPSEE_MODEL or edit guards in /Users/you/.deepsee/config.json.
```

这是配置在按预期工作：配置文件里的 `guards.denyModels` 列出了自带视觉的模型，当前模型匹配到了其中一条，引擎因此拒绝为一张该模型自己就能读的图片花掉一次 provider 调用。`deepsee doctor` 有一个 Guard 小节，展示规则、检测到的模型、来自哪个信号（`DEEPSEE_MODEL` 环境变量、会话存储或 `--model` 自报），以及判定结果。

如果检测错了，`DEEPSEE_MODEL=<actual-model> deepsee guard` 覆盖一切，`DEEPSEE_MODEL=none` 把模型标为未知（判定随 `denyWhenUnknown` 走，默认 allow）。彻底关掉 guard：`deepsee config set guards.denyModels ''`。

一个已知盲区：存储检测读的是这个项目记录的最新一条 assistant 轮次，所以同一个项目目录里同时跑着不同模型的两个会话可能互相遮蔽（Claude Code 和 Codex 通过注入的会话 id 锁定确切会话，Pi 和 OpenCode 做不到）。中招时用 `DEEPSEE_MODEL` 覆盖。

注意上面那种硬拒绝只在显式的 `DEEPSEE_MODEL` 值真正匹配到 `denyModels` 时才触发。存储检测和 `denyWhenUnknown` 策略从不阻断 `analyze`，它们只通过 `deepsee guard` 发声，而 guard 的 deny 是给 agent 的建议，不是上了锁的门。

## dsh 提示 `declares no dsh.bundle — installed as a plain dependency`

dsh profile 装到的是旧版 deepsee。`dsh.bundle` 声明从 3.9.0 起才存在，而 pnpm v11 的发布冷静期机制（`minimumReleaseAge`，隔离刚发布的版本，pnpm 11.21 上实测窗口为 10 天）在所有较新版本都在窗口内时，会静默回退到更旧的版本。那个旧版本没有 bundle 声明，dsh 于是正确地把它当作普通依赖，一个工具都不会出现。

解法：把版本写死。pnpm 只在解析版本范围时应用冷静期，显式版本或 dist-tag 会跳过它（[pnpm#9989](https://github.com/pnpm/pnpm/issues/9989)，pnpm 11.21 上实测），安装命令带 `@latest` 就是这个原因：

```sh
npx -y @deepseek-ai/dsh plugin --profile <name> add @chang416/deepsee@latest
```

dsh 的 reconcile 会注意到新版本上的 bundle 声明并激活它，随后重启 dsh。用 `npx -y @deepseek-ai/dsh plugin --profile <name> list` 验证，显示的版本应该是 3.9.0 或更新。

如果将来的 pnpm 关掉了这条跳过通道，更持久的替代方案是在 `~/.dsh/profiles/<name>/pnpm-workspace.yaml` 里加一条一次性排除（写裸包名，不写 `name@version`，这样以后的新版本也能沿用）：

```yaml
minimumReleaseAgeExclude:
  - 'deepsee'
```

然后执行 `npx -y @deepseek-ai/dsh plugin --profile <name> update deepsee`。两种方式的代价都摆在明面上：显式 `@latest`（或这条排除）让 deepsee 退出 pnpm 的供应链冷静期，新版本会立即装上。

## fetch failed 或连接失败

```
Could not connect to generativelanguage.googleapis.com (UND_ERR_CONNECT_TIMEOUT). The request never reached the network. ...
```

API 请求根本没离开这台机器。在要靠代理才能上网的网络里这是预期表现：Node 的 fetch 默认无视代理环境变量。你明确要求走代理后 deepsee 才会遵循，两种写法任选：

```bash
HTTPS_PROXY=http://127.0.0.1:7890 deepsee -i shot.png -p gemini-api   # env (NO_PROXY honored too)
deepsee config set proxy http://127.0.0.1:7890                        # persistent, all API providers
deepsee config set openai.proxy http://127.0.0.1:7890                 # one provider only
```

代理只作用于 API provider 的请求。远程图片的下载路径有意保持直连并钉死 IP：它的 SSRF 防护校验的正是实际连接的那个地址，加了代理这些防护就失明了。在必须走代理的机器上，优先用本地文件，或让故障转移链把远程 URL 交给会在上游自行抓取的 provider。

## 配置文件问题

```
Cannot read /Users/you/.deepsee/config.json: EACCES ... Fix the file or its permissions.
```

文件存在但读不了。文件缺失是正常的，所以这是真问题，不能无视。

```
Failed to parse ... Fix or delete the file.
```

JSON 无效。`deepsee config init --force` 会写入一份干净的配置，旧内容会丢失。

## 超时

```
antigravity-cli provider timed out after 210000 ms.
```

带 `--timeout 300000` 重试一次。信息密集的图片在 agy 上花 15-40 秒属于正常，`-m gemini-3.1-pro-high` 还会更慢。无视 SIGTERM 的引擎会被升级为 SIGKILL，所以超时无论如何都会迅速返回。

## 推理模型上每次读取都很慢

默认思考的模型会在开始转录之前先把预算花在思考上，而视觉读取并不需要思考。没有统一的 `--no-thinking` 参数，因为每家厂商给这个开关起的名字都不一样，所以直接传厂商自己的字段：

```bash
deepsee config set openai.extraBody '{"thinking":{"type":"disabled"}}'
deepsee -i shot.png --extra-body '{"reasoning_effort":"low"}'    # one run only
```

各家厂商的具体写法、哪些模型完全关不掉，以及怎么确认字段真的生效，见[配置手册](../skills/deepsee/references/configure.zh-CN.md#关闭思考)。

```
extraBody cannot override "messages" for the openai provider
```

这个字段承载着图片、prompt 和 schema 强制逻辑。把它删掉，只保留厂商的开关字段。网关返回 400 并点名你设置的某个字段，说明那个端点用的是另一种写法。在 `antigravity-cli` 或 `claude-cli` 上运行时，`meta.warnings` 会说明该值被忽略了，因为 CLI provider 没有请求体。

## Windows

DeepSee 可以在 Windows 上运行。三个值得了解的平台差异：

- **没有 POSIX 权限检查。**Windows 文件没有所有者、组、其他用户的权限位（读出来是 `0o666`/`0o777`，实际访问由 ACL 控制），所以 `doctor` 不评判配置文件的权限模式，`recover-paste --out-dir` 也不会因所有权或组和其他用户的权限而拒绝目录。`--out-dir` 的符号链接检查仍然生效。
- **Harness 检测依赖环境特征。**没有 `ps` 可以读进程树，检测只能依靠各 harness 设置的环境变量。猜错时用 `--harness <name>` 或 `DEEPSEE_HARNESS` 强制指定。
- **粘贴恢复。**OpenCode 的恢复在 Windows 上已覆盖（issue #11）。Claude Code 和 Pi 的 JSONL 路径依赖 `os.homedir()` 和各 harness 在那里的磁盘 slug。恢复扑空时，用 `--transcript` 直接指向文件，或把图片拖进终端。

## 还是没解决

提 issue 时附上完整命令和完整报错：https://github.com/chang416/deepsee/issues
