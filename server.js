#!/usr/bin/env node
'use strict';

/*
 * OpenAI-compatible HTTP wrapper around the official Claude Code CLI.
 * Each chat request becomes a `claude -p ... --output-format json` call, so the
 * answer is produced by Claude Code under your logged-in subscription, then
 * mapped back into the OpenAI Chat Completions shape.
 *
 * Endpoints:
 *   GET  /                     status dashboard (HTML)
 *   GET  /health               liveness check
 *   GET  /status               live metrics (JSON; reveals the key on localhost)
 *   POST /model                set the model the server forces (localhost only)
 *   POST /shutdown             stops the server (localhost only)
 *   GET  /v1/models            lists the single virtual model
 *   POST /v1/chat/completions  main chat endpoint (stream + non-stream)
 */

const http = require('http');
const os = require('os');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');

const PORT = parseInt(process.env.PORT || '8787', 10);
// Kept as the legacy name; the registry below reads it for the claude adapter.
const CLAUDE_BIN = process.env.CLAUDE_BIN || 'claude';
const CLAUDE_TIMEOUT_MS = parseInt(process.env.CLAUDE_TIMEOUT_MS || '180000', 10);
const PROVIDER_TIMEOUT_MS = CLAUDE_TIMEOUT_MS;
// Product name shown in the dashboard (tab title, eyebrow, hero). Single source —
// change WRAPPER_NAME (or this default) once and every label follows.
const PRODUCT_NAME = process.env.WRAPPER_NAME || 'Multi-Engine API';

const CLAUDE_WORKDIR = process.env.CLAUDE_WORKDIR || fs.mkdtempSync(path.join(os.tmpdir(), 'cc-wrapper-'));
const DASHBOARD_FILE = path.join(__dirname, 'public', 'index.html');

// Config + key live in the user's home so they're stable and never blocked.
const CONFIG_DIR = path.join(os.homedir(), '.claude-code-api-wrapper');
function ensureConfigDir() { try { fs.mkdirSync(CONFIG_DIR, { recursive: true }); } catch (e) {} }

function loadOrCreateKey() {
  if (process.env.WRAPPER_API_KEY) return process.env.WRAPPER_API_KEY;
  ensureConfigDir();
  const f = path.join(CONFIG_DIR, 'api-key');
  try { const k = fs.readFileSync(f, 'utf8').trim(); if (k) return k; } catch (e) {}
  const key = 'ck-' + crypto.randomBytes(24).toString('hex');
  try { fs.writeFileSync(f, key, { mode: 0o600 }); } catch (e) {}
  return key;
}
const API_KEY = loadOrCreateKey();

// --- provider registry ---------------------------------------------------
// One adapter per CLI. Every adapter is the ONLY place that knows that CLI's
// flags and output shape, so a quirk in one provider never leaks into another.
// Each adapter exposes:
//   bin          the executable name (env-overridable)
//   loginHint    what the user runs if the binary isn't logged in
//   aliases      tier list {id,label,version}. id is the alias passed to --model
//                (the CLI maps it to the latest version of that tier, so version
//                churn needs no edit here); version is the concrete id shown until
//                a real response reports the exact one that ran.
//   buildArgs({system,prompt,model})  -> argv for a one-shot headless run
//   parse(stdout)                     -> { text, usage:{input_tokens,output_tokens}, model }
//   listModels()                      -> argv for a non-interactive model list, or null
//   parseModels(stdout)               -> [ids] discovered at runtime, or []
// usage is best-effort: 0 when a CLI doesn't report tokens.

// Fold a system prompt into the user prompt for CLIs that lack a system-prompt flag.
function foldSystem(system, prompt) { return system ? `${system}\n\n${prompt}` : prompt; }
// Map a "usage-like" object from various CLIs into our shape.
function usageOf(input, output) { return { input_tokens: input || 0, output_tokens: output || 0 }; }
// Pull the largest-output model id out of a Claude-style modelUsage map.
function modelFromModelUsage(usage, tier) {
  const ids = Object.keys(usage || {});
  if (!ids.length) return null;
  const match = tier && ids.find((id) => id.includes(tier));
  if (match) return match;
  return ids.sort((a, b) => (usage[b].outputTokens || 0) - (usage[a].outputTokens || 0))[0];
}

