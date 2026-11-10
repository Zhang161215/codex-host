# Claude Code 多账号

codexhost 可以保存多个 Claude 订阅登录，让 Claude Code Thread 在其中一个账号下运行，并在额度用尽时自动换到另一个账号。没有选中保存的账号时，Claude Code 照常使用它自己的登录（`claude login` / 钥匙串 / `.credentials.json`），行为与未启用本功能完全一致。

## 为什么不切换 Claude Code 自己的登录

外部切号工具改的是 Claude Code 的原生凭据（macOS 钥匙串、Windows 凭据管理器或 `~/.claude/.credentials.json`），codexhost 里的 Claude Code 跟不上，原因有三：

- 每个 Thread 是一个长期存活的 `claude` 进程，空闲释放默认关闭；已启动的进程不会重新读取凭据。
- Claude Code 自己会在 401 时回退到磁盘上的旧 token，并缓存钥匙串读取约 30 秒。
- Windows 上 Claude Code 在 `tengu_windows_credman` 开启时改用凭据管理器，替换 `.credentials.json` 不一定生效。

所以 Adapter 不碰原生凭据，而是自己保存登录，启动 `claude` 时用 `CLAUDE_CODE_OAUTH_TOKEN` 环境变量注入当前账号的 access token。环境变量的优先级高于 Claude Code 的所有存储登录（`claude auth status` 显示 `authMethod: "oauth_token"`），macOS 和 Windows 行为一致。

## 选中保存的账号时，进程只走这个账号

账号由 codexhost 决定，外部配置不能把进程带到别处（`account-profiles/spawn-environment.ts`）：

- Claude Code 的认证优先级里 `ANTHROPIC_AUTH_TOKEN` 高于 `CLAUDE_CODE_OAUTH_TOKEN`，`ANTHROPIC_BASE_URL` 会把带 OAuth token 的请求发到别的地址。启动环境里继承来的这类变量全部移除（不区分大小写，Windows 环境变量名不区分大小写）：`ANTHROPIC_API_KEY`、`ANTHROPIC_AUTH_TOKEN`、`ANTHROPIC_BASE_URL`、`ANTHROPIC_CUSTOM_HEADERS`、`ANTHROPIC_UNIX_SOCKET`、各类 token 文件描述符、`CLAUDE_CODE_USE_*` 第三方云开关，以及旧的订阅类型 / 组织变量。
- `settings.json` 的 `env` 是 Claude Code 进程启动后自己读进来的，删启动环境挡不住。注入同时设置 `CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST=1`：Claude Code（2.1.317 源码确认）随后忽略所有来自设置文件的供应商、端点、凭据与模型路由变量（`ANTHROPIC_BASE_URL`、`ANTHROPIC_AUTH_TOKEN`、`ANTHROPIC_API_KEY`、`CLAUDE_CODE_USE_*`、`ANTHROPIC_MODEL` 等），也不再执行设置里的 `apiKeyHelper`。其余设置（权限、hooks、MCP、代理等）照常生效。
- 环境变量 token 不带账号资料，同时传 `CLAUDE_CODE_SUBSCRIPTION_TYPE`（`pro` / `max` / `team` / `enterprise`）与 `CLAUDE_CODE_ORGANIZATION_UUID`，Claude Code 才按该账号的套餐决定默认模型与可用模型。
- 选中“本机 Claude Code 登录”时不做任何改动，进程按 Claude Code 自己的配置运行。

## 本机 Claude Code 登录

账号列表始终有一行“本机 Claude Code 登录”，自动读取这台电脑上 Claude Code 当前登录的账号，选中它即不注入任何 token、由 Claude Code 使用自己的登录：

