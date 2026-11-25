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
    previous: "2026-11-19-cua-input-notices"
    after: "39ac243031bb9db1fec350ab1195478897d24d96e05178ba9e4b92c9807f3fe3"
    decision: same-version
  - root: "event:developer/message"
    previous: "2026-11-19-cua-input-notices"
    after: "25b6678bf6d613ea82bf389b5d7e2c8ad2e2e3c613a276ffd27cef943f4b4b6a"
    decision: same-version
  - root: "event:session/title-llm-request"
    previous: "2026-11-19-cua-input-notices"
    after: "5f5130b39cf41cbec81f76c8d6a34e983c39141c6ab2cb70918677f99941f348"
    decision: same-version
  - root: "event:user/message"
    previous: "2026-11-19-cua-input-notices"
    after: "ea8eda6e8defc9ef3e14ac0deb68a4fbb94363fa758ce0258810dea3a3217fb3"
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
