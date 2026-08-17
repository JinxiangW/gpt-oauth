# dsh-llm-openai 插件 Review

> 状态更新（整改工作区）：本文记录的是提交 `45e6553` 当时的审计基线，不再代表当前工作区状态。后续整改已处理可信 endpoint、安装脚本防破坏、Windows 浏览器启动、图片附件、作用域代理与 fail-closed、原子 OAuth store、只读 opencode fallback、OAuth 取消/超时、smoke 退出码、`--no-call`、device backoff 和 package metadata。最终发布状态以回归测试和新的提交为准。

## Review 范围

本次 review 关注当前仓库作为 `dsh` LLM 插件时的：

- DSH 插件接口与 `PiAiAdapter` 集成
- ChatGPT OAuth 登录、刷新与凭据存储
- GPT 模型目录及 `-fast` 模型映射
- 代理支持
- 安装、打包与测试流程

本次只记录问题和建议，不修改实现。

## 总体评价

插件的核心方向是合理的：

- 使用 `openai-codex` provider 对接 ChatGPT subscription backend，而不是普通 OpenAI API-key endpoint。
- 通过 `PiAiAdapter` 注册 DSH provider route。
- 支持配置热更新、retry policy 和 stream idle timeout。
- 支持自有 OAuth 文件及 opencode credential fallback。
- `-fast` 模型映射到底层 wire model，并通过 `service_tier: "priority"` 实现快速通道。
- 已修复 fast model 在多轮 replay 中的 model id 不一致问题。

当前环境能够加载 13 个 GPT catalog 条目，JavaScript 语法检查以及 catalog smoke test 均能运行。

不过，当前状态更接近“本机可用原型”。在作为可分发或生产级 DSH 插件发布前，仍有若干安全性、可靠性和安装体验问题需要处理。

## Findings

### High — 可配置 `baseURL` 可能泄露 OAuth Token 和对话内容

位置：`index.js:62-75`, `index.js:81-82`, `index.js:117-125`, `index.js:204-213`, `index.js:438-449`

`baseURL` 当前接受任意 HTTP(S) URL，并被用于发送带有 ChatGPT OAuth bearer token 的 Codex 请求。攻击者控制或误配置的地址可以获得：

- OAuth access token
- 对话内容
- 工具定义及工具调用上下文
- 其他请求元数据

允许普通 HTTP 还会使 token 和内容暴露于网络监听或中间人攻击。

建议：

- 默认只允许预期的 ChatGPT HTTPS origin/path。
- 普通配置不允许 HTTP。
- 如果确实需要自定义 credential-bearing gateway，应增加明确的危险开关和醒目警告。

### High — 安装脚本可能递归删除已有目录

位置：`link-to-dsh.ps1:12-18`

如果 `$pluginLink` 已存在，但不是指向当前仓库的预期 Junction，脚本会直接执行：

```powershell
Remove-Item -Recurse -Force $pluginLink
```

这可能删除：

- 用户手工安装的真实目录
- 指向其他插件副本的链接
- 包含未提交修改的开发目录
- 其他类型的文件系统对象

建议：

- 对非预期目标默认 fail closed，不自动删除。
- 只有能够证明是本脚本创建的链接时才自动替换。
- 对其他情况要求用户显式确认或手工处理。

### High — Windows 浏览器登录 URL 会被 CMD 的 `&` 截断

位置：`login.mjs:47-59`

Windows 路径使用：

```js
spawn("cmd", ["/c", "start", "", url])
```

OAuth URL 含有多个 `&`。在 CMD 中，这些字符会被解释为命令分隔符，导致浏览器只收到被截断的 URL，其余 query 参数被尝试作为独立命令执行。

该行为已在 Windows 环境复现。结果是 README 推荐的默认浏览器登录流程可能失败，而 `--device` 是当前可用的绕过方式。

建议使用不会经 CMD shell 重新解析 URL 的系统打开方式，并增加包含 `&` 等 shell metacharacters 的 Windows 测试。

### Medium — 模型声明支持图片，但适配器未接入附件服务

位置：`index.js:449`

catalog 中除 `gpt-5.3-codex-spark` 外的模型均声明支持 image input，但创建 `PiAiAdapter` 时只传入：

```js
new PiAiAdapter({ profiles, resolveApiKey })
```