- 身份读自 Claude Code 的全局配置 `oauthAccount`（`$CLAUDE_CONFIG_DIR/.claude.json` 或 `~/.claude.json`，存在旧版 `~/.claude/.config.json` 时优先），按文件修改时间缓存。
- token 只读：macOS 用与 Claude Code 相同的 `security find-generic-password -a $USER -s "Claude Code-credentials[-<CLAUDE_CONFIG_DIR 哈希>]"`，不会弹钥匙串授权；其他平台读 `.credentials.json`。Windows 上 Claude Code 可能把 token 放在凭据管理器里，此时只显示身份、不显示额度。token 未过期时用它读一次额度（60 秒内复用），过期就不读；**从不刷新**，因为刷新会轮换 Claude Code 自己的 refresh token，把 Claude Code 登出。
- 当前使用本机登录时，原生会话推送的 `rate_limit_event` 也写入这一行的额度，达到阈值同样会自动切到保存的账号。
- 本机登录模式的会话键是 `native:<accountUuid>:<organizationUuid>`：其他工具切换了 Claude Code 自己的登录后，空闲 Thread 在下一轮按新账号 `resume`，正在运行的不受影响。
- 与某个保存账号是同一账号时标注“已同时保存为账号”。本机有 Claude Code 登录时，添加或导入账号不会改变正在使用的账号；只有本机没有登录时，第一个保存的账号自动启用。

## 导入

“导入账号”选择一个 JSON 文件（不超过 3 MB），Adapter 识别其中所有带 Claude Code 凭据结构的记录：账号管理工具导出（如 Cockpit Tools 的 `claude_credentials_raw.claudeAiOauth`，旁边的 `email`、`account_uuid`、`organization_uuid`、`plan_type` 与 `claude_config_raw.oauthAccount` 提供身份）、Claude Code 的 `.credentials.json`（`claudeAiOauth`），或 `{ "accessToken": "sk-ant-oat…" }`。没有邮箱且 token 仍有效时，用资料接口补上账号名。

- 导入的是普通登录 token：access token 约 8 小时，refresh token 有固定期限（导出里的 `refreshTokenExpiresAt`，刷新不会延长）。设置页把这个期限显示为账号的到期时间，少于 30 天时提示重新登录；重新登录会换成一年期 token。
- 导入后 codexhost 会刷新这些 token，refresh token 随之轮换，导出它们的工具里那份就会失效；同一账号不要在两边同时使用。
- 已保存且可用的账号不会被导入覆盖；已失效的副本也不会覆盖任何账号。结果按“新增、更新（替换了已失效的保存账号）、已存在、已失效”汇总显示。
- 控制台转发 Host 请求的请求体上限为此放宽到 4 MiB（其余控制台接口仍是 16 KiB，且都在请求头与来源校验之后才读取）。

## 登录与保存

- 添加账号走与 `claude setup-token` 完全相同的长效登录：OAuth PKCE 授权（`claude.com/cai/oauth/authorize`），scope 只申请 `user:inference`，换 token（`platform.claude.com/v1/oauth/token`）时带 `expires_in: 31536000`，得到一年有效、无需刷新的 access token（Claude Code 2.1.321 源码：`setup-token` 即 `inferenceOnly` + `expiresIn: 31536000`）。多申请任何 scope 都拿不到一年期：2026-11 前的版本申请了 `user:inference user:profile`，实际得到的是普通可刷新登录，refresh token 约 30 天后到期，设置页随即提示“到期，请重新登录”；这类账号用新版重新登录一次即换成一年期。
- 只有推理权限的 token 不能调资料与额度接口（Claude Code 自己也只在有 `user:profile` 时才查额度），Adapter 对这类 token 不发这两个请求：账号名取换 token 响应里的邮箱，套餐若响应里没有就不显示、也不传 `CLAUDE_CODE_SUBSCRIPTION_TYPE`（同一账号以前保存过的套餐保留）；额度在账号运行后由 `rate_limit_event` 写入，自动切换按最近一次看到的额度排序，从未运行过的账号按 50% 计。
- 普通登录的 refresh token 有约 29 天的绝对期限，刷新不能延长，所以长效 token 比“定期刷新”更省事：一年内不需要重新登录，也不存在两边轮换 refresh token 互相顶掉的问题。
- 换 token 的响应自带账号 `email_address` / `uuid` 与组织 `uuid`；token 有 `user:profile` 时资料接口再补上订阅类型，资料接口失败时只用前者。同一账号（`account.uuid` + `organization.uuid`）重复登录只更新已有记录，不新增条目。第一个账号自动成为当前账号。
- 与 Claude Code 一样，一次登录同时给出两个链接，共用同一对 PKCE 与 `state`：“打开登录页”走 `http://localhost:<随机端口>/callback`，Adapter 在 `127.0.0.1` 与 `::1` 的同一端口上监听，回调成功后跳转官方成功页；“复制登录链接”走官方授权码页（`platform.claude.com/oauth/code/callback`），可在任意浏览器或其他设备打开，登录后把页面上的 `code#state` 粘贴回设置页。粘贴的若是本机回调链接，则按回调地址换 token；`state` 不匹配会拒绝。复制失败时显示链接供手动复制。登录面板每次登录只构建一次，轮询不会清掉正在粘贴的内容。
- 同一个输入框也接受已有的 `sk-ant-oat…` token（例如 `claude setup-token` 的输出，`token.add` 动作）。这类 token 只有推理权限，读不到资料和额度：名称显示为 `Claude (…末四位)`，有效期未知，额度在它作为当前账号运行后由 `rate_limit_event` 写入，资料或额度接口返回 403 不算错误。
- 所有平台同一种存储：元数据在 `<CODEXHOST_DATA_DIR 或 ~/.codexhost>/claude-accounts/profiles.json`，token 在同目录 `secrets/<profileId>.json`。macOS/Linux 为 0600；Windows 继承用户目录 ACL，与 Claude Code 自己在 Windows 上的 `.credentials.json` 保护方式一致。写入用临时文件加替换，Windows 上替换遇到 `EPERM`/`EBUSY`/`EACCES` 短暂重试。整个 `claude-accounts` 目录可以直接拷到另一台机器使用。
- 长效 token 不刷新：过期，或 Turn 因认证失败被 Claude 拒绝时，账号标记为“登录已失效”，当前账号会自动换到下一个可用账号（只有推理权限的 token 没有别的接口可复查，Turn 被拒即为结论；带 `user:profile` 的 token 先用额度接口复查，401 才算失效）。少于 30 天到期时设置页提示重新登录。仍带 refresh token 的旧记录照常在到期前 30 分钟刷新。

