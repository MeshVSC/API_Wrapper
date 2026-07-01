# Multi-Engine API: Your Subscriptions, One Endpoint

<p align="center">
  <b>Turn the AI subscriptions you already pay for into a single API, with no separate API bills.</b>
</p>

> **Multi-Engine API** puts the AI coding tools you already own behind one standard endpoint. Claude, Gemini, Codex, Qwen, GLM, and Kimi, all reachable from any app, all running on the plans you already have.

[![Node](https://img.shields.io/badge/Node.js-18+-green.svg)](https://nodejs.org)
[![API](https://img.shields.io/badge/API-OpenAI--Compatible-blue.svg)]()
[![Engines](https://img.shields.io/badge/Engines-6-blueviolet.svg)]()
![License](https://img.shields.io/badge/license-Proprietary-red.svg)

---

## The Idea: Pay Once, Use Everywhere

Every AI coding tool ships its own command-line app that runs on your subscription. This server wraps those apps in one standard API, so any program that already knows how to talk to an AI can talk to yours instead. No API keys to buy, no per-use charges, just the plans you already pay for.

### Six Engines, One Connection
- **Claude, Gemini, Codex, Qwen, GLM, Kimi**: all behind the same endpoint.
- **Live Switching**: pick which AI answers from a dashboard, and change it anytime without restarting.
- **Per-Engine Memory**: each engine remembers the last model you chose for it.

### Always Current
- **Automatic Versions**: new versions of a model are picked up on their own, so you never edit the app when a provider ships one.
- **Runtime Discovery**: where an engine can list its own models, brand-new ones appear in the dropdown by themselves.

### Built to Extend
- **One Adapter per Engine**: each engine lives in its own small piece, so a quirk in one never affects the others.
- **Drop-In Growth**: adding a new engine later is a small addition, not a rewrite.

---

## Feature Inventory

### The Dashboard
- **Live Status**: uptime, request count, errors, and last-request time at a glance.
- **Engine and Model Pickers**: switch the active AI and its model from two dropdowns.
- **One-Click Copy**: base URL and API key copy straight to your clipboard.

### The API
- **OpenAI-Compatible**: any app built for the standard chat API works unchanged.
- **Function Calling**: tool-calling apps keep working through a built-in emulation layer.
- **Streaming**: replies can stream token by token or arrive all at once.
- **Secure by Default**: every request needs an API key, so it stays safe wherever it runs.

---

## Getting Started

### Prerequisites
- Node.js 18 or later
- At least one supported CLI installed and logged in: `claude`, `gemini`, `codex`, `qwen`, `zai` (GLM), or `kimi`
- The subscription for whichever engine you want to use

### Launch
1. **Start** the server from the project folder:

```bash
node server.js
```

2. **Open** the dashboard:

```
http://localhost:8787
```

3. **Connect** any app using the base URL and API key shown on the dashboard.
4. **Pick** your engine and model from the dashboard dropdowns.
5. **Send** a request:

```bash
curl http://localhost:8787/v1/chat/completions \
  -H "Authorization: Bearer YOUR_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{ "messages": [{ "role": "user", "content": "Hello" }] }'
```

---

## Configuration
- **`PORT`**: port to listen on (default 8787).
- **`WRAPPER_API_KEY`**: if set, clients must send this key. Leave empty for open localhost use.
- **`WRAPPER_PROVIDER`**: which engine to start on (`claude`, `gemini`, `codex`, `qwen`, `glm`, `kimi`).
- **`WRAPPER_NAME`**: the product name shown on the dashboard.
- **`CLAUDE_BIN`, `GEMINI_BIN`, `CODEX_BIN`, `QWEN_BIN`, `GLM_BIN`, `KIMI_BIN`**: path to each CLI if it is not on your PATH.
- **`CLAUDE_TIMEOUT_MS`**: how long to wait per request in milliseconds (default 180000).

---

## Support & Identity
- **Creator**: Stephane Bessa
- **Studio**: MeshStudios
- **Location**: Barcelona, Spain 2026

**Built with a multi-modal coalition:**
- Claude Code
- ChatGPT
- Qwen

<p align="center">
  <b>One subscription stack. Every app. No extra bills.</b><br>
  Made with care in Barcelona
</p>