const PROVIDERS = {
  claude: {
    label: 'Claude',
    bin: process.env.CLAUDE_BIN || 'claude',
    loginHint: 'claude login',
    aliases: [
      { id: 'fable', label: 'Fable', version: 'claude-fable-5' },
      { id: 'opus', label: 'Opus', version: 'claude-opus-4-8' },
      { id: 'sonnet', label: 'Sonnet', version: 'claude-sonnet-4-6' },
      { id: 'haiku', label: 'Haiku', version: 'claude-haiku-4-5-20251001' },
    ],
    buildArgs({ system, prompt, model }) {
      const args = ['-p', prompt, '--output-format', 'json', '--no-session-persistence',
        '--tools', '', '--strict-mcp-config', '--setting-sources', ''];
      if (system) args.push('--system-prompt', system);
      if (model) args.push('--model', model);
      return args;
    },
    parse(stdout, model) {
      const parsed = JSON.parse(stdout.trim());
      if (parsed.is_error) throw new Error(`claude reported an error: ${parsed.result || parsed.subtype || 'unknown'}`);
      const raw = modelFromModelUsage(parsed.modelUsage, model);
      return {
        text: typeof parsed.result === 'string' ? parsed.result : '',
        usage: usageOf(parsed.usage && parsed.usage.input_tokens, parsed.usage && parsed.usage.output_tokens),
        model: raw ? raw.replace(/\[.*\]$/, '') : null,
      };
    },
    listModels: () => null,
    parseModels: () => [],
  },

  gemini: {
    label: 'Gemini',
    bin: process.env.GEMINI_BIN || 'gemini',
    loginHint: 'gemini (then sign in)',
    aliases: [
      { id: 'auto', label: 'Auto', version: 'gemini-auto' },
      { id: 'gemini-2.5-pro', label: 'Pro', version: 'gemini-2.5-pro' },
      { id: 'gemini-2.5-flash', label: 'Flash', version: 'gemini-2.5-flash' },
    ],
    buildArgs({ system, prompt, model }) {
      const args = ['-p', foldSystem(system, prompt), '--output-format', 'json'];
      if (model && model !== 'auto') args.push('--model', model);
      return args;
    },
    parse(stdout) {
      const parsed = JSON.parse(stdout.trim());
      const stats = parsed.stats || {};
      const tok = stats.tokens || stats.usage || {};
      return {
        text: typeof parsed.response === 'string' ? parsed.response : '',
        usage: usageOf(tok.input || tok.prompt || tok.input_tokens, tok.output || tok.candidates || tok.output_tokens),
        model: (stats.models && Object.keys(stats.models)[0]) || null,
      };
    },
    listModels: () => null,
    parseModels: () => [],
  },

  codex: {
    label: 'Codex',
    bin: process.env.CODEX_BIN || 'codex',
    loginHint: 'codex login',
    aliases: [
      { id: 'gpt-5-codex', label: 'GPT-5 Codex', version: 'gpt-5-codex' },
      { id: 'gpt-5-codex-mini', label: 'Codex Mini', version: 'gpt-5-codex-mini' },
    ],
    buildArgs({ system, prompt, model }) {
      // exec = non-interactive; read-only sandbox so Codex never touches the disk.
      const args = ['exec', foldSystem(system, prompt), '--json', '--sandbox', 'read-only'];
      if (model) args.push('--model', model);
      return args;
    },
    parse(stdout) {
      // Codex emits newline-delimited JSON events; the answer is the last event
      // carrying assistant text. Scan lines from the end for the final message.
      const lines = stdout.split('\n').map((l) => l.trim()).filter(Boolean);
      let text = '', inTok = 0, outTok = 0;
      for (const line of lines) {
        let ev; try { ev = JSON.parse(line); } catch { continue; }
        const msg = ev.message || (ev.item && ev.item.text) || ev.text || (ev.delta && ev.delta.text);
        const role = ev.role || (ev.item && ev.item.role);
        if (msg && (role === 'assistant' || ev.type === 'item.completed' || ev.type === 'message')) text = msg;
        const u = ev.usage || (ev.item && ev.item.usage);
        if (u) { inTok = u.input_tokens || u.input || inTok; outTok = u.output_tokens || u.output || outTok; }
      }
      // Fallback: if no structured assistant message was found, use raw stdout.
      if (!text) text = stdout.trim();
      return { text, usage: usageOf(inTok, outTok), model: null };
    },
    listModels: () => ['prompt', '--models'],
    parseModels(stdout) {
      // Best-effort: take token-like ids from the catalog dump.
      try { const j = JSON.parse(stdout); if (Array.isArray(j)) return j.map((m) => m.id || m).filter(Boolean); } catch {}
      return stdout.split('\n').map((l) => l.trim()).filter((l) => /^[\w.-]+$/.test(l));
    },
  },

  qwen: {
    label: 'Qwen',
    bin: process.env.QWEN_BIN || 'qwen',
    loginHint: 'qwen (then sign in)',
    aliases: [
      { id: 'qwen3-coder-plus', label: 'Coder Plus', version: 'qwen3-coder-plus' },
      { id: 'qwen3-coder-flash', label: 'Coder Flash', version: 'qwen3-coder-flash' },
    ],
    buildArgs({ system, prompt, model }) {
      // Qwen Code is a Gemini-CLI fork: same -p / --output-format json, plus --system-prompt.
      const args = ['-p', prompt, '--output-format', 'json'];
      if (system) args.push('--system-prompt', system);
      if (model) args.push('--model', model);
      return args;
    },
    parse(stdout) {
      const parsed = JSON.parse(stdout.trim());
      const stats = parsed.stats || {};
      const tok = stats.tokens || stats.usage || {};
      return {
        text: typeof parsed.response === 'string' ? parsed.response : (typeof parsed.result === 'string' ? parsed.result : ''),
        usage: usageOf(tok.input || tok.prompt || tok.input_tokens, tok.output || tok.output_tokens),
        model: (stats.models && Object.keys(stats.models)[0]) || null,
      };
    },
    listModels: () => null,
    parseModels: () => [],
  },

  glm: {
    label: 'GLM',
    bin: process.env.GLM_BIN || process.env.ZAI_BIN || 'zai',
    loginHint: 'zai (configure API/login)',
    aliases: [
      { id: 'glm-4.6', label: 'GLM 4.6', version: 'glm-4.6' },
      { id: 'glm-4.5-air', label: 'GLM Air', version: 'glm-4.5-air' },
    ],
    buildArgs({ system, prompt, model }) {
      const args = ['-p', foldSystem(system, prompt), '--no-color'];
      if (model) args.push('--model', model);
      return args;
    },
    parse(stdout) {
      // JSON if the CLI gives it; otherwise the plain text it printed.
      const trimmed = stdout.trim();
      try {
        const j = JSON.parse(trimmed);
        const text = j.response || j.result || j.text || j.content || '';
        const u = j.usage || {};
        return { text: typeof text === 'string' ? text : trimmed, usage: usageOf(u.input_tokens, u.output_tokens), model: j.model || null };
      } catch {
        return { text: trimmed, usage: usageOf(), model: null };
      }
    },
    listModels: () => null,
    parseModels: () => [],
  },

  kimi: {
    label: 'Kimi',
    bin: process.env.KIMI_BIN || 'kimi',
    loginHint: 'kimi login',
    aliases: [
      { id: 'kimi-k2', label: 'K2', version: 'kimi-k2' },
      { id: 'kimi-k2-turbo', label: 'K2 Turbo', version: 'kimi-k2-turbo' },
    ],
    buildArgs({ system, prompt, model }) {
      const args = ['--prompt', foldSystem(system, prompt)];
      if (model) args.push('--model', model);
      return args;
    },
    parse(stdout) {
      // Output is transcript-style: lines prefixed with bullets. Try JSON first,
      // else strip the bullet/indent decoration and keep the assistant text.
      const trimmed = stdout.trim();
      try {
        const j = JSON.parse(trimmed);
        const text = j.response || j.result || j.text || j.content || '';
        if (text) return { text, usage: usageOf(), model: j.model || null };
      } catch {}
      const cleaned = trimmed
        .split('\n')
        .map((l) => l.replace(/^\s*[•·*-]\s?/, '').replace(/^\s{2}/, ''))
        .join('\n')
        .trim();
      return { text: cleaned, usage: usageOf(), model: null };
    },
    listModels: () => null,
    parseModels: () => [],
  },
};
const PROVIDER_IDS = Object.keys(PROVIDERS);