没有设置 `resolveAttachments`。`PiAiAdapter` 在遇到图片时需要 durable attachment service，否则会以 `UNSUPPORTED_CONTENT` 拒绝请求。

建议将 DSH attachment service 传给适配器，或在未支持附件时不要向模型选择器宣称 image capability。

### Medium — 全局 fetch 代理会影响整个 DSH 进程

位置：`index.js:22-26`, `proxy.mjs:108-140`

插件在模块导入时调用 `installGlobalFetchProxy()`，直接替换 `globalThis.fetch`。这不仅影响本插件，也会改变同一 DSH 进程内其他插件和服务的网络行为。

已确认的问题包括：

- 忽略 `NO_PROXY` / `no_proxy`。
- 忽略 Windows `ProxyOverride`。
- 覆盖调用者显式传入的 `dispatcher`。
- 内网和 loopback 请求也可能经过代理。
- 代理可能看到其他插件的 URL、header 和 request body。

建议避免全局 patch，只对本插件的 OAuth 和 Codex 请求应用代理。

### Medium — 无效代理配置会静默直连

位置：`proxy.mjs:92-99`, `proxy.mjs:120-134`

`ProxyAgent` 构造位于 broad `try/catch` 内。代理 URL 无效时，异常被捕获，代码随后调用原始 fetch 直连。

这会使“必须通过代理”的部署在代理配置错误时发生策略绕过。常见 Windows WinINet 格式：

```text
http=proxy-a:8080;https=proxy-b:8443
```

当前也会被当成单一 URL，解析失败后静默直连。

建议：

- 安装阶段解析和验证代理配置。
- 代理配置无效时 fail closed。
- 正确支持 Windows per-protocol proxy 格式。
- broad catch 只处理目标 URL 解析问题，不吞掉 dispatcher 构造错误。

### Medium — OAuth credential 写入不原子

位置：`index.js:294-323`, `login.mjs:313-317`

登录和刷新都直接使用 `writeFile` 覆盖 credential 文件。该操作会先截断文件；如果进程崩溃、磁盘写满或系统中断，可能留下空文件或不完整 JSON。

另外，`mode: 0o600` 主要控制文件创建，不能保证修复已有文件的宽松 POSIX 权限，也不能建立 Windows 用户专属 ACL。

建议：

- 在同目录写入权限受限的临时文件。
- flush 后使用 atomic rename 替换目标。
- 显式验证/修复 POSIX 权限。
- Windows 上使用适当的用户专属 ACL 策略。

### Medium — OAuth 刷新存在跨进程竞争和旧快照覆盖

位置：`index.js:299-323`, `index.js:364-377`

`refreshFlights` 只能合并当前 Node 进程中的刷新请求。多个 `dsh`、登录 CLI 或 opencode 进程仍可能同时使用同一个 rotating refresh token。

`persistOAuthSource()` 还会使用刷新前读取的 `source.doc` 写回整个文档，可能：

- 用旧 refresh token 覆盖另一个进程刚写入的新 token。
- 覆盖一次更新后的登录。
- 回滚 shared opencode auth file 中的其他 provider 修改。

建议采用跨进程锁；锁内重新读取并合并文档；提交前比较 credential generation；配合原子写入。

### Medium — OAuth 取消后登录进程会一直等待

位置：`login.mjs:106-125`, `login.mjs:209-214`

用户拒绝授权时，回调通常包含 `error=access_denied` 而没有 `code`。当前 handler 返回 “Missing authorization code”，但不会 settle `waitForCode`。

同时浏览器登录没有整体超时，因此 CLI 和 callback listener 会无限等待并持续占用端口 1455。

建议：

- 将 OAuth `error` 参数作为 terminal result。
- 增加有界的 callback deadline。
- 所有完成、拒绝和超时路径都确保关闭 server。

### Medium — 刷新失败后可能静默切换到另一个账号

位置：`index.js:383-400`

找到一个有效 credential source 后，如果刷新或持久化失败，resolver 会继续尝试后续文件。不同文件可能属于不同 ChatGPT 账号或组织。

请求因此可能在用户没有察觉的情况下切换账号、组织、billing context 或数据策略。

建议选定 credential source 后 fail closed；如果需要 fallback，应先验证账号身份一致。

### Medium — Smoke test 会产生假成功

位置：`smoke-test.mjs:42-67`

每个 effort 的 API 调用异常只会被打印，循环结束后仍返回 0。

