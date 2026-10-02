# Pi Virtual Employee

[简体中文](README.md) | **English**

A desktop **Virtual Employee** application powered by the `Agent` from the [pi agent SDK](https://github.com/earendil-works/pi) (`@earendil-works/pi-agent-core`), running in [Electron](https://www.electronjs.org/) and connected to IM channels such as DingTalk. It gives your team an AI employee that actually gets things done—using the tools at hand before replying, rather than handing the task back to a human.

The interface takes inspiration from [LobsterAI](https://github.com/netease-youdao/LobsterAI). The product centers on **one built-in employee**: a persistent, configurable digital employee that can chat and run scheduled tasks, not a multi-agent orchestration system.

**How it differs from process-broadcast bots like Hermes**: Hermes replies to the group with the raw result of every single tool call, so one long task easily spams dozens of messages. The virtual employee is **result-oriented** — once it accepts a task it executes silently and replies only with the final result, reporting task progress at a configurable fixed interval for long-running work, without flooding the channel with intermediate details.

**How it differs from LobsterAI (龙虾)**: LobsterAI has no self-evolution loop, and its dream-style memory consolidation generalizes memories at the cost of fine-grained data — once a memory is summarized, part of its precision is gone. The virtual employee closes both gaps: a **self-evolution loop** (runtime telemetry → failure clustering → improvement proposals → prompt self-evaluation `prompt_lab`, where critical red-line failures veto acceptance), and knowledge consolidation that **preserves key values verbatim** — merged-away originals are only archived, never deleted, and restorable anytime, so generalization never costs precision.

**Group-tiered permissions and a native knowledge base, both built in**: the virtual employee ships a **role-tiered permission system that works inside group chats** — platform-verified member identities map to viewer / operator / admin roles, governing command execution, capability toggles, and dangerous-operation confirmations consistently across direct and group chats, instead of treating everyone in the group alike. The knowledge base is **native too** (full-text + vector search with a long-term memory layer; external integrations supported) — no third-party KB product required.

## Features

- **An enterprise-grade bot built around your knowledge base**: Supports both a **built-in knowledge base and external knowledge base integrations**. The built-in knowledge base combines full-text search, vector search, and long-term memory, while external integrations connect to your organization's existing knowledge bases. Answer questions using enterprise knowledge and execute tasks through IM channels such as DingTalk, with role-based access control and confirmation gates for dangerous operations.

- **Conversation engine**: Multi-turn conversations, streaming output, automatic context compaction (threshold-based and manual `/compact`), and a stall watchdog that treats in-flight model calls as active to avoid premature termination.
- **Long-running task safeguards**: Automatically triggers a fallback summary through a separate execution path when a task times out, and proactively reports progress at fixed intervals during long-running tasks to avoid prolonged silence.
- **IM integration**: DingTalk direct and group chats (persistent Stream connections with no public endpoint required; streaming AI card replies, emoji reactions, file transfers, @mentions, and slash command parsing), plus an echo channel for testing.
- **Tools**: A knowledge base with full-text and vector search, including a long-term memory layer; web research; browser automation (complex forms, iframes, and downloads); local files; a document library; controlled command execution (background sessions, allowlists, and double confirmation); Computer Use for desktop interaction; and **MCP external tools** (a native MCP connector: standard mcpServers config, stdio / streamable HTTP, tools bridged as `mcp__server__tool` under the same role gating).
- **Scheduled tasks**: Cron scheduling, unattended execution, automatic delivery of results to the originating conversation, and permissions inherited from the task creator.
- **Autonomous work items**: Discover ongoing goals from conversations → propose → get admin confirmation; persist conditions, progress and lessons, choose follow-up times based on real dependencies, and ask humans when resources or coordination are needed.
- **Report publishing**: Save task outputs as HTML and publish them as locally accessible links, with automatic chunking for long reports sent through IM.
- **Permissions and security**: Three roles based on platform-verified identities (viewer / operator / admin), conversation-level capability requirements, confirmation gates for dangerous operations, and prompt-injection defenses that treat page and file content as data rather than instructions.
- **Self-maintenance**: Automatic application updates (a standalone watchdog installer and a version circuit breaker), runtime telemetry, failure clustering, an improvement proposal loop, and prompt self-evaluation (`prompt_lab`, where any critical safety test failure blocks acceptance).
- **Console GUI**: Chat, conversation management, visual configuration for models, IM, capabilities, and permissions, plus isolated profiles (`--profile`).

## Quick Start

Requirements: Node.js 20+ and npm.

```bash
# 1) Install dependencies (skip install scripts for better-sqlite3;
#    rebuild it for the Electron ABI later)
npm install --ignore-scripts

# 2) Electron binaries use the npmmirror mirror (ELECTRON_MIRROR is configured in .npmrc).
#    If the automatic download is incomplete, download manually:
#    The following fallback commands target macOS on Apple Silicon.
VER=$(node -p "require('./node_modules/electron/package.json').version")
cd node_modules/electron && rm -rf dist
curl -L -o /tmp/electron.zip "https://cdn.npmmirror.com/binaries/electron/${VER}/electron-v${VER}-darwin-arm64.zip"
unzip -q /tmp/electron.zip -d dist
printf 'Electron.app/Contents/MacOS/Electron' > path.txt
cd -

# 3) Rebuild better-sqlite3 for the Electron ABI
npx electron-rebuild -f -w better-sqlite3

# 4) Start development mode (HMR + Electron)
npm run dev

# Production build
npm run build
```

## Configuration

All configuration is stored in SQLite. You can edit it in **Settings**, or an administrator can configure it conversationally with `manage_settings` in an IM direct chat:

| Setting | Description |
| --- | --- |
| Model | provider / modelId / API key / contextWindow; also supports the `ANTHROPIC_API_KEY` and `OPENAI_API_KEY` environment variables |
| IM | DingTalk: create an internal application → obtain its AppKey/AppSecret → add bot capabilities and select Stream mode → enter the credentials in Settings and enable the integration |
| Employee persona | Name / role / responsibilities / service hours / reply language; built-in safety and data-integrity rules remain active and cannot be disabled by custom rules |
| Capability toggles | Enable or disable the knowledge base, web access, browser, files, reports, command execution, Computer Use, and other capabilities individually |
| Employee permissions | Use `manage_access` in an IM direct chat to maintain user roles and conversation-level access requirements |

### IM Commands

@mention the bot in a group chat, or send commands directly in a direct chat: `/new` starts a new conversation, `/compact` compacts context, `/stop` stops the current task, `/model` switches models, and `/perm` shows permissions. Create scheduled tasks in natural language (for example, “Every day at 9 AM, …”). They run automatically and deliver results back to the originating conversation.

### Autonomous Work: Propose First, Confirm Before Execution

A work item is a **persistent goal, not a cron job**. An admin can request “Find work you could own” (`manage_work_items action=mine`) in the source direct/group chat. On-demand mining defaults to a bounded **24-hour** lookback in that conversation. Proposals include ID, title, goal, full conditions and quoted message provenance. They are persisted as `proposed`, **never started automatically**. Reply “确认创建 <id/title>” in the same source chat to start; the admin may also rewrite the proposal's title/goal/conditions as part of confirming (`action=confirm` with `title/goal/conditions`) instead of accepting it verbatim. Use `action=list/get` to inspect status and notes. Failed delivery leaves the proposal accessible; it must not be described as delivered.

Background mining is **disabled by default**. In an **IM direct chat**, an admin can use `manage_settings` with explicit “确认” in the current message:

- Enable: `action=set path=capabilities.autonomousMining.enabled value=true`; disable with `false`.
- Interval: `action=set path=capabilities.autonomousMining.intervalHours value=4` (default **4 hours**, range **1–24**; the background loop checks hourly, not at an exact deadline).

Each source has its own model call and durable SQLite cursor. No combined cross-chat digests, foreign task titles or KB content are supplied; private-chat proposals are not copied into groups. History is **untrusted data**, never an instruction override. Source IDs and verbatim message evidence are validated, and sensitive messages are filtered. Excerpts go to the configured model provider: check your organization's data policy first.

During execution, `manage_work` persists conditions, progress and lessons. Follow-up intervals depend on output availability and dependencies rather than fixed high-frequency polling. The first execution window drafts a short follow-up plan (steps, when/why each step checks in, and prerequisites) before acting — the rhythm is need-based, not a fixed daily slot. An admin can adjust a live item at any time: `action=update` rewrites title/goal/conditions (even mid-window) or reschedules the next follow-up (minimum 15 minutes; not while a window is executing), and `action=pause` stops the current window promptly and waits for explicit resumption. Long-lived goals continue across windows until explicitly completed. **Conditions are prompt guidance, not hard time locks or business-rule validators.** Human resources, permissions or cross-unit coordination require pausing for an admin; reply “确认继续 <id/title>” with an answer in the source chat to resume. Reusable non-sensitive lessons may be saved to the KB under existing permissions; private information must not be shared.

Limits: up to 12 sources per pass, 25 messages per source (user excerpts capped at 1,000 characters), 5 proposals, 3 minutes overall and 60 seconds per source model call. Automatic mining continues from the last successful page, initially looking back 24 hours; manual scans do not advance automatic cursors. Truncation and strict evidence checks can miss candidates, so this is not a complete audit. A push timeout means delivery is unknown, not that an execution task was automatically created.

## Architecture

```text
electron/            Main process (windows / IPC / update watchdog) + preload
src/
├─ engine/           Employee engine: Agent core + conversation management + prompt assembly + tools/
├─ im/               IMAdapter abstraction + DingTalk adapter (Stream / AI cards / files) + command parsing + watchdog
├─ scheduler/        Task scheduling + unattended execution + permission inheritance
├─ knowledge/        Knowledge base (sqlite-vec vector search + memory layer)
├─ security/         RBAC: three roles + conversation-level access requirements + capability table
├─ reports/          Report generation and publishing service
├─ computer/         Cua Driver installation and desktop session management
├─ transport/        HTTP+SSE (the renderer consumes streams over localhost)
└─ db/               better-sqlite3: config / conversations / telemetry
renderer/src/        React + Vite + Tailwind console
```

## Tests and Guardrails

```bash
npm run test:all           # All test suites (prompt safety rules / permission model / watchdog / compaction / chunking / …)
npm run verify:immutable   # Immutable core tripwires: hash checks for safety rules, permission checks, update circuit breakers, etc.
```

`docs/immutable.manifest.json` pins the SHA-256 hashes of critical guardrail regions. Changes to these regions require explicit acknowledgment with `IMMUTABLE_ACK="<reason>"`, ensuring that guardrail changes **cannot go unnoticed**.

## Packaging and Releases

Windows (NSIS) installers and automatic update files are uploaded to the Gitee repository's release tagged `latest` for faster downloads in China. Installed clients check for updates automatically through electron-updater. **The same version is also published to GitHub Releases with installers for both Windows and macOS (Apple Silicon).** Linux (AppImage) builds are supported locally.

```bash
cp .env.example .env       # Set GITEE_TOKEN (requires projects permission)
npm run package:win        # Windows installer (typecheck + build + native binaries + electron-builder)
npm run package:mac        # macOS DMG (Apple Silicon, unsigned)
npm run release            # Runs immutable checks and all tests before uploading to both Gitee and GitHub
```

The macOS build is not signed or notarized. On first launch, **right-click the app → Open** to open it through Gatekeeper. The `gh` CLI must already be authenticated, as it handles GitHub uploads.

Native modules (better-sqlite3 + sqlite-vec) are precompiled for the target platform and bundled in the installer (`resources/native/`), so the packaging machine does not need the target platform's build toolchain.

## License

[Apache-2.0](LICENSE)
