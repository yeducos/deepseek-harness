---
description: "Records a persistence type transition and its compatibility acknowledgement."
kind: persistence-change
---

# 2026-10-21-chat-bridge-source

English | [中文](2026-10-21-chat-bridge-source.zh.md)

## Summary

Adds the chat-bridge attribution kind to the persisted user/developer message source union.

## Table of Contents

- [Declaration](#declaration)
- [Compatibility](#compatibility)
- [Verification](#verification)
- [Dev Note](#dev-note)

<a id="declaration"></a>
## Declaration

```yaml persistence-change
schemaVersion: 1
id: 2026-10-21-chat-bridge-source
baseline: false
changes:
  - root: "event:agent/inbox/spliced"
    previous: "2026-10-13-user-rpc-principal"
    after: "e3493f045e3cdaa640ae28695a54ade47dfa5dae2faf9b3dbdac28531d0db1d6"
    decision: same-version
  - root: "event:developer/message"
    previous: "2026-10-13-user-rpc-principal"
    after: "e2f3beac27e403f70de26b5d2310438ab6f3b1e76b9eff9e8ba2292628874da8"
    decision: same-version
  - root: "event:session/title-llm-request"
    previous: "2026-10-13-user-rpc-principal"
    after: "d3a28006e4a2ded271f23250b746abf446daee0c3f8cfb32302b203ec7f9e308"
    decision: same-version
  - root: "event:user/message"
    previous: "2026-10-13-user-rpc-principal"
    after: "b651642d366d8b3af02ce2fa3dea1e63eba2ee49619c52de0f9ed21d4249a646"
    decision: same-version
```

<a id="compatibility"></a>
## Compatibility

Existing records remain valid: no property is added, removed, or retyped on an existing kind. Readers that do not know `chat-bridge` keep the message and its text, and the Web UI renders it through the generic turn-trigger attribution fallback; the stored sender and body stay readable. Producers write the new kind only for a wake delivered by the chat-bridge binder, so no historical event changes meaning.

<a id="verification"></a>
## Verification

pnpm exec vitest run packages/experimental/chat-bridge-binder/tests: 44 tests passed, including the wake framing and source kind assertion. pnpm exec vitest run --coverage --coverage.include=packages/experimental/chat-bridge-binder/src/**: per-file 100% statements, branches, functions, and lines.

<a id="dev-note"></a>
## Dev Note

None.
