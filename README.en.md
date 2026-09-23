# Pi Virtual Employee

[简体中文](README.md) | **English**

A desktop **Virtual Employee** application powered by the `Agent` from the [pi agent SDK](https://github.com/earendil-works/pi) (`@earendil-works/pi-agent-core`), running in [Electron](https://www.electronjs.org/) and connected to IM channels such as DingTalk. It gives your team an AI employee that actually gets things done—using the tools at hand before replying, rather than handing the task back to a human.

The interface takes inspiration from [LobsterAI](https://github.com/netease-youdao/LobsterAI). The product centers on **one built-in employee**: a persistent, configurable digital employee that can chat and run scheduled tasks, not a multi-agent orchestration system.

## Features

- **An enterprise-grade bot built around your knowledge base**: Supports both a **built-in knowledge base and external knowledge base integrations**. The built-in knowledge base combines full-text search, vector search, and long-term memory, while external integrations connect to your organization's existing knowledge bases. Answer questions using enterprise knowledge and execute tasks through IM channels such as DingTalk, with role-based access control and confirmation gates for dangerous operations.

- **Conversation engine**: Multi-turn conversations, streaming output, automatic context compaction (threshold-based and manual `/compact`), and a stall watchdog that treats in-flight model calls as active to avoid premature termination.
- **Long-running task safeguards**: Automatically triggers a fallback summary through a separate execution path when a task times out, and proactively reports progress at fixed intervals during long-running tasks to avoid prolonged silence.
- **IM integration**: DingTalk direct and group chats (persistent Stream connections with no public endpoint required; streaming AI card replies, emoji reactions, file transfers, @mentions, and slash command parsing), plus an echo channel for testing.
- **Tools**: A knowledge base with full-text and vector search, including a long-term memory layer; web research; browser automation (complex forms, iframes, and downloads); local files; a document library; controlled command execution (background sessions, allowlists, and double confirmation); and Computer Use for desktop interaction.
- **Scheduled tasks**: Cron scheduling, unattended execution, automatic delivery of results to the originating conversation, and permissions inherited from the task creator.
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
