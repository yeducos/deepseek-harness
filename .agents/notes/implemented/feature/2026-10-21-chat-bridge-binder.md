# Agent Note: chat-bridge binder — durable room bindings that wake bound Sessions

Status: implemented

English | [中文](2026-10-21-chat-bridge-binder.zh.md)

## Problem

chat-bridge, the external MCP coordination server, lets AI agents collaborate in shared rooms: agents join under registered names, address each other by name, and take turns. An agent inside the harness participates through MCP tools, but only while a turn is running. When the Session is idle — no live Agent — a room message addressed to it stays unread until a human manually opens the Session and prompts it. The deployment wants the reverse direction: when an external AI sends an instruction through the chat-bridge MCP tools while the bound harness Session is offline, the harness proactively wakes that conversation and hands it the message.

The harness already has every ingredient for the wake itself — durable Sessions, the Session controller's resume path, and the schedule package's delivery mechanism that enqueues a user-role message into an idle Session and flushes it — but nothing connects an external room to a bound Session.

## Decision

A new experimental package, `@deepseek-ai/dsh-experimental-chat-bridge-binder` (`packages/experimental/chat-bridge-binder`), registers the `ctx.chatBridgeBinder` Service. The binder holds durable bindings between harness Sessions and chat-bridge rooms and runs one background poll loop per active binding; a room message addressed to the bound agent wakes the bound Session.

### Bindings

A binding row stores the bound `sessionId`, the room cookie, the joined agent name, the last processed message id (`since`), an active/stopped status, its `source` (`declared` or `runtime`), and its `wake` scope. Rows live in the `chat_bridge_binder` storage domain. Bindings are declared in `cordis.yml` under the plugin's `bindings` config (`sessionId`, `cookie`, optional `agentName`, `since`, and `wake`); on boot the service upserts one `declared` row per declaration — the declared cookie and name win, the stored cursor survives restarts — and deletes declared rows whose declaration was removed. Structural misconfiguration (a missing cookie, a malformed session id) fails the plugin at load; a bound Session that does not exist fails the first wake with a logged error, because Session creation is a legitimate later state, not a misconfiguration.

### Runtime bindings and the Session header

A Client can bind the open Session without editing cordis.yml or reloading. The service subclasses `TypertRemoteService` and exposes `@Remote list()`, `bind(request)`, and `unbind(request)`: `list` returns views without the cookie, `bind` validates the request, checks that the Host holds the Session, refuses a declared binding, runs the room handshake under `bindTimeoutMs` — joining and then reading the room's current message window to baseline `since` at its largest id — and only then stops any old loop, writes a `runtime` row, and starts the new loop. The baseline keeps a fresh binding from waking the Session with the room's backlog; an existing row keeps its stored cursor. A refusal is a result code rather than a thrown error, so the Client can localize each category. `unbind` stops the loop and deletes a runtime row; declared rows stay configuration-owned. Both sources share the storage table and are distinguished by `source`; declaration cleanup only removes `declared` rows, and boot restarts loops for surviving `runtime` rows.

The package's Client entry mounts the remote namespace and registers a conversation-header action. The action lists the Session's binding, opens a form (cookie, optional name, wake scope) when unbound, and shows the room name, wake scope, source, and status when bound. The cookie input is a password field and the Remote view never returns it.

### Poll loop

Each active binding runs its own loop against a per-binding MCP Streamable HTTP client whose requests carry the `Cookie: room=<cookie>` credential. The loop calls `get_messages` with `reader` set to the joined name and a configured long-poll duration, so the request returns as soon as an addressed message lands or the wait expires. The join sequence follows the chat-bridge contract: reuse the stored or declared agent name through `join_room`, and only when that name was never applied fall back to `apply_agent_name` and persist the returned name. A transport-level failure discards the connection generation so the retry reconnects and rejoins; retries use bounded exponential backoff mirroring the `dsh-mcp-client` reconnect policy semantics, and exhausting the budget logs a loud give-up error and stops the loop until reload.

### Wake delivery

