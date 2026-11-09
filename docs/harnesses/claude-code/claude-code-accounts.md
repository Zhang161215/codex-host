# Claude Code 多账号

codexhost 可以保存多个 Claude 订阅登录，让 Claude Code Thread 在其中一个账号下运行，并在额度用尽时自动换到另一个账号。没有选中保存的账号时，Claude Code 照常使用它自己的登录（`claude login` / 钥匙串 / `.credentials.json`），行为与未启用本功能完全一致。

## 为什么不切换 Claude Code 自己的登录

外部切号工具改的是 Claude Code 的原生凭据（macOS 钥匙串、Windows 凭据管理器或 `~/.claude/.credentials.json`），codexhost 里的 Claude Code 跟不上，原因有三：

- 每个 Thread 是一个长期存活的 `claude` 进程，空闲释放默认关闭；已启动的进程不会重新读取凭据。
- Claude Code 自己会在 401 时回退到磁盘上的旧 token，并缓存钥匙串读取约 30 秒。
- Windows 上 Claude Code 在 `tengu_windows_credman` 开启时改用凭据管理器，替换 `.credentials.json` 不一定生效。

所以 Adapter 不碰原生凭据，而是自己保存登录，启动 `claude` 时用 `CLAUDE_CODE_OAUTH_TOKEN` 环境变量注入当前账号的 access token。环境变量的优先级高于 Claude Code 的所有存储登录（`claude auth status` 显示 `authMethod: "oauth_token"`），macOS 和 Windows 行为一致。注入时同时移除继承来的 `ANTHROPIC_API_KEY` 与 `ANTHROPIC_AUTH_TOKEN`，避免它们抢先生效。

## 登录与保存

- 添加账号走与 `claude setup-token` 相同的长效登录：OAuth PKCE 授权（`claude.com/cai/oauth/authorize`），scope 只申请 `user:inference user:profile`，换 token（`platform.claude.com/v1/oauth/token`）时带 `expires_in: 31536000`，得到一年有效、无需刷新的 access token。token 端点只对部分 scope 接受自定义有效期（`user:mcp_servers` 会被拒绝），所以不申请 Claude Code 交互登录的完整 scope；`user:profile` 保留资料与额度接口。通过 `CLAUDE_CODE_OAUTH_TOKEN` 传入时 Claude Code 本来就只按推理权限使用它。
- 普通登录的 refresh token 有约 29 天的绝对期限，刷新不能延长，所以长效 token 比“定期刷新”更省事：一年内不需要重新登录，也不存在两边轮换 refresh token 互相顶掉的问题。
- 换 token 的响应自带账号 `email_address` / `uuid` 与组织 `uuid`；资料接口再补上订阅类型，资料接口失败时只用前者。同一账号（`account.uuid` + `organization.uuid`）重复登录只更新已有记录，不新增条目。第一个账号自动成为当前账号。
- Adapter 在 `127.0.0.1` 与 `::1` 的同一随机端口上监听 `/callback`，回调成功后跳转到官方登录成功页。浏览器在另一台设备上时，可以把 `code#state` 或完整跳转链接粘贴回设置页；`state` 不匹配会拒绝。
- 同一个输入框也接受已有的 `sk-ant-oat…` token（例如 `claude setup-token` 的输出，`token.add` 动作）。这类 token 只有推理权限，读不到资料和额度：名称显示为 `Claude (…末四位)`，有效期未知，额度在它作为当前账号运行后由 `rate_limit_event` 写入，资料或额度接口返回 403 不算错误。
- 所有平台同一种存储：元数据在 `<CODEXHOST_DATA_DIR 或 ~/.codexhost>/claude-accounts/profiles.json`，token 在同目录 `secrets/<profileId>.json`。macOS/Linux 为 0600；Windows 继承用户目录 ACL，与 Claude Code 自己在 Windows 上的 `.credentials.json` 保护方式一致。写入用临时文件加替换，Windows 上替换遇到 `EPERM`/`EBUSY`/`EACCES` 短暂重试。整个 `claude-accounts` 目录可以直接拷到另一台机器使用。
- 长效 token 不刷新：过期或被 Claude 拒绝（401）时账号标记为“登录已失效”，当前账号会自动换到下一个可用账号。少于 30 天到期时设置页提示重新登录。仍带 refresh token 的旧记录照常在到期前 30 分钟刷新。

## 切换生效时机

- 每次启动或复用会话进程前，Adapter 计算当前登录的键（profileId + token 摘要）。键变化时，若该 Thread 处于空闲（没有进行中的 Turn、自主 Turn、取消、配置变更或后台命令），关闭旧进程并以 `resume` 重新打开，同一会话历史在新账号下继续；不空闲时保留旧进程，正在运行的任务不受影响，下一次空闲时再切换。
- 模型列表探测进程同样使用当前账号的环境。
- 设置页“账号”里的 Claude Code 额度显示当前保存账号的用量；使用原生登录时仍读 Claude Code 自己的额度。

## 自动切换

- 默认开启，阈值 95%，可选 80–100%。阈值作用于 5 小时与 7 天两个窗口中较高的一个。
- 触发来源是 Claude Code 流里的 `rate_limit_event`：当前账号用量写回该账号，达到阈值且距上次自动切换超过 2 分钟时，刷新其他账号的额度，选两窗口最高用量最低、且低于阈值的可用账号切过去。没有满足条件的账号时保持不变。
- 当前账号登录失效（过期、被拒绝或刷新失败）时同样触发自动切换。
- 额度每 60 秒内复用缓存，设置页“刷新额度”强制刷新；额度数据来自 `GET api.anthropic.com/api/oauth/usage`，不是实时推送。

## 协议

Renderer 经 `codexhost/harness/account-profiles`（`shared-contracts` 的 `harnessAccountProfilesParamsSchema`）发送 `list`、`login.start`、`login.complete`、`login.cancel`、`token.add`、`activate`、`remove`、`rename`、`autoSwitch.set`，Host 按 `harnessId` 路由到 Adapter 公开的 `accountProfiles` 能力，返回完整状态。没有这个能力的 Harness 不显示该区块。Desktop 设置页经 `versioned-renderer-adapter.ts` 的设置客户端转发，新增客户端方法时那里也要转发，否则 Desktop 中请求不会发出、区块保持隐藏。`activate` 传 `null` 表示回到 Claude Code 自身登录。

## 验证

- 单元测试：`packages/adapters/claude-code/test/account-profiles.test.ts`（一年期 token 请求与 scope、去重、切换、长效 token 不刷新、过期或被拒后自动换号、旧 refresh token 刷新、粘贴 setup-token、阈值切换、删除当前账号、文件存储）与 `claude-code-adapter.test.ts` 的 “saved Claude sign-ins”（注入环境、空闲时按新账号 resume、plan limit 转发）。
- 2026-11-09 在 Claude Code 2.1.317 上确认 `CLAUDE_CODE_OAUTH_TOKEN` 优先于钥匙串登录，并从其 `setup-token` 实现确认 scope 与 `expires_in` 参数。`user:inference user:profile` 可获一年期 token 的结论来自第三方实测（2026-09），本项目尚未用真实账号验证；Windows 实机尚未验证。
