# FORK.md — 本仓库相对上游的差异（合并上游前必读）

本仓库是 `https://github.com/deepseek-ai/deepseek-harness` 的 fork，在上游基础上增加了 chat-bridge 绑定、MCP 会话丢失检测和桌面端 HMR 转发。

**合并上游 master 前先读第 2 节，合并后必须执行第 4、5 节**，否则目录/文档 gate 会失败。

差异的权威来源永远是 `git diff master..HEAD`；本文件是给接手者的地图，不是替代品。

---

## 1. 上游与本地的关系

- `upstream` = 官方仓库，`origin` = 本 fork。
- 本地 `master` 只做上游 fast-forward 同步，不承载 fork 改动；fork 改动全部在 `worktree/chat-bridge-binder`（后续可改名为长期分支名）。
- 同步方式：`git fetch upstream && git merge --ff-only upstream/master`（master），再把 master merge-forward 进 fork 分支。

---

## 2. fork 独占改动清单

### 2.1 新包 `packages/experimental/chat-bridge-binder`

把 DSH Session 绑定到 chat-bridge 房间（Host + Client 双面）。上游没有这个包，冲突主要发生在“接线处”：

| 接线点 | 说明 |
|---|---|
| `package.json`（仓库根） | `@deepseek-ai/dsh-experimental-chat-bridge-binder` 的 workspace 依赖 |
| `tsconfig.base.json` | 包的 `paths` 映射 |
| `tsconfig.host.json` / `tsconfig.client.json` | 双面 leaf 配置的引用 |
| `scripts/gen-cordis-catalog.ts` | binder 服务方法的 `typeLinkExemptions`（Binding*/Endpoint*/Resolve*/Leave*/Rejoin* 等类型） |
| `scripts/gen-doc-graphs.ts` | binder 的子系统描述 |
| `scripts/package-dependency-policy.ts` | 分类：`@deepseek-ai/dsh-session` 的 `SessionId`、`@deepseek-ai/dsh-storage-domain` 的 `domainTable` |
| `packages/preset/agent-preset/skills/dsh-doc/references/packages.md` | 包清单条目 |
| `apps/web/src/main.ts` | Client 插件的挂载/注入（与 2.3 的 fetch 转发同一处） |

包内自带 `tsconfig.json` / `tsconfig.host.json` / `tsconfig.client.json`、`tsdown.config.ts`、`locale/{en,zh}.json`、README 三件套和 9 个测试文件；Client UI 使用 CSS anchor positioning（`anchorName` / `positionAnchor` / `@position-try`），上游已删除 `useAnchoredPosition`。

### 2.2 `packages/mcp/mcp-client` 的会话丢失检测

| 文件 | 改动 |
|---|---|
| `src/transport.ts` | `createTransport(config, fetch?, authProvider?, onSessionLost?)`；streamable-http 分支用 `watchingFetch` 监听 `Session not found` |
| `src/generation.ts` | 新增 `sessionLost`，通过 `this.client.close()` 关闭 client |
| `tests/session-loss.spec.ts` | fork 新增 |
| `tests/reconnect.spec.ts`、`generation.spec.ts`、`negotiation-lifecycle.spec.ts`、`protocol.spec.ts` | 适配签名与 mock |
| `README.md` / `README.zh.md` | “Streamable HTTP 重启后会话丢失”段落 |

**合并时的关键约定**：`onSessionLost` 永远放在 `createTransport` 最后一个参数；丢失处理必须走 `this.client.close()`，**不要改回 `this.close()`** —— 后者会 abort generation lifetime，supervisor 会认为是正常取代而不再重连。

### 2.3 桌面端 HMR 事件转发（`apps/web`）

`apps/web/src/main.ts` 在 `__DSH_TRANSPORT__` 上增加 `fetch`，让 client-hmr 在 `dsh-app://` carrier 上用页面 fetch 读取 events 路由（EventSource 无法在该 carrier 上保持流）；对应测试在 `apps/web/tests/desktop-boot.spec.ts`。

