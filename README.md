# Multi-Engine API

Turn your AI subscription into an API you can use without paying separately. Works with Claude, Gemini, Codex, Qwen, GLM, and Kimi, switch between them from a simple dashboard.

## Overview

This is a small local server that puts the AI coding tools you already pay for behind a standard API that any app can connect to. Instead of buying separate API credits, it runs your prompts through the official command-line tools on your existing subscriptions and hands the answers back in the format apps expect.

- **One endpoint, six engines**: Claude, Gemini, Codex, Qwen, GLM (Z.ai), and Kimi, all behind the same API
- **No API keys or credits**: it uses the subscription plans you already have, through their official CLIs
- **Live engine switching**: pick which AI answers from a dashboard, and change it anytime without restarting
- **Automatic model updates**: new model versions are picked up on their own, so you do not edit the app every time a provider ships one
- **Function calling and streaming**: apps that expect tool calls or streamed replies keep working
- **Secure by default**: every request needs an API key, so it stays safe wherever you run it

## Requirements

- Node.js 18 or later
- At least one of the supported CLIs installed and logged in:
  - `claude`, `gemini`, `codex`, `qwen`, `zai` (GLM), or `kimi`
- The subscription for whichever engine you want to use

## Installation

1. Clone or download this repository
2. From the project folder, start the server:

```bash
node server.js
```

3. Open the dashboard in your browser:

```
http://localhost:8787
```

The dashboard shows the server status, your API key, the connection URL, and the dropdowns for choosing the engine and model.

## Usage

Point any app that speaks the standard chat API at the server:

- **Base URL**: `http://localhost:8787/v1`
- **API key**: shown on the dashboard (copy it with the button)
- **Model**: whatever you selected on the dashboard is forced on every request

Example request:

```bash
curl http://localhost:8787/v1/chat/completions \
  -H "Authorization: Bearer YOUR_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "messages": [{ "role": "user", "content": "Hello" }]
  }'
```

### Switching engines

Use the Engine dropdown on the dashboard to switch between Claude, Gemini, Codex, Qwen, GLM, and Kimi. The server re-checks that engine and refreshes its model list. Each engine remembers the last model you picked for it.

## Configuration

Settings are read from environment variables. Copy `.env.example` to `.env` and adjust, or set them inline. Nothing is required to run locally.

- `PORT`: port to listen on (default 8787)
- `WRAPPER_API_KEY`: if set, clients must send this key. Leave empty for open localhost use
- `WRAPPER_PROVIDER`: which engine to start on (`claude`, `gemini`, `codex`, `qwen`, `glm`, `kimi`)
- `WRAPPER_NAME`: the product name shown on the dashboard
- `CLAUDE_BIN`, `GEMINI_BIN`, `CODEX_BIN`, `QWEN_BIN`, `GLM_BIN`, `KIMI_BIN`: path to each CLI if it is not on your PATH
- `CLAUDE_TIMEOUT_MS`: how long to wait per request in milliseconds (default 180000)

## Endpoints

- `GET /`: dashboard
- `GET /health`: quick liveness check
- `GET /status`: live metrics as JSON (shows the key on localhost)
- `POST /provider`: switch the active engine (localhost only)
- `POST /model`: set the forced model (localhost only)
- `POST /models/refresh`: re-check the active engine's model list (localhost only)
- `POST /shutdown`: stop the server (localhost only)
- `GET /v1/models`: lists the current model
- `POST /v1/chat/completions`: the main chat endpoint (streaming and non-streaming)

## Architecture

The server keeps one shared engine and a small adapter per CLI, so adding a new one later is a small drop-in, not a rewrite.

1. **Shared core**: the API layer, authentication, function-calling emulation, streaming, and dashboard are the same for every engine
2. **Provider registry**: each engine has one adapter that knows only its own command-line flags and how to read its output, so a quirk in one never affects another
3. **Model strategy**: engines are selected by tier alias (which the CLI maps to the latest version on its own), and where a CLI can list its models, new ones are discovered at runtime
4. **State**: the active engine and the last-picked model per engine are saved, so your choices survive a restart

## Notes

- The Claude path is a straight continuation of the original working version. The other five adapters follow each CLI's documented behavior and may need small tuning against their real output, GLM and Kimi most likely
- The product name is a placeholder and can be changed with `WRAPPER_NAME`

## License

MIT
