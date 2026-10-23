# Agent Note: chat-bridge binder —— 持久化房间绑定，唤醒被绑定的 Session

Status: implemented

[English](2026-10-21-chat-bridge-binder.md) | 中文

## Problem

chat-bridge 是外部 MCP 协作服务器：AI 以注册名字加入房间、按名字互相点名、轮流发言。harness 内的 agent 通过 MCP 工具参与协作，但只有轮次运行期间在场。Session 空闲（无存活 Agent）时，房间里发给它的消息无人读取，直到用户手动打开该 Session 并输入提示词。部署方需要的是反向链路：当外部 AI 在被绑定的 harness Session 离线时，通过 chat-bridge MCP 工具向它发送指令，harness 应主动唤醒对应对话并把消息交给它。

唤醒本身所需的一切能力 harness 都已具备——持久化 Session、Session 控制器的恢复路径、schedule 包的投递机制（向空闲 Session 排入一条 user 角色消息并刷新持久化）——只是没有任何组件把外部房间连接到被绑定的 Session。

## Decision

新增实验包 `@deepseek-ai/dsh-experimental-chat-bridge-binder`（`packages/experimental/chat-bridge-binder`），注册 `ctx.chatBridgeBinder` Service。binder 维护 harness Session 与 chat-bridge 房间之间的持久化绑定，并为每条活跃绑定运行一个后台轮询循环；房间内点名发给被绑定 agent 的消息会唤醒被绑定的 Session。

### 绑定

绑定行存储被绑定的 `sessionId`、房间 cookie、已加入的 agent 名字、最后处理的消息 id（`since`）、active/stopped 状态、来源 `source`（`declared` 或 `runtime`）与唤醒范围 `wake`，存放在 `chat_bridge_binder` 存储域。绑定通过 `cordis.yml` 中插件配置的 `bindings` 数组声明（`sessionId`、`cookie`，可选 `agentName`、`since` 与 `wake`）；服务启动时为每条声明 upsert 一行 `declared` 绑定——声明的 cookie 与名字优先，存储的游标在重启后延续——并删除已从声明中移除的 declared 行。结构性误配置（缺失 cookie、非法 session id）在加载时使插件失败；绑定的 Session 不存在则让首次唤醒以日志错误失败，因为 Session 是合法的后续创建状态，不属于误配置。

### Runtime 绑定与会话头部

Client 可以在不编辑 cordis.yml、不重载的情况下绑定当前 Session。服务继承 `TypertRemoteService` 并暴露 `@Remote list()`、`bind(request)` 与 `unbind(request)`：`list` 返回不含 cookie 的视图；`bind` 校验请求、确认 Host 持有该 Session、拒绝 declared 绑定、在 `bindTimeoutMs` 限时内执行房间握手（加入后读取房间当前消息窗口，把 `since` 基线设为其中最大的消息 id），之后才停止旧循环、写入 `runtime` 行并启动新循环。该基线使新建绑定不会用房间积压的历史唤醒 Session；已存在的行保留其存储游标。拒绝以结果码而非抛错表示，Client 因此可以按类别本地化。`unbind` 停止循环并删除 runtime 行；declared 行仍归配置所有。两种来源共用存储表并以 `source` 区分；声明清理只删除 `declared` 行，启动时为存活的 `runtime` 行重启循环。

包的 Client 入口挂载 remote 命名空间并注册会话头部入口。入口列出该 Session 的绑定；未绑定时打开表单（cookie、可选名称、唤醒范围），已绑定时展示房间名、唤醒范围、来源与状态。cookie 输入为密码框，Remote 视图从不返回它。

### 轮询循环

每条活跃绑定对独立的 MCP Streamable HTTP 客户端运行自己的循环，请求携带 `Cookie: room=<cookie>` 凭据。循环调用 `get_messages`，`reader` 设为已加入的名字，并使用配置的长轮询时长，因此请求在点名消息到达时立即返回，或在等待到期时返回。加入序列遵循 chat-bridge 约定：通过 `join_room` 复用已存储或已声明的 agent 名字，仅当该名字从未申请过才回退到 `apply_agent_name` 并持久化返回的名字。传输层失败会丢弃当前连接代际，使重试重新连接并重新加入；重试按有界指数退避，语义对齐 `dsh-mcp-client` 的重连策略，预算耗尽时记录响亮的放弃错误并停止循环，等待重新加载。

### 唤醒投递