## 切换生效时机

- 每次启动或复用会话进程前，Adapter 计算当前登录的键（profileId + token 摘要）。键变化时，若该 Thread 处于空闲（没有进行中的 Turn、自主 Turn、取消、配置变更或后台命令），关闭旧进程并以 `resume` 重新打开，同一会话历史在新账号下继续；不空闲时保留旧进程，正在运行的任务不受影响，下一次空闲时再切换。切换不需要重启 codexhost。
- 设置页账号区显示打开的 Claude Thread 各自所处位置（状态里的 `threads`）：已在用当前账号、空闲且下一条消息时切换、正在回复且本轮结束后切换。区块打开时每 5 秒重读一次；正在编辑、下拉框展开或焦点在区块内时不重绘。
- 模型列表探测进程同样使用当前账号的环境。
- 设置页“账号”里的 Claude Code 额度显示当前保存账号的用量；使用原生登录时仍读 Claude Code 自己的额度。

## 自动切换

- 默认开启，阈值 95%，可选 80–100%。阈值作用于 5 小时与 7 天两个窗口中较高的一个。
- 触发来源是 Claude Code 流里的 `rate_limit_event`：用量写回发出事件的那个进程所用的账号（切换后仍在跑完本轮的 Thread 报的是旧账号，不会算到新账号头上，也不会触发切换）；只有当前账号达到阈值且距上次自动切换超过 2 分钟时，才刷新其他账号的额度，选两窗口最高用量最低、且低于阈值的可用账号切过去。没有满足条件的账号时保持不变。
- `rate_limit_info.status` 为 `rejected` 表示 Claude 已拒绝请求：对应窗口记为 100%，并立即切换，不受阈值与 2 分钟冷却限制（按模型的周限额如 `seven_day_opus` 被拒同样切换）。被拒的那一轮以失败结束。
- 撞限额自动续跑（`autoSwitch.continueAfterLimit`，默认开，旧配置视为开）：失败的那一轮在进行中收到过本进程的 `rejected`，且等这次额度记账和切换落定后当前账号已不是该轮所用账号时，Thread 用新账号 `resume` 同一会话，开一个自主 Turn，发送「继续」接着做（Thread 中显示为一条用户消息）。仍有后台命令等未结束工作时进程不能换，不续跑，下一条消息再换。两条用户消息之间最多续跑 3 次；关闭自动切换或续跑、没有可换的账号、普通失败（未收到 `rejected`）都不续跑。
- 每个账号的 5 小时 / 7 天额度只推给在同一账号下运行的 Thread，不同账号的 Thread 不共享额度显示。
- 当前账号登录失效（过期、被拒绝或刷新失败）时同样触发自动切换。Turn 因认证失败结束时，Adapter 立即复查该账号（一年期 token 直接标记失效，带 `user:profile` 的用额度接口复查、401 才算），下一条消息换到其他账号。
- 额度每 60 秒内复用缓存，设置页“刷新额度”强制刷新；有 `user:profile` 的账号从 `GET api.anthropic.com/api/oauth/usage` 读取，不是实时推送；一年期账号只有运行时 `rate_limit_event` 推送的数据。