// --- active provider + per-provider model selection ----------------------
// activeProvider is persisted; selectedModel is a per-provider map so switching
// providers restores that provider's last tier instead of breaking on a foreign id.
const PROVIDER_FILE = path.join(CONFIG_DIR, 'selected-provider');
const SELECTED_FILE = path.join(CONFIG_DIR, 'selected-models');

function loadActiveProvider() {
  if (process.env.WRAPPER_PROVIDER && PROVIDER_IDS.includes(process.env.WRAPPER_PROVIDER)) return process.env.WRAPPER_PROVIDER;
  try { const p = fs.readFileSync(PROVIDER_FILE, 'utf8').trim(); if (PROVIDER_IDS.includes(p)) return p; } catch (e) {}
  return 'claude';
}
function saveActiveProvider() { try { ensureConfigDir(); fs.writeFileSync(PROVIDER_FILE, activeProvider); } catch (e) {} }

function loadSelectedMap() { try { const m = JSON.parse(fs.readFileSync(SELECTED_FILE, 'utf8')); return m && typeof m === 'object' ? m : {}; } catch (e) { return {}; } }
function saveSelectedMap() { try { ensureConfigDir(); fs.writeFileSync(SELECTED_FILE, JSON.stringify(selectedModels)); } catch (e) {} }