### 2.4 持久化格式声明

`docs/persistence-changes/2026-10-21-chat-bridge-source.*`：声明 user/developer message 的 `source` 联合类型新增 `chat-bridge` 取值（`same-version`，旧读者保留消息文本）。

上游每次新增持久化记录后，这条记录会与上游历史分叉，必须 rebase（见第 4 节）。

### 2.5 生成产物与文档

以下文件因 binder 而重新生成，冲突时**不要手改**，一律按第 4 节重新生成：

`docs/capability-seams*`、`docs/config-catalog*`、`docs/event-producer-consumer*`、`docs/persistence-catalog*`、`docs/persistence-schema.json`、`docs/persistence-changes/historical-formats/README*`、`docs/subsystems/{README,schedule}*`、`packages/experimental/README*`、`packages/extensions/cordis-client-runner/src/client/slot-catalog.ts`、`packages/extensions/tool-cordis/src/api-catalog.ts`。

### 2.6 设计记录

`.agents/notes/implemented/feature/2026-10-21-chat-bridge-binder.{md,zh.md,i18n.yaml}` 记录了 binder 的设计决策，合并时保留即可。

---

## 3. 合并上游的推荐顺序

1. `git fetch upstream`
2. 切到 `master`，`git merge --ff-only upstream/master`，`git push origin master`
3. `git checkout worktree/chat-bridge-binder && git merge master`（merge-forward，不要 rebase 已推送的 fork 分支）
4. 按第 4 节重新生成产物，按第 5 节跑 gate
5. 解决冲突时的原则：
   - 生成文件取上游版本后在本地重新生成，不做手工合并
   - `scripts/*` 取上游版本后补回 2.1 表中的 fork 条目
   - `mcp-client` 的 `transport.ts` / `generation.ts` 手工合并，保住后置的 `onSessionLost` 参数
   - `pnpm-lock.yaml` 冲突直接 `pnpm install --no-frozen-lockfile` 重建

---

## 4. 合并后必须重跑的生成器

```sh
pnpm run gen-client-catalog
pnpm run gen-tool-catalog
pnpm run gen-config-catalog
pnpm run gen-persistence-catalog
pnpm run gen-cordis-catalog
pnpm run gen-doc-graphs
pnpm run verify-persistence-formats -- --write
```

持久化历史分叉时（新上游记录出现后）：

```sh
npx tsx scripts/persistence-changes.ts --update 2026-10-21-chat-bridge-source --decision same-version
```

改了 README/文档正文后重算翻译哈希：

```sh
pnpm run verify-translation-pairing -- --write <文件...>
```

首次安装或 lockfile 变动后：`pnpm install --no-frozen-lockfile`。

---

## 5. 验证命令（按成本从低到高）

```sh
npx vitest run packages/experimental/chat-bridge-binder/ packages/mcp/mcp-client/tests/
pnpm run doc-typecheck
pnpm run verify-doc-graphs
pnpm run verify-translation-pairing
pnpm run verify-package-dependencies
pnpm run verify-persistence-changes
pnpm run build:artifacts   # 之后跑 pnpm run build:check
```

`pnpm run doc-sync` 一次跑全部文档 gate；在 Windows 上并发度高时容易 OOM，可设 `DSH_GATE_CONCURRENCY=2` 并单独复跑失败的 gate。

---

## 6. 已知与本 fork 无关的失败

- `verify-package-paths`：上游 upgrade guide 引用了 master 已删除的 `packages/experimental/ptc-runtime-python`（上游自身也失败）。
- `project-doc-site`：Windows 无符号链接权限时报 `EPERM`。
- 本机空闲内存不足（约 8GB 以下）时，`build:artifacts` 的 Host bundle（rolldown/oxc）与 `tsc -b tsconfig.host.json` 可能 OOM 或栈溢出。