## 日志

账号模块写入 Host Runtime 日志（`~/.codexhost/logs/host-runtime-<pid>.log`），每行 `[claude-accounts] {"event": ...}`，只记账号的 profileId，不记邮箱、token、授权码或登录链接。事件：`login.started` / `login.callbackRejected`（回调被拒原因）/ `login.codePasted` / `login.timedOut`（附收到的回调次数）/ `login.profileUnavailable` / `login.completed`（token 有效期、能否刷新）/ `login.failed`（OAuth 错误码与 HTTP 状态）/ `login.cancelled`，`account.switched`（from、to、manual|auto）、`account.removed`、`account.expired`、`token.refreshed` / `token.refreshFailed`、`signIn.unusable`、`turn.authenticationFailed`、`quota.rejected`、`autoSwitch.triggered`（用量、是否被拒）、`autoSwitch.noAccount`、`continuation.started` / `continuation.skipped`（原因）、`import.completed`（各类数量）、`thread.restarted`（Thread 因换号重开进程）。

## 协议

Renderer 经 `codexhost/harness/account-profiles`（`shared-contracts` 的 `harnessAccountProfilesParamsSchema`）发送 `list`、`login.start`、`login.complete`、`login.cancel`、`import`、`token.add`、`activate`、`remove`、`rename`、`autoSwitch.set`，Host 按 `harnessId` 路由到 Adapter 公开的 `accountProfiles` 能力，返回完整状态（含 `native` 与 `threads`；`import` 的回复另带 `importSummary`）。没有这个能力的 Harness 不显示该区块。Desktop 设置页经 `versioned-renderer-adapter.ts` 的设置客户端转发，新增客户端方法时那里也要转发，否则 Desktop 中请求不会发出、区块保持隐藏。`activate` 传 `null` 表示回到 Claude Code 自身登录。

## 验证

- 单元测试：`packages/adapters/claude-code/test/account-profiles.test.ts`（一年期 token 请求与 scope、去重、切换、长效 token 不刷新、过期或被拒后自动换号、旧 refresh token 刷新、粘贴 setup-token、阈值切换、删除当前账号、文件存储、复制链接走授权码页、导入导出文件与 `.credentials.json`、本机登录只读且不刷新、本机账号切换改变会话键并可自动切到保存账号）、外部路由变量全部被挡住、旧账号额度不记到新账号、`rejected` 立即切换、Thread 状态统计、认证失败后换号）、`native-message.test.ts`（`rejected` 解析）与 `claude-code-adapter.test.ts` 的 “saved Claude sign-ins”（注入环境、空闲时按新账号 resume、运行中的 Turn 跑完再切、额度按进程所用账号上报、认证失败上报、被拒的一轮在新账号续跑、普通失败与未换号时不续跑）；`account-profiles.test.ts` 另覆盖续跑判定与日志不含邮箱或 token。
- 2026-11-09 从 Claude Code 2.1.317 源码确认认证优先级（`ANTHROPIC_AUTH_TOKEN` > `CLAUDE_CODE_OAUTH_TOKEN` > 存储登录）、`CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST` 忽略设置文件中的供应商变量与 `apiKeyHelper`，以及 `rate_limit_info.status` 的 `rejected`。
- 2026-11-09 在 Claude Code 2.1.317 上确认 `CLAUDE_CODE_OAUTH_TOKEN` 优先于钥匙串登录。2026-11-10 真实账号用 `user:inference user:profile` 登录后到期日只有约 30 天（普通可刷新登录），第三方“这两个 scope 也给一年期”的结论不成立；随后从 Claude Code 2.1.321 的 `setup-token` 实现确认只申请 `user:inference`，且只在有 `user:profile` 时查额度。只申请 `user:inference` 后的真实账号登录尚待验证（Host 日志 `login.completed` 的 `lifetimeSeconds` 约 31536000、`refreshable: false` 即为成功）；Windows 实机尚未验证。