Delivery reuses the schedule mechanism: `ctx.sessionController.resolveAgent(sessionId)` resumes the Session's Agent, `agent.followup(createUserMessage(..., source: { kind: 'chat-bridge' }))` enqueues the room message, and `ctx.sessions.flush(...)` must report persistence acknowledgement before the cursor commits. The order makes wake at-least-once: a crash between flush and cursor commit redelivers the message on restart rather than losing it. The model-visible framing text pins the sender, the addressed target when the header names one, and the message body; the body is bounded by the configured `maxMessageBytes`. The default `wake: idle-only` delivers every message the room makes visible to the member; `wake: always` delivers only messages whose target names the joined member, so room broadcasts cannot restart a Session the user stopped.

### The daemon never writes to the room

The binder only reads. Replies travel through the agent's own chat-bridge MCP tools (`send_message`, `claim_turn`), which a deployment wires separately through `dsh-mcp-client`. This keeps a single writer per agent identity and prevents the binder from double-sending on the agent's behalf.

### Session lifecycle

On `workspace/session-stop` an `idle-only` binding is marked stopped and its loop ends; on the next boot the declaration reactivates it. An `always` binding keeps polling and stays active across the stop so a later addressed message restarts the Session. An archived Session's wake fails through the Session controller's stable error and is logged; the row survives so the deployment sees the persistent mismatch.

### Credentials

The room cookie is a durable credential. It is stored in the binding row, never logged, never placed in error messages, and never included in model-visible content; the injected message carries only the sender name and body from the room.

## Alternatives considered

**SSE subscription through the WebUI REST API.** The room-detail event stream pushes the full room payload, but it requires a WebUI JWT and registers the subscriber as a web room member. That couples the binder to the WebUI account system and mutates room membership as a side effect of polling. It lost to MCP long-polling, which needs only the room cookie the binding already holds.

**Server-side webhook push (a chat-bridge change).** A `register_webhook(url)` on the room would give the lowest wake latency, but it requires chat-bridge code changes and an inbound HTTP listener on the harness host. The design constraint was zero chat-bridge-side changes and no new inbound port; it lost for now and remains the path if push semantics are ever required.

**Reusing a `dsh-mcp-client` plugin instance per binding.** That plugin registers server tools as model-facing capabilities and keeps them synced with the tool registry; the binder needs a headless reader with per-binding credentials, reader-scoped long-polls, and no model-facing surface. Its connection supervisor does fit the reconnect policy, so the binder mirrors those semantics rather than importing the tool-sync machinery.

**Delivering through `inject()` instead of `followup()`.** An injected message lands in context without waking the driver, so an idle Session would receive the text but never run a turn. The requirement is a wake, so the message enters the inbox as a user-role message that starts one.

## Consequences

Bought: an idle Session costs zero compute while its binding holds the room presence; a harness restart resumes every binding from its stored cursor and collects everything the room retained; the wake path is the same audited, flushed, model-visible route schedule uses, so the message is reconstructable from the session log.

Cost and accepted trade-offs: the bound member always appears online in the room even when the harness is idle; each binding holds one long-poll HTTP request open; a crash between flush and cursor commit duplicates one wake (at-least-once delivery); the binder's name application consumes a chat-bridge name slot per binding; an `always` binding lets a room peer restart a Session the local user stopped, so untrusted rooms should keep `idle-only`; room cookies sit in the storage domain next to other durable data and must be treated as credentials.

Deferred: client-side attribution for the `chat-bridge` message source kind (the generic turn-trigger fallback renders it); a model-facing tool for creating bindings from inside a Session; writing runtime bindings back to cordis.yml (a `runtime` row stays Host-local); recorded-session snapshot coverage for the wake framing (the framing text is pinned verbatim in unit tests, and no keyless recorded path exists for a real model turn).

## Testing

Package tests run the service against an in-process fake chat-bridge MCP server and the schedule-style harness with a fake Session resolver and flush spy: wake delivery and framing, cursor persistence and restart resume, join-name fallback, reconnect backoff and give-up, session-stop handling in both wake modes, config validation failing loud, and cookie confinement (never in logs, errors, or injected content). Runtime API tests cover bind, unbind, refusal codes, credential-free listing, restart restoration of runtime rows, and loop cancellation. Client tests render the Session-header action in jsdom against a fake Remote (binding, unbinding, refusals, refresh failure, keyboard dismissal, pending states) and cover the mount wiring, slot metadata, Remote forwarding, and registration rollback. A real Loader-composition test boots the plugin from a temporary `cordis.yml` against the fake room and asserts the wake, and the package keeps per-file coverage at 100%.
