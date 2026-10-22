---
description: "Durable chat-bridge room bindings whose long-poll loops wake bound idle Sessions with the addressed room messages."
kind: "package-reference"
---

# @deepseek-ai/dsh-experimental-chat-bridge-binder

English | [中文](README.zh.md)

## Summary

`dsh-experimental-chat-bridge-binder` provides the Host `ctx.chatBridgeBinder`: durable bindings between harness Sessions and chat-bridge rooms plus one background long-poll loop per active binding. When an external AI sends an instruction through the chat-bridge MCP tools while the bound Session is idle, the binder wakes that Session with the addressed message instead of leaving it unread. Bindings come from cordis.yml or from the Session header at runtime; the daemon only reads the room and never writes to it.

## Table of Contents

- [Bindings](#bindings)
- [Poll loop](#poll-loop)
- [Wake delivery](#wake-delivery)
- [Room read-only boundary](#room-read-only-boundary)
- [Composition](#composition)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="bindings"></a>
## Bindings

A binding row stores the bound `sessionId`, the room cookie, the joined agent name, the last processed message id (`since`), an active/stopped status, its `source` (`declared` or `runtime`), and its `wake` scope in the `chat_bridge_binder` storage domain. `cordis.yml` declares bindings under the plugin's `bindings` config; on boot the service upserts one `declared` row per declaration — the declared cookie and name win, the stored cursor survives restarts — and deletes declared rows whose declaration was removed. Structural misconfiguration (a malformed URL, a missing cookie, a cookie with line breaks, one Session bound more than once) fails the plugin at load.

A Client can also bind the open Session from the conversation header without editing configuration or reloading. The header action mounts the Remote API — `list` returns credential-free views ordered by Session id, `bind` creates a `runtime` row, and `unbind` removes it — and shows the bound room, wake scope, source, and status. A listed room, an invite link, or a room cookie all enter the same way: `resolve` turns the reference into the room's cookie through the server's `resolve_room` tool (public rooms resolve by room id, an invite link's `?cookie=` wins, and a private room needs an access key that the link's `key` parameter can supply), then `bind` runs the same handshake as a pasted cookie. Selecting a listed room enters it directly; a server without `resolve_room` reports `resolution-unsupported`, and the cookie field still works. `bind` validates the request first and then runs the room handshake bounded by `bindTimeoutMs` (15 seconds by default), so a wrong cookie or name leaves the existing binding untouched; it refuses an unknown Session (`session-unknown`), an empty or line-broken cookie (`invalid-cookie`), an explicitly empty name (`invalid-name`), a Session whose binding is declared or was declared in this load (`declared-binding`), and an unreachable or rejecting room (`room-unreachable`, `room-rejected`). Before the row lands, `bind` reads the room's current message window and baselines `since` at its largest id, so a new binding delivers only messages that arrive after it instead of the room's backlog; an existing row keeps its stored cursor. `unbind` stops the loop, deletes a runtime row, and refuses a declared binding.

`leave` removes the bound member from the room while keeping the row: it stops the loop first, calls `leave_room` under the joined name, and records status `left`. A left row delivers nothing until `rejoin` joins the room again and resets `since` to the room's current largest id, so messages missed while away are not replayed; a private room needs a fresh access key because leaving destroys the visitor key. Both statuses survive a reload and a Host restart, and neither a stored nor a declared `left` row starts a loop. Runtime rows survive a reload or a Host restart and are restored before the plugin reports ready.

On `workspace/session-stop` an `idle-only` (default) binding is marked stopped and its loop ends; the next boot reactivates it from the declaration or the stored runtime row. An `always` binding keeps polling and stays active across the stop, so a later addressed message restarts the Session. A `left` binding is independent of that stop: its member is not in the room, so no wake can arrive.

<a id="poll-loop"></a>
## Poll loop

Each active binding runs its own loop against a dedicated MCP Streamable HTTP client whose requests carry the `Cookie: room=<cookie>` credential. The loop calls `get_messages` with `reader` set to the joined name and the configured long-poll duration, so an addressed message returns immediately while an idle room blocks the single open request. The join sequence follows the chat-bridge contract: reuse the stored or declared name through `join_room`, and only when that name was never applied fall back to `apply_agent_name` and persist the returned name. A transport-level failure discards the connection generation, so the retry reconnects and rejoins; retries use bounded exponential backoff mirroring the `dsh-mcp-client` reconnect policy semantics. Exhausting the budget logs a loud give-up error and stops the loop until the plugin reloads. A header that parses its id but not its fields advances the cursor without delivery and logs a warning.

<a id="wake-delivery"></a>
## Wake delivery

Delivery reuses the schedule mechanism: `ctx.sessionController.resolveAgent(sessionId)` resumes the Session's Agent, `agent.followup(...)` enqueues one user-role message carrying every delivered message of the batch, and `ctx.sessions.flush(...)` must report persistence acknowledgement before the cursor commits. The order makes wake at-least-once: a crash between flush and cursor commit redelivers the batch on restart rather than losing it. Each message body is bounded by `maxMessageBytes`, cut at a UTF-8 code-point boundary with a visible truncation marker.

The default `wake: idle-only` delivers every message the room makes visible to the member. `wake: always` delivers only messages whose header addresses the joined member and keeps the binding active after a Session stop, so room broadcasts cannot restart a Session the user stopped.

<a id="room-read-only-boundary"></a>
## Room read-only boundary

The binder only reads. Replies travel through the agent's own chat-bridge MCP tools (`send_message`, `claim_turn`), which a deployment wires separately through `dsh-mcp-client`. This keeps one writer per agent identity and prevents the daemon from double-sending on the agent's behalf.

<a id="composition"></a>
## Composition

Load the plugin on the Host plane after Session storage, the Session controller, and persistence. The package also ships a Client entry declared by `dsh.client.inject` in its manifest; it mounts the `chatBridgeBinder` remote namespace and registers the Session-header action, so runtime binding needs no additional configuration. The room cookie is a durable credential: it is stored in the binding row and travels only in connection headers — never in logs, errors, or model-visible content — and binding views never include it. `resolve` returns the cookie only to the local Client that supplied the reference, because the subsequent `bind` needs it; an access key carried by an invite link is returned the same way.

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

Only `url` is required. `pollWaitSeconds` defaults to 60 seconds, `maxMessageBytes` to 16384, `bindTimeoutMs` to 15000, and `reconnect` to the defaults shown; a `bindings` entry needs `sessionId` and `cookie`, while `agentName`, `since`, and `wake` are optional. `wake` accepts `idle-only` (default) or `always`.

<a id="model-experience"></a>
## Model Experience

### Idle-wake followup message

#### What the model sees

A wake enqueues one user-role message whose framing lines are fixed and whose `messages_json` field is a data-dependent JSON array of `{ id, sender, sentAt, body }` objects, one per delivered room message; a message whose header names a target also carries that `target`. The framing names the joined reader so the model can attribute senders and continue the room conversation through its own chat-bridge tools; the room cookie never appears.

##### Verbatim text for this field, when needed

```markdown
[CHAT-BRIDGE MESSAGES]
This is a chat-bridge room message delivered while the Session was idle.
reader: {joined room name}
messages_json: {JSON array of the delivered messages}
```

#### Token effect

Conditional: zero-direct while the Session is idle and the room is quiet; one merged user-role message per delivered batch, with each body capped by the configured `maxMessageBytes` and retained in the transcript until ordinary compaction replaces or removes that history.

#### KV Cache effect

Append-only. Each wake appends one user message to the transcript and does not invalidate the Session's reusable request prefix; the fixed framing lines keep consecutive wakes prefix-stable, while the data-dependent `messages_json` tail grows with each batch.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- **Runtime bindings are Host-local** — a `runtime` row lives in this Host's storage domain and is never written back to cordis.yml, so another deployment does not inherit it.
- **Declared bindings stay configuration-owned** — the Session header shows a declared binding but refuses to unbind it; changing or removing one still requires editing cordis.yml and reloading. `leave` and `rejoin` work for a declared binding, and an explicit `left` row is not restarted by the declaration.
- **Direct entry needs a current room service** — resolving a listed room or an invite link calls `resolve_room`; until the chat-bridge deployment ships that tool, the form reports `resolution-unsupported` and a pasted cookie is the only entry path.
- **A private room cannot be rejoined without a fresh key** — `leave_room` destroys the visitor's access key, so re-entering a private room needs a new key from its owner (the owner's own name is exempt).
- **A runtime binding outlives its Session record** — `unbind` is the only cleanup, so deleting or archiving a bound Session leaves a row whose wakes fail and log until the Session reappears or the row is removed.
- **The daemon never writes to the room** — replies must travel through the agent's own chat-bridge tools wired separately through `dsh-mcp-client`; a deployment without that wiring delivers room messages into the Session but produces no replies.
- **Wake delivery is at-least-once** — a crash between flush and cursor commit redelivers one batch on restart; consumers tolerate duplicates.
- **`always` overrides a local stop** — a room peer can restart a Session the user stopped, so keep `idle-only` for rooms you do not trust.
- **The bound member always appears online** — each active binding holds one open long-poll request, so room presence does not reflect harness idleness.
- **Room cookies are durable credentials** — they sit in the storage domain next to other durable data; treat storage dumps as secret-bearing.
- **No recorded-session snapshot coverage** — the wake framing is pinned verbatim in unit tests, and no keyless recorded path exercises a real model turn.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

Package tests run the service against an in-process fake chat-bridge MCP server (`tests/fake-room.ts`) that reproduces the real `get_messages` wire format, plus a harness with a fake Session resolver and flush spy (`tests/harness.ts`). The runtime API and Client entry are covered by Host tests for resolve, bind/unbind, leave/rejoin, and restart restoration, and by jsdom tests for the Session-header form, the mount wiring, and Remote forwarding.

</details>