let activeProvider = loadActiveProvider();
let selectedModels = loadSelectedMap();

function provider() { return PROVIDERS[activeProvider]; }
// Discovered model ids per provider (layer 2), merged with aliases for the UI.
const discoveredModels = {}; // { providerId: [ids] }

function availableModels() {
  const p = provider();
  const aliasItems = p.aliases.slice();
  const known = new Set(aliasItems.map((m) => m.id));
  for (const id of (discoveredModels[activeProvider] || [])) {
    if (!known.has(id)) { aliasItems.push({ id, label: id, version: id }); known.add(id); }
  }
  return aliasItems;
}
function modelIds() { return availableModels().map((m) => m.id); }
function defaultModelId() { return provider().aliases[0].id; }
function selectedModelId() {
  const m = selectedModels[activeProvider];
  return (m && modelIds().includes(m)) ? m : defaultModelId();
}
function setSelectedModel(id) { selectedModels[activeProvider] = id; saveSelectedMap(); }

// The concrete id reported by the most recent request — overrides the alias version.
let detectedModel = null;
function selectedVersion() { const m = availableModels().find((x) => x.id === selectedModelId()); return m ? m.version : selectedModelId(); }
function effectiveModel() { return detectedModel || selectedVersion(); }

// --- live metrics --------------------------------------------------------

const STARTED_AT = Date.now();
const metrics = { requests: 0, errors: 0, lastRequestAt: null, lastError: null };
// Reflects the ACTIVE provider's binary, refreshed on startup and on switch.
const engineInfo = { available: false, version: null };

// Run a short-lived CLI command and resolve its stdout (or null on failure).
function runCmd(bin, args, timeoutMs = 15000) {
  return new Promise((resolve) => {
    let out = '', done = false;
    let child;
    try { child = spawn(bin, args, { env: process.env }); }
    catch (e) { resolve(null); return; }
    const timer = setTimeout(() => { if (done) return; done = true; try { child.kill('SIGKILL'); } catch {} resolve(null); }, timeoutMs);
    child.stdout.on('data', (d) => { out += d; });
    child.on('error', () => { if (done) return; done = true; clearTimeout(timer); resolve(null); });
    child.on('close', (code) => { if (done) return; done = true; clearTimeout(timer); resolve(code === 0 ? out : null); });
  });
}

// Version-probe the active provider's binary, then refresh its discovered models.
async function probeProvider() {
  const p = provider();
  engineInfo.available = false; engineInfo.version = null;
  const out = await runCmd(p.bin, ['--version']);
  if (out !== null) { engineInfo.available = true; engineInfo.version = out.trim(); }
  await refreshModels();
}

