---
description: "持久绑定 chat-bridge 房间，其长轮询循环以点名的房间消息唤醒绑定的空闲 Session。"
kind: "package-reference"
---

# @deepseek-ai/dsh-experimental-chat-bridge-binder

[English](README.md) | 中文

## 概述

`dsh-experimental-chat-bridge-binder` 提供 Host 的 `ctx.chatBridgeBinder`：harness Session 与 chat-bridge 房间之间的持久绑定，外加每个活动绑定各一条后台长轮询循环。当外部 AI 在绑定的 Session 空闲时通过 chat-bridge MCP 工具发送指令，binder 会以点名的消息唤醒该 Session，而不是让消息保持未读。绑定可来自 cordis.yml，也可在运行时从会话头部创建；守护器只读房间，从不写入。

## 目录

- [绑定](#bindings)
- [轮询循环](#poll-loop)
- [唤醒投递](#wake-delivery)
- [房间只读边界](#room-read-only-boundary)
- [组合](#composition)
- [模型体验](#model-experience)
- [已知限制与延期工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="bindings"></a>
## 绑定

一条绑定行在 `chat_bridge_binder` 存储域中保存绑定的 `sessionId`、房间 cookie、已加入的 agent 名称、加入握手报告的房名、最近处理的消息 id（`since`）、active/stopped 状态、来源 `source`（`declared` 或 `runtime`）与唤醒范围 `wake`。同一存储域还保存 `names` 表，以 Session 与房间 cookie 为键记录每个 Session 最近在该房间加入的成员名称；该记忆比绑定行存活更久。cordis.yml 通过插件配置中的 `bindings` 声明绑定；启动时服务为每条声明 upsert 一行 `declared` 绑定——声明的 cookie 和名称优先，存储的游标跨重启保留——并删除声明已被移除的 declared 行。结构性配置错误（URL 格式错误、缺失 cookie、cookie 含换行、同一 Session 被绑定多次）会在加载时使插件失败。

Client 也可以从会话头部绑定当前 Session，无需修改配置或重载。头部入口挂载 Remote API——`list` 返回按 Session id 排序、不含凭据的视图，`bind` 创建 `runtime` 行，`unbind` 删除它——并展示房间名、绑定的成员名称、唤醒范围、来源与状态。已绑定的 Session 还提供一个房间按钮，用于打开绑定房间的 WebUI 页面：其 `roomUrl` 由 MCP 端点 origin 与 cookie 的哈希得出，因此不含凭据；私密房间仍需在该页面提供访问密钥。面板主体是公共房间列表：点击某行即可进入该房间，行内只显示房间名与成员数，房间 ID 悬停可见；列表下方的一行次级入口展开后只有一个输入框，接受邀请链接、房间 ID 或 Cookie，仅当解析结果为私密房间时才出现访问密钥输入框；可选的房间名称与唤醒范围收在「高级设置」中。面板末尾默认收起的一段用于编辑 chat-bridge 服务地址：`endpoint` 读取 Host 当前加载的值，`setEndpoint` 同时改写 profile patch 文件中 `mcp-chat-bridge` MCP 客户端行与本插件 `chat-bridge-binder` 行的 `url`，保留注释、Cookie 及其余所有行。改动在重启 dsh 后生效，因此面板必须提示重启而不是热重载。列表中的房间、邀请链接与房间 cookie 走同一条进入路径：`resolve` 通过服务端的 `resolve_room` 工具把引用解析成房间 cookie（公共房间可按房间 ID 解析，邀请链接的 `?cookie=` 优先，私密房间需要访问密钥，链接的 `key` 参数可直接提供），随后 `bind` 执行与粘贴 cookie 相同的握手。选中列表房间即可直接进入；未提供 `resolve_room` 的服务会报告 `resolution-unsupported`，此时 cookie 输入框仍可用。`bind` 先校验请求，再在 `bindTimeoutMs`（默认 15 秒）限时内执行房间握手，因此错误的 cookie 或名称不会改动既有绑定；未显式指定名称时，它先复用本 Session 上次在该房间加入的名称，房间拒绝时才回退到申请新名称，并把最终加入的名称写入 `names` 表。`unbind` 保留该记忆，因此重新绑定仍以同一成员身份进房，不会重新申请 `AI-Server-NN`。`bind` 拒绝不存在的 Session（`session-unknown`）、为空或含换行的 cookie（`invalid-cookie`）、显式空名称（`invalid-name`）、本次加载中由声明拥有的 Session（`declared-binding`），以及不可达或拒绝握手的房间（`room-unreachable`、`room-rejected`）。写入绑定行之前，`bind` 会读取房间当前消息窗口，并把 `since` 基线设为其中最大的消息 id，因此新建绑定只投递绑定之后到达的消息，而不是房间积压的历史；已存在的行保留其存储游标。`unbind` 停止循环、删除 runtime 行，并拒绝 declared 绑定。

`leave` 把已绑定的成员移出房间但保留绑定行：先停止循环，再以已加入的名称调用 `leave_room`，并把状态记为 `left`。`left` 行不再投递任何消息，直到 `rejoin` 重新加入房间并把 `since` 重置为房间当前最大的消息 id，因此离开期间的消息不会被补发；私密房间需要新的访问密钥，因为离开会销毁访客密钥。两种状态都能跨重载与 Host 重启保留，存储或声明中的 `left` 行都不会启动循环。Runtime 行在重载或 Host 重启后保留，并在插件报告就绪前恢复。

在 `workspace/session-stop` 时，`idle-only`（默认）绑定被标记为 stopped 并结束其循环；下次启动依据声明或存储的 runtime 行重新激活。`always` 绑定继续轮询并在停止后保持 active，因此之后一条点名消息会重新启动该 Session。`left` 绑定与该停止无关：成员不在房间中，因此不会有唤醒到达。

<a id="poll-loop"></a>
## 轮询循环

每条活动绑定使用专用的 MCP Streamable HTTP 客户端运行自己的循环，其请求携带 `Cookie: room=<cookie>` 凭据。循环以已加入的名称作为 `reader`、按配置的长轮询时长调用 `get_messages`，因此点名的消息立即返回，而空闲房间会阻塞这一个打开的请求。加入序列遵循 chat-bridge 契约：通过 `join_room` 复用存储或声明的名称，仅当该名称从未应用时才回退到 `apply_agent_name` 并持久化返回的名称。传输层失败会丢弃当前连接代际，因此重试会重新连接并重新加入；重试按有界指数退避，语义镜像 `dsh-mcp-client` 的重连策略。预算耗尽会记录一条响亮的放弃错误并停止循环，直到插件重载。解析出 id 但字段不完整的头行会推进游标而不投递，并记录警告。

<a id="wake-delivery"></a>
## 唤醒投递

投递复用 schedule 机制：`ctx.sessionController.resolveAgent(sessionId)` 恢复 Session 的 Agent，`agent.followup(...)` 入队一条携带该批次全部已投递消息的 user-role 消息，且 `ctx.sessions.flush(...)` 必须在游标提交之前报告持久化确认。这一顺序使唤醒成为 at-least-once：flush 与游标提交之间崩溃会在重启时重新投递该批次而不是丢失它。每条消息体受 `maxMessageBytes` 限制，在 UTF-8 码点边界截断并带可见的截断标记。

默认的 `wake: idle-only` 会投递房间对该成员可见的每一条消息。`wake: always` 只投递头行点名该已加入成员的消息，并在 Session 停止后保持绑定 active，因此房间广播无法重新启动用户已停止的 Session。

<a id="room-read-only-boundary"></a>
## 房间只读边界

binder 只读。回复经由 agent 自己的 chat-bridge MCP 工具（`send_message`、`claim_turn`）传输，由部署另行通过 `dsh-mcp-client` 接线。这保持每个 agent 身份只有一个写入者，并防止守护器代 agent 双重发送。

<a id="composition"></a>
## 组合

在 Host plane 上、于 Session 存储、Session 控制器与持久化之后加载插件。包还提供由 manifest 的 `dsh.client.inject` 声明的 Client 入口；它挂载 `chatBridgeBinder` remote 命名空间并注册会话头部入口，因此运行时绑定无需额外配置。房间 cookie 是持久凭据：它保存在绑定行中，且只随连接头传输——绝不进入日志、错误或模型可见内容——绑定视图也从不包含它。`resolve` 只把 cookie 返回给提供该引用的本机 Client，因为随后的 `bind` 需要它；邀请链接携带的访问密钥也以同样方式返回。

```yaml
chatBridgeBinder:
  url: http://127.0.0.1:8200/mcp
  pollWaitSeconds: 60
  maxMessageBytes: 16384
  bindTimeoutMs: 15000
  reconnect:
    initialDelayMs: 500
    maxDelayMs: 30000
    maxAttempts: 10
  bindings:
    - sessionId: my-session-id
      cookie: <room cookie>
      agentName: AI-Worker-01
      since: 0
      wake: idle-only
```

仅 `url` 必填。`pollWaitSeconds` 默认 60 秒，`maxMessageBytes` 默认 16384，`bindTimeoutMs` 默认 15000，`reconnect` 默认为所示值；`bindings` 条目需要 `sessionId` 和 `cookie`，而 `agentName`、`since` 和 `wake` 可选。`wake` 接受 `idle-only`（默认）或 `always`。`endpointRows` 指定服务地址编辑器要改写的 profile patch 行 id，默认为 `mcp-chat-bridge` 与 `chat-bridge-binder`。

<a id="model-experience"></a>
## 模型体验

### 空闲唤醒 followup 消息

#### 模型看到的内容

一次唤醒入队一条 user-role 消息，其框架行固定，`messages_json` 字段是数据依赖的 JSON 数组，每条送达的房间消息对应一个 `{ id, sender, sentAt, body }` 对象；头行点名了目标的消息还会携带该 `target`。框架标明已加入的 reader，让模型能够归因发送者并通过自己的 chat-bridge 工具继续房间对话；房间 cookie 永不出现。

##### 本字段的逐字文本（需要时）

```markdown
[CHAT-BRIDGE MESSAGES]
This is a chat-bridge room message delivered while the Session was idle.
reader: {joined room name}
messages_json: {JSON array of the delivered messages}
```

#### Token 影响

条件性：Session 空闲且房间安静时为零直接影响；每个送达批次一条合并的 user-role 消息，每条消息体受配置的 `maxMessageBytes` 上限约束，并保留在 transcript 中直到普通压缩（compaction）替换或移除该历史。

#### KV Cache 影响

仅追加。每次唤醒向 transcript 追加一条 user 消息，不使 Session 的可复用请求前缀失效；固定的框架行让连续唤醒保持前缀稳定，而数据依赖的 `messages_json` 尾部随每批增长。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>

- **Runtime 绑定只属于本 Host** — `runtime` 行位于本 Host 的存储域，绝不写回 cordis.yml，因此其他部署不会继承它。
- **Declared 绑定仍归配置所有** — 会话头部会展示 declared 绑定但拒绝解绑；变更或移除仍需编辑 cordis.yml 并重载。`leave` 与 `rejoin` 对 declared 绑定同样可用，且显式的 `left` 行不会被声明重新启动。
- **直接进入需要较新的房间服务** — 解析列表房间或邀请链接会调用 `resolve_room`；在 chat-bridge 部署带上该工具之前，表单会报告 `resolution-unsupported`，粘贴 cookie 是唯一入口。
- **私密房间离开后必须重新获取密钥** — `leave_room` 会销毁访客的访问密钥，因此重新进入私密房间需要房主提供新密钥（房主本人名称除外）。
- **Runtime 绑定会存活于其 Session 记录之后** — `unbind` 是唯一的清理方式；删除或归档已绑定的 Session 会留下一行，其唤醒会失败并记录日志，直到该 Session 重新出现或该行被移除。
- **守护器从不写入房间** — 回复必须经由另行通过 `dsh-mcp-client` 接线的 agent 自己的 chat-bridge 工具传输；未接线的部署会把房间消息送入 Session 但不产生回复。
- **唤醒投递是 at-least-once** — flush 与游标提交之间崩溃会在重启时重新投递一个批次；消费方需容忍重复。
- **`always` 会覆盖本地停止** — 房间对端可以重新启动用户已停止的 Session，因此不受信任的房间应保持 `idle-only`。
- **被绑定的成员始终显示在线** — 每条活动绑定持有一个打开的长轮询请求，因此房间在线状态不反映 harness 的空闲状态。
- **房间 cookie 是持久凭据** — 它们与其他持久数据一同位于存储域；把存储转储当作含密内容对待。
- **无 recorded-session 快照覆盖** — 唤醒框架在单元测试中逐字固定，没有无密 recorded 路径演练真实模型轮次。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者工作上下文——点击展开</summary>

包测试在一个进程内 fake chat-bridge MCP 服务器（`tests/fake-room.ts`）上运行服务，该服务器复现真实的 `get_messages` wire 格式；另有一个带 fake Session 解析器与 flush spy 的 harness（`tests/harness.ts`）。Runtime API 与 Client 入口由 Host 侧的解析、绑定/解绑、离开/重新进入、重启恢复与 profile patch 服务地址改写测试，以及 jsdom 中的会话头部表单、挂载接线与 Remote 转发测试覆盖。

</details>
