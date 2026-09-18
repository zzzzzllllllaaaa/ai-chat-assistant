# AI Chat Assistant

An [Obsidian](https://obsidian.md) plugin: chat with multiple LLM providers, search your notes with a local knowledge base (RAG), run agents that can read and edit notes, keep long-term memory, and roleplay with character cards.

> **Since v2.0.0 this plugin is free and open source (MIT).** The paid activation system has been removed from the code and all old license keys are void. Users who paid before can open an issue to request a refund.

Author **3zh** ｜ License **MIT** ｜ Repo <https://github.com/zzzzzllllllaaaa/ai-chat-assistant> ｜ [Changelog](CHANGELOG.md)

## Install

**From the community directory (recommended)**

1. Obsidian → Settings → Community plugins → **Browse**
2. Search for **AI Chat Assistant** → **Install** → **Enable**

**Manually, from a GitHub release**

1. Download `main.js`, `manifest.json` and `styles.css` from the [latest release](https://github.com/zzzzzllllllaaaa/ai-chat-assistant/releases/latest)
2. Copy them into `<your vault>/.obsidian/plugins/ai-chat-assistant/`
3. Restart Obsidian → Settings → Community plugins → enable **AI Chat Assistant**

Requires Obsidian **1.7.2+**. Runs on desktop and mobile.

## Getting started

1. **Settings → AI Chat Assistant → Models** → add a connection (name / base URL / API key) → test it → fetch the model list.
2. **Bind models per purpose** — chat, agent and embedding are configured separately (the knowledge base needs a working embedding model).
3. **For retrieval**, run `Update knowledge base index (incremental)` from the command palette.

With Ollama you can point the base URL at your local server and leave the API key empty to run fully offline.

## Features

- **Multi-provider chat** — OpenAI, Claude, Gemini, DashScope (Qwen), DeepSeek or any OpenAI-compatible endpoint; local models through Ollama; streaming output; per-purpose model binding (chat / agent / embedding).
- **Knowledge base (RAG)** — hybrid search (vector similarity + keywords + recency) fused with RRF, query rewriting and reranking, graph-aware retrieval that follows your note links, vectors stored in IndexedDB with a Web Worker so the UI stays responsive.
- **Agents** — tool calling (read and write notes, create folders, full-text search, web search…), multi-step task execution with progress summaries, and permission prompts before a tool changes anything.
- **Memory and roleplay** — long-term memory, character cards (SillyTavern-compatible), multi-character group chat, writing styles.
- **MCP tools** — connect standard MCP servers over HTTP / SSE.
- **Inline AI** — rewrite or continue a selection from the editor.

## Privacy and data

- **No telemetry** — the plugin contains no analytics or data collection code.
- **Network use** is limited to the endpoints you configure: LLM providers, MCP servers, web search, and the optional remote skill/service APIs.
- Chat content and notes are only sent to the model provider you configure. With a local model and the local vector store, the plugin can run fully offline.

Disclosure, so that nothing surprises you:

- **Files outside the vault** — the agent's note tools use the Obsidian vault API, but some features (skill installers, importing/exporting packages, the built-in HTTP API server) use Node's `fs` and can read or write paths outside your vault. Nothing is touched unless you trigger those features.
- **Shell execution** — certain skill features can run the scripts shipped inside a skill you installed, through `child_process`. Tool calls are gated behind permission prompts, but installing an untrusted skill is still equivalent to running its code.
- **Clipboard** — used for the copy/paste actions in chat.
- **Dynamic code in skills** — installed skills may be executed as scripts. Only install skills you trust.

## Known limitations

- **DeepSeek prompt caching is not properly optimised** — the prompt prefix is not stable, so the cache benefit is much lower than expected.
- **Skills and MCP are early work** — MCP supports HTTP/SSE only (no stdio) and has not been exercised against many real-world servers.
- **Large files, real debt** — `main.ts` and `src/ui/views/view.ts` are several thousand lines each; the split is unfinished.
- **No automated tests** — changes are verified by hand.
- **The built-in HTTP API server has no authentication** (off by default, meant for localhost only — do not expose it to the internet).
- **Mobile is supported but slow** — indexing and retrieval on a large vault are not great.

## License

[MIT](LICENSE). Source code is public; releases carry the built artifacts.

Bug reports and ideas: GitHub Issues. This is a personal project and I make no promise about a maintenance schedule.