// Layer-2 model discovery: ask the active CLI for its catalog if it supports one.
async function refreshModels() {
  const p = provider();
  const listArgs = p.listModels && p.listModels();
  if (!listArgs) return;
  const out = await runCmd(p.bin, listArgs);
  if (out === null) return;
  try { const ids = p.parseModels(out) || []; if (ids.length) discoveredModels[activeProvider] = ids; } catch (e) {}
}

// --- helpers -------------------------------------------------------------

// Diagnostic log — writes full request/prompt/reply to a file so the real
// framework traffic can be inspected. Path: ~/.claude-code-api-wrapper/debug.log
const DEBUG_LOG = path.join(CONFIG_DIR, 'debug.log');
function debugLog(label, data) {
  try {
    ensureConfigDir();
    const line = `\n===== ${label} @ ${new Date().toISOString()} =====\n` + JSON.stringify(data, null, 2) + '\n';
    fs.appendFileSync(DEBUG_LOG, line);
  } catch (e) { /* never let logging break a request */ }
}

function sendJSON(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) });
  res.end(body);
}
function sendError(res, status, message, type = 'invalid_request_error') { sendJSON(res, status, { error: { message, type } }); }

function isLocal(req) {
  const a = req.socket.remoteAddress || '';
  return a === '127.0.0.1' || a === '::1' || a === '::ffff:127.0.0.1';
}
function authorized(req) {
  // The key is always required, so the server is secure by default everywhere.
  return (req.headers['authorization'] || '') === `Bearer ${API_KEY}`;
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = []; let size = 0;
    req.on('data', (c) => { size += c.length; if (size > 10 * 1024 * 1024) { reject(new Error('request body too large')); req.destroy(); return; } chunks.push(c); });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function contentToText(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.map((p) => (typeof p === 'string' ? p : (p && p.type === 'text' ? p.text : ''))).filter(Boolean).join('\n');
  return '';
}

// --- prompt-based function calling --------------------------------------
// The CLI's print mode only returns text, so we give the model the client's
// tool definitions in the system prompt with a strict output contract, then
// parse its reply back into OpenAI-shaped tool_calls. To the client this looks
// exactly like a real function-calling API.

function buildToolInstructions(tools) {
  const defs = tools.map((t) => {
    const f = t.function || t;
    return `- ${f.name}: ${f.description || ''}\n  parameters (JSON Schema): ${JSON.stringify(f.parameters || {})}`;
  }).join('\n');
  return [
    'You have access to the following tools:',
    defs,
    '',
    'When you need to use one or more tools, reply with ONLY a single JSON object and nothing else, in exactly this format:',
    '{"tool_calls": [{"name": "<tool name>", "arguments": { ... }}]}',
    'Each "arguments" object must match that tool\'s parameter schema. You may include several calls in the array.',
    'If you do not need a tool, reply normally in plain text and do NOT emit that JSON.',
  ].join('\n');
}

// Pull a balanced {...} starting at index `start`, respecting strings/escapes.
function balancedObject(text, start) {
  let depth = 0, inStr = false, esc = false;
  for (let i = start; i < text.length; i++) {
    const c = text[i];
    if (esc) { esc = false; continue; }
    if (c === '\\') { esc = true; continue; }
    if (c === '"') { inStr = !inStr; continue; }
    if (inStr) continue;
    if (c === '{') depth++;
    else if (c === '}') { depth--; if (depth === 0) return text.slice(start, i + 1); }
  }
  return null;
}

// Find a {"tool_calls":[...]} object anywhere in the model's text.
function extractToolCalls(text) {
  const marker = text.indexOf('"tool_calls"');
  if (marker === -1) return null;
  let start = text.lastIndexOf('{', marker);
  while (start !== -1) {
    const candidate = balancedObject(text, start);
    if (candidate) {
      try {
        const obj = JSON.parse(candidate);
        if (Array.isArray(obj.tool_calls) && obj.tool_calls.length) return obj.tool_calls;
      } catch (e) { /* keep scanning outward */ }
    }
    start = text.lastIndexOf('{', start - 1);
  }
  return null;
}

// The model sometimes double-encodes arguments (a JSON string of a JSON string).
// Unwrap any nested JSON-string layers down to the object, then stringify exactly once,
// so the client parses it a single time and gets a real dict — not "Missing parameter".
function normalizeArguments(raw) {
  let v = raw;
  for (let i = 0; i < 4 && typeof v === 'string'; i++) {
    const t = v.trim();
    if (!(t.startsWith('{') || t.startsWith('[') || t.startsWith('"'))) break;
    try { v = JSON.parse(v); } catch { break; }
  }
  if (v && typeof v === 'object') return JSON.stringify(v);
  return typeof raw === 'string' ? raw : JSON.stringify(raw ?? {});
}

// Map parsed calls to the OpenAI tool_calls response shape.
function toOpenAIToolCalls(calls) {
  return calls.map((c, i) => ({
    id: 'call_' + Math.random().toString(36).slice(2, 10) + i,
    type: 'function',
    function: {
      name: c.name || (c.function && c.function.name) || '',
      arguments: normalizeArguments(c.arguments != null ? c.arguments : (c.function && c.function.arguments) || {}),
    },
  }));
}

function messagesToPrompt(messages, tools) {
  const systemParts = messages.filter((m) => m.role === 'system').map((m) => contentToText(m.content)).filter(Boolean);
  if (tools && tools.length) systemParts.push(buildToolInstructions(tools));
  const system = systemParts.join('\n\n');

  const convo = messages.filter((m) => m.role !== 'system');
  let prompt;
  if (convo.length === 1 && convo[0].role === 'user') {
    prompt = contentToText(convo[0].content);
  } else {
    prompt = convo.map((m) => {
      if (m.role === 'assistant') {
        const txt = contentToText(m.content);
        if (Array.isArray(m.tool_calls) && m.tool_calls.length) {
          // Render past tool calls in the SAME {"tool_calls":[...]} JSON the model is
          // asked to emit, so history examples stay consistent and parseable.
          const calls = m.tool_calls.map((tc) => {
            const name = tc.function ? tc.function.name : tc.name;
            const rawArgs = tc.function ? tc.function.arguments : tc.arguments;
            let args;
            try { args = typeof rawArgs === 'string' ? JSON.parse(rawArgs) : (rawArgs || {}); }
            catch (e) { args = {}; }
            return { name, arguments: args };
          });
          const json = JSON.stringify({ tool_calls: calls });
          return `Assistant: ${txt ? txt + '\n' : ''}${json}`;
        }
        return `Assistant: ${txt}`;
      }
      if (m.role === 'tool') {
        return `Tool result (${m.name || m.tool_call_id || 'tool'}): ${contentToText(m.content)}`;
      }
      return `User: ${contentToText(m.content)}`;
    }).join('\n\n') + '\n\nAssistant:';
  }
  return { system, prompt };
}

// --- provider invocation -------------------------------------------------
// Generic one-shot run against the ACTIVE provider. Spawning, timeout and error
// plumbing are shared; the per-CLI flags and output parsing live in the adapter.
// The wrapper presents the model as tool-less: it only generates text / emits the
// client's tool_calls, which the client executes — so adapters request no CLI tools
// where their flags allow it (e.g. claude --tools '').
function runProvider({ system, prompt }) {
  return new Promise((resolve, reject) => {
    const p = provider();
    const model = selectedModelId();
    const args = p.buildArgs({ system, prompt, model });

    let child;
    try { child = spawn(p.bin, args, { cwd: CLAUDE_WORKDIR, env: process.env }); }
    catch (err) { reject(new Error(`failed to launch '${p.bin}': ${err.message}`)); return; }

    let stdout = '', stderr = '', finished = false;
    const timer = setTimeout(() => { if (finished) return; finished = true; child.kill('SIGKILL'); reject(new Error(`${activeProvider} timed out after ${PROVIDER_TIMEOUT_MS}ms`)); }, PROVIDER_TIMEOUT_MS);
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('error', (err) => { if (finished) return; finished = true; clearTimeout(timer); reject(new Error(`failed to launch '${p.bin}': ${err.message}`)); });
    child.on('close', (code) => {
      if (finished) return; finished = true; clearTimeout(timer);
      if (code !== 0) { reject(new Error(`${activeProvider} exited ${code}: ${stderr.trim() || stdout.trim() || 'no output'}`)); return; }
      let result;
      try { result = p.parse(stdout, model); } catch (e) { reject(new Error(`could not parse ${activeProvider} output: ${e.message}`)); return; }
      if (result.model) detectedModel = result.model;
      resolve({ text: result.text || '', usage: result.usage || {} });
    });
  });
}

// --- response shaping ----------------------------------------------------

function makeId() { return 'chatcmpl-' + Math.random().toString(36).slice(2) + Date.now().toString(36); }
function nowSeconds() { return Math.floor(Date.now() / 1000); }

function completionPayload({ id, created, text, usage, toolCalls }) {
  const message = toolCalls && toolCalls.length
    ? { role: 'assistant', content: null, tool_calls: toolCalls }
    : { role: 'assistant', content: text };
  return {
    id, object: 'chat.completion', created, model: effectiveModel(),
    choices: [{ index: 0, message, finish_reason: toolCalls && toolCalls.length ? 'tool_calls' : 'stop' }],
    usage: { prompt_tokens: usage.input_tokens || 0, completion_tokens: usage.output_tokens || 0, total_tokens: (usage.input_tokens || 0) + (usage.output_tokens || 0) },
  };
}

function streamCompletion(res, { id, created, text, toolCalls }) {
  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
  const base = { id, object: 'chat.completion.chunk', created, model: effectiveModel() };
  res.write(`data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: { role: 'assistant' }, finish_reason: null }] })}\n\n`);
  if (toolCalls && toolCalls.length) {
    const delta = toolCalls.map((tc, i) => ({ index: i, id: tc.id, type: 'function', function: tc.function }));
    res.write(`data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: { tool_calls: delta }, finish_reason: null }] })}\n\n`);
    res.write(`data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] })}\n\n`);
  } else {
    res.write(`data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: { content: text }, finish_reason: null }] })}\n\n`);
    res.write(`data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })}\n\n`);
  }
  res.write('data: [DONE]\n\n');
  res.end();
}

function statusSnapshot(req) {
  const p = provider();
  const snap = {
    status: 'running', productName: PRODUCT_NAME, model: effectiveModel(),
    activeProvider, selectedModel: selectedModelId(),
    availableProviders: PROVIDER_IDS.map((id) => ({ id, label: PROVIDERS[id].label })),
    availableModels: availableModels(),
    port: PORT, endpoint: `http://localhost:${PORT}/v1`, authRequired: true,
    startedAt: STARTED_AT, uptimeSeconds: Math.floor((Date.now() - STARTED_AT) / 1000),
    requests: metrics.requests, errors: metrics.errors, lastRequestAt: metrics.lastRequestAt, lastError: metrics.lastError,
    // `engine` reflects the active provider; `claude` kept as a back-compat alias.
    engine: { available: engineInfo.available, version: engineInfo.version, bin: p.bin, loginHint: p.loginHint, label: p.label },
    claude: { available: engineInfo.available, version: engineInfo.version, bin: p.bin },
  };
  if (isLocal(req)) snap.apiKey = API_KEY;
  return snap;
}

// --- routing -------------------------------------------------------------

const server = http.createServer(async (req, res) => {
  const url = (req.url || '').split('?')[0];

  if (req.method === 'GET' && (url === '/' || url === '/index.html')) {
    fs.readFile(DASHBOARD_FILE, (err, data) => {
      if (err) { res.writeHead(200, { 'Content-Type': 'text/plain' }); res.end(`${PRODUCT_NAME} wrapper is running. (Dashboard file not found.)`); return; }
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }); res.end(data);
    });
    return;
  }

  if (req.method === 'GET' && url === '/health') return sendJSON(res, 200, { status: 'ok', model: effectiveModel() });
  if (req.method === 'GET' && url === '/status') return sendJSON(res, 200, statusSnapshot(req));

  if (req.method === 'POST' && url === '/provider') {
    if (!isLocal(req)) return sendError(res, 403, 'provider can only be changed from the local machine', 'forbidden');
    let body; try { body = JSON.parse(await readBody(req)); } catch (e) { return sendError(res, 400, 'invalid JSON body'); }
    if (!PROVIDER_IDS.includes(body.provider)) return sendError(res, 400, `provider must be one of: ${PROVIDER_IDS.join(', ')}`);
    activeProvider = body.provider; saveActiveProvider();
    detectedModel = null; // re-resolve the real id on the next real request
    await probeProvider(); // re-probe the new binary and refresh its model catalog
    return sendJSON(res, 200, { activeProvider, selectedModel: selectedModelId(), availableModels: availableModels(), model: effectiveModel() });
  }

  if (req.method === 'POST' && url === '/model') {
    if (!isLocal(req)) return sendError(res, 403, 'model can only be changed from the local machine', 'forbidden');
    let body; try { body = JSON.parse(await readBody(req)); } catch (e) { return sendError(res, 400, 'invalid JSON body'); }
    if (!modelIds().includes(body.model)) return sendError(res, 400, `model must be one of: ${modelIds().join(', ')}`);
    setSelectedModel(body.model);
    detectedModel = null; // re-resolve the real id on the next real request
    return sendJSON(res, 200, { selectedModel: selectedModelId(), model: effectiveModel() });
  }

  if (req.method === 'POST' && url === '/models/refresh') {
    if (!isLocal(req)) return sendError(res, 403, 'refresh can only be triggered from the local machine', 'forbidden');
    await refreshModels();
    return sendJSON(res, 200, { availableModels: availableModels() });
  }

  if (req.method === 'POST' && url === '/shutdown') {
    if (!isLocal(req)) return sendError(res, 403, 'shutdown can only be triggered from the local machine', 'forbidden');
    sendJSON(res, 200, { stopping: true });
    setTimeout(() => process.exit(0), 150);
    return;
  }

  if (req.method === 'GET' && url === '/v1/models') {
    if (!authorized(req)) return sendError(res, 401, 'invalid api key', 'authentication_error');
    return sendJSON(res, 200, { object: 'list', data: [{ id: effectiveModel(), object: 'model', created: nowSeconds(), owned_by: activeProvider }] });
  }

  if (req.method === 'POST' && url === '/v1/chat/completions') {
    if (!authorized(req)) return sendError(res, 401, 'invalid api key', 'authentication_error');
    let payload; try { payload = JSON.parse(await readBody(req)); } catch (e) { return sendError(res, 400, 'invalid JSON body'); }
    if (!payload || !Array.isArray(payload.messages) || payload.messages.length === 0) return sendError(res, 400, 'messages[] is required');
    const tools = Array.isArray(payload.tools) ? payload.tools : null;
    debugLog('REQUEST', { stream: !!payload.stream, toolsCount: tools ? tools.length : 0, payload });
    const { system, prompt } = messagesToPrompt(payload.messages, tools);
    debugLog('PROMPT SENT TO PROVIDER', { provider: activeProvider, system, prompt });
    if (!prompt.trim()) return sendError(res, 400, 'no usable content in messages');
    try {
      const result = await runProvider({ system, prompt });
      metrics.requests += 1; metrics.lastRequestAt = Date.now();
      const id = makeId(), created = nowSeconds();
      // If the client offered tools and the model asked to call one, return structured tool_calls
      const parsedCalls = tools ? extractToolCalls(result.text) : null;
      const toolCalls = parsedCalls ? toOpenAIToolCalls(parsedCalls) : null;
      debugLog('PROVIDER REPLY', { provider: activeProvider, rawText: result.text, parsedToolCalls: toolCalls });
      if (payload.stream) return streamCompletion(res, { id, created, text: result.text, toolCalls });
      return sendJSON(res, 200, completionPayload({ id, created, text: result.text, usage: result.usage, toolCalls }));
    } catch (err) {
      metrics.errors += 1; metrics.lastError = err.message;
      debugLog('ERROR', { message: err.message });
      return sendError(res, 502, err.message, 'upstream_error');
    }
  }

  return sendError(res, 404, `no route for ${req.method} ${url}`, 'not_found');
});

probeProvider();
server.listen(PORT, () => {
  console.log(`[api-wrapper] listening on http://localhost:${PORT}`);
  console.log(`[api-wrapper] dashboard: http://localhost:${PORT}/`);
  console.log(`[api-wrapper] provider: ${activeProvider}  |  model: ${selectedModelId()} (effective: ${effectiveModel()})  |  auth: required`);
});