投递复用 schedule 机制：`ctx.sessionController.resolveAgent(sessionId)` 恢复 Session 的 Agent，`agent.followup(createUserMessage(..., source: { kind: 'chat-bridge' }))` 把房间消息排入收件箱，`ctx.sessions.flush(...)` 必须报告持久化确认后游标才提交。这个顺序使唤醒为 at-least-once：在刷新与游标提交之间崩溃会在重启后重新投递该消息，而不是丢失。面向模型的框架文本固定携带发送者、头行点名时的目标与该消息正文；正文受配置的 `maxMessageBytes` 限制。默认的 `wake: idle-only` 投递房间对该成员可见的每条消息；`wake: always` 只投递目标点名该已加入成员的消息，因此房间广播无法重新启动用户已停止的 Session。

### 守护进程不代写房间消息

binder 只读。回复经 agent 自己的 chat-bridge MCP 工具（`send_message`、`claim_turn`）发出，由部署方通过 `dsh-mcp-client` 单独接线。这保证每个 agent 身份只有一个写入者，防止 binder 替 agent 重复发送。

### Session 生命周期

`workspace/session-stop` 时，`idle-only` 绑定被标记为 stopped 并结束其循环；下次启动时声明会重新激活它。`always` 绑定继续轮询并在停止后保持 active，之后的一条点名消息会重新启动该 Session。已归档 Session 的唤醒经 Session 控制器的稳定错误失败并记录日志；行保留，让部署方看到持续的不一致。

### 凭据

房间 cookie 是持久化凭据。它保存在绑定行中，绝不写入日志、绝不出现在错误消息里、绝不进入面向模型的内容；注入消息只携带房间内的发送者名字与正文。

## Alternatives considered

**通过 WebUI REST API 的 SSE 订阅。** 房间详情事件流推送完整房间快照，但需要 WebUI JWT，且会把订阅者注册为 web 房间成员。这使 binder 耦合到 WebUI 账号体系，并把成员变更变成轮询的副作用。它输给了 MCP 长轮询——后者只需要绑定本来就持有的房间 cookie。

**服务端 webhook 推送（需要改 chat-bridge）。** 在房间上加 `register_webhook(url)` 延迟最低，但需要修改 chat-bridge 代码，并在 harness 主机上开一个入站 HTTP 监听。本设计的约束是 chat-bridge 侧零改动、不新增入站端口；它暂时落选，若将来需要推送语义仍是一条路。

**每条绑定复用一个 `dsh-mcp-client` 插件实例。** 该插件把服务器工具注册为面向模型的能力并与工具注册表保持同步；binder 需要的是无界面读取器：每绑定独立凭据、按 reader 收窄的长轮询、零面向模型表面。它的连接监督器确实符合重连策略，因此 binder 镜像这些语义而不是引入其工具同步机制。

**用 `inject()` 代替 `followup()` 投递。** 注入的消息进入上下文但不唤醒驱动器，空闲 Session 会收到文本却从不运行轮次。需求是唤醒，所以消息以 user 角色消息进入收件箱并启动一轮。

## Consequences

买到的：空闲 Session 零算力而绑定维持房间在场；harness 重启后每条绑定从存储游标恢复，收齐房间保留的全部消息；唤醒走 schedule 同一条经过审计、刷新、模型可见的链路，消息可从 session 日志重建。

代价与接受的取舍：即使 harness 空闲，被绑定成员在房间里也始终显示在线；每条绑定保持一个长轮询 HTTP 请求；刷新与游标提交之间崩溃会重复一次唤醒（at-least-once 投递）；binder 的名字申请会为每条绑定占用一个 chat-bridge 名字名额；`always` 绑定允许房间对端重新启动用户已停止的 Session，因此不受信任的房间应保持 `idle-only`；房间 cookie 与其他持久化数据同存于存储域，必须按凭据对待。

延后：`chat-bridge` 消息 source kind 的客户端归因展示（当前走通用 turn-trigger 回退）；在 Session 内创建绑定的面向模型工具；把 runtime 绑定写回 cordis.yml（`runtime` 行只属于本 Host）；唤醒框架文本的 recorded-session 快照覆盖（框架文本已在单测中逐字固定，且真实模型轮次没有免 key 的录制路径）。

## Testing

包测试以进程内伪造 chat-bridge MCP 服务器和 schedule 风格 harness（伪造 Session 解析器与 flush 侦测）运行服务：唤醒投递与框架文本、游标持久化与重启恢复、加入名字回退、重连退避与放弃、两种唤醒模式下的 session-stop 处理、配置校验响亮失败，以及 cookie 约束（绝不出现在日志、错误与注入内容中）。Runtime API 测试覆盖 bind、unbind、拒绝码、无凭据列表、runtime 行重启恢复与循环取消；Client 测试在 jsdom 中以伪造 Remote 渲染会话头部入口（绑定、解绑、拒绝、刷新失败、键盘关闭、进行中状态），并覆盖挂载接线、slot 元数据、Remote 转发与注册回滚。另有真实 Loader 组合测试从临时 `cordis.yml` 加载插件并针对伪造房间断言唤醒；包保持每文件 100% 覆盖率。