使用一个可读取但无效的 token 测试时，所有 effort 都返回错误，最终进程仍然 `exit=0`。因此 CI 或人工测试可能把完全失败的 API 验证判断为成功。

建议记录失败次数；任何被请求的 API case 失败时返回非零退出码。

### Medium — 包目前不能独立、可重复安装

位置：`package.json:1-14`, `README.md:32-39`

当前 package metadata 未声明主要 runtime dependencies 或 peer dependencies，也没有 `bin` 字段。安装依赖于：

- 预先存在的 DSH fallback `node_modules`
- Windows Junction
- 手工安装 `vendor/undici`
- 仓库外另行创建的 `dsh-openai-login.cmd`

README 声称 `dsh-openai-login.cmd` 会安装到 `%APPDATA%\npm`，但仓库中的 package 和链接脚本都没有执行该安装。

`npm pack` 也不会包含 `vendor/node_modules`，因此 tarball 本身无法提供代理实现需要的 vendored dependency。

建议：

- 明确声明 dependencies/peerDependencies 和兼容版本。
- 通过 `bin` 安装登录 CLI。
- 提供可重复、跨平台的安装方式。
- 避免依赖开发机的 DSH/npm cache 路径。

### Low — `--no-call` 与 README 描述不一致

位置：`smoke-test.mjs:17-28`, `README.md:57`

README 将 `--no-call` 描述为 “catalog only, no API calls”，但代码会先调用 `resolveOAuthAccessToken()`，之后才检查 `noCall`。

这意味着：

- 没有 OAuth credential 时 catalog-only 检查仍返回 2。
- token 临近过期时仍可能发出 refresh API 请求。

建议在解析 catalog 后立即处理 `--no-call`，完全跳过 credential resolution。

### Low — Device flow 允许零轮询间隔

位置：`login.mjs:239-247`, `login.mjs:283-297`

服务端返回的 `interval` 允许为 0，可能形成持续 15 分钟的紧密轮询。收到 `slow_down` 时也没有增加间隔。

建议设置正的最小值，并在 `slow_down` 后递增 polling interval。

## 已确认的正面项

- DSH provider route 和 `PiAiAdapter` 的总体接入方向正确。
- settings 更新后 profile cache 可以按配置对象身份重建。
- retry policy 变化会触发 adapter registration facts 更新。
- stream idle timeout 有明确校验和默认值。
- OAuth access/refresh/expiry 字段有基本结构校验。
- refresh 请求能够处理 refresh token rotation。
- fast catalog model 会映射回 base wire model，并附加 `service_tier: "priority"`。
- fast model 的 terminal event 会重新标记 selector model id，避免多轮 replay state 不一致。
- 仓库当前没有提交 OAuth token、credential 文件或类似 secret。

## 本次验证

执行或检查了以下项目：

- `node --check index.js`
- `node --check login.mjs`
- `node --check proxy.mjs`
- `node --check smoke-test.mjs`
- `node smoke-test.mjs --no-call`
- catalog 加载与默认配置解析
- `npm pack --dry-run --json`
- Windows `cmd /c` 对带 `&` URL 的参数解析
- 无效 API token 下 smoke-test 的退出状态
- 全局代理对非 OpenAI fetch 的影响
- Windows per-protocol proxy 字符串对 `ProxyAgent` 的影响

当前环境中：

- catalog 加载出 13 个 GPT model entries。
- JavaScript 语法检查通过。
- catalog smoke test 在已有 OAuth credential 的环境中通过。
- 已复现 API case 全部失败但 smoke test 退出码仍为 0。
- 已复现 Windows OAuth URL 被 `&` 截断。

## 建议整改顺序

1. 限制 credential-bearing `baseURL`，默认只允许可信 HTTPS endpoint。
2. 移除安装脚本的无提示递归删除行为。
3. 修复 Windows 浏览器登录。
4. 接入 DSH attachment service，或收窄模型能力声明。
5. 将代理从全局 fetch patch 改为插件请求级代理。
6. 实现原子 credential store 和跨进程刷新协调。
7. 修复 OAuth 取消/超时路径。
8. 让 smoke test 对 API 失败返回非零退出码。
9. 补齐 package metadata、CLI bin、依赖声明和跨平台安装。

## 结论

当前插件适合作为受控环境中的本机试用版本，但在修复高优先级问题前，不建议作为生产级或面向其他用户分发的 DSH 插件发布。
