---
description: "记录持久化类型更改及其兼容性确认。"
kind: persistence-change
---

# 2026-10-21-chat-bridge-source

[English](2026-10-21-chat-bridge-source.md) | 中文

## 概述

在持久化的 user/developer 消息来源联合类型中加入 chat-bridge 归因种类。

## 目录

- [声明](#declaration)
- [兼容性](#compatibility)
- [验证](#verification)
- [开发备注](#dev-note)

<a id="declaration"></a>
## 声明

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
## 兼容性

已有记录仍然有效：没有为任何既有种类增删属性或改变类型。不认识 `chat-bridge` 的读取方保留该消息及其文本，Web UI 经通用 turn-trigger 归因回退渲染；存储的发送者与正文保持可读。写入方只对 chat-bridge binder 投递的唤醒写入该种类，因此历史事件的含义不变。

<a id="verification"></a>
## 验证

pnpm exec vitest run packages/experimental/chat-bridge-binder/tests：44 个测试通过，包括唤醒框架文本与来源种类的断言。pnpm exec vitest run --coverage --coverage.include=packages/experimental/chat-bridge-binder/src/**：每文件语句、分支、函数与行覆盖率均为 100%。

<a id="dev-note"></a>
## 开发备注

无。
