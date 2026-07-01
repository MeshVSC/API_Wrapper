# Multi-Engine API: Your Subscriptions, One Endpoint

<p align="center">
  <img src="https://raw.githubusercontent.com/MeshVSC/API_Wrapper/main/Assets/hero_banner.png" alt="Multi-Engine API Banner" width="100%">
</p>

> **Multi-Engine API** turns the AI coding subscriptions you already pay for into one standard endpoint any app can use. Claude, Gemini, Codex, Qwen, GLM, and Kimi, reachable from anything that speaks the common chat API, with no keys to buy and no per-use bills.

[![Node](https://img.shields.io/badge/Node.js-18+-green.svg)](https://nodejs.org)
[![API](https://img.shields.io/badge/API-OpenAI--Compatible-blue.svg)]()
[![Engines](https://img.shields.io/badge/Engines-6-blueviolet.svg)]()
![License](https://img.shields.io/badge/license-Proprietary-red.svg)

---

## The Vision: One Stack, Every App

Every AI coding tool ships its own command-line app that runs on your subscription. This server wraps those apps in one standard endpoint, so any program that already knows how to talk to an AI talks to yours instead. No API keys to buy, no per-use charges, just the plans you already pay for, unified behind a single connection.

### Six Engines, One Connection
- **Unified Endpoint**: Claude, Gemini, Codex, Qwen, GLM, and Kimi all answer at the same address.
- **Live Switching**: pick which AI answers from a dashboard, and change it anytime without a restart.
- **Per-Engine Memory**: each engine remembers the last model you chose for it.

### Always Current
- **Automatic Versions**: new versions of a model are picked up on their own, so you never touch the app when a provider ships one.
- **Runtime Discovery**: where an engine can list its own models, brand-new ones appear in the dropdown by themselves.

### Built to Extend
- **One Adapter per Engine**: each engine lives in its own small piece, so a quirk in one never affects another.
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
- **Streaming**: replies stream token by token or arrive all at once.
- **Secure by Default**: every request needs an API key, so it stays safe wherever it runs.

---

## Experience It

### Prerequisites
- Node.js 18 or later
- At least one supported CLI installed and logged in: `claude`, `gemini`, `codex`, `qwen`, `zai` (GLM), or `kimi`
- The subscription for whichever engine you want to use

### Getting Started
1. **Launch**: start the server from the project folder with `node server.js`.
2. **Open**: visit the dashboard at `http://localhost:8787`.
3. **Connect**: point any app at the base URL and API key shown on the dashboard.
4. **Choose**: pick your engine and model from the dashboard dropdowns.
5. **Send**: fire a request and get the answer back in the standard shape.

```bash
curl http://localhost:8787/v1/chat/completions \
  -H "Authorization: Bearer YOUR_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{ "messages": [{ "role": "user", "content": "Hello" }] }'
```

### Configuration
- **`PORT`**: port to listen on (default 8787).
- **`WRAPPER_API_KEY`**: if set, clients must send this key. Leave empty for open localhost use.
- **`WRAPPER_PROVIDER`**: which engine to start on (`claude`, `gemini`, `codex`, `qwen`, `glm`, `kimi`).
- **`WRAPPER_NAME`**: the product name shown on the dashboard.
- **`CLAUDE_BIN`, `GEMINI_BIN`, `CODEX_BIN`, `QWEN_BIN`, `GLM_BIN`, `KIMI_BIN`**: path to each CLI if it is not on your PATH.
- **`CLAUDE_TIMEOUT_MS`**: how long to wait per request in milliseconds (default 180000).

---

## Trust by Design
- **Your Plans, Your Machine**: it runs on the subscriptions you already own, through their official CLIs, on your own computer.
- **No Credit Drain**: nothing here spends API credits, so there is no metered bill behind your requests.
- **Key-Gated**: every request is authenticated, so the endpoint is safe to run wherever you need it.
- **Isolated Engines**: one engine's quirks stay contained in its own adapter and never leak into the rest.

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
