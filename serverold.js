#!/usr/bin/env node
'use strict';

/*
 * OpenAI-compatible HTTP wrapper around the official Claude Code CLI.
 *
 * Each chat request is turned into a `claude -p ... --output-format json` call,
 * so the response is produced by Claude Code running under your logged-in
 * subscription. The result is mapped back into the OpenAI Chat Completions
 * shape, which means any OpenAI-compatible client (Obsidian Copilot, Kai, etc.)
 * can point at this endpoint and talk to Claude Code.
 *
 * Endpoints:
 *   GET  /health              — liveness check
 *   GET  /v1/models           — lists the single virtual model
 *   POST /v1/chat/completions — main chat endpoint (stream + non-stream)
 *
 * Config (environment variables):
 *   PORT               default 8787
 *   WRAPPER_API_KEY    if set, requests must send `Authorization: Bearer <key>`
 *   CLAUDE_BIN         path to the claude binary (default: "claude")
 *   MODEL_NAME         model id reported to clients (default: "claude-code")
 *   CLAUDE_MODEL       optional real model passed to claude via --model
 *   CLAUDE_WORKDIR     dir the CLI runs in (default: a temp dir, keeps it from
 *                      scanning whatever folder you launched from)
 *   CLAUDE_TIMEOUT_MS  per-request timeout (default: 180000)
 */

const http = require('http');
const os = require('os');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const PORT = parseInt(process.env.PORT || '8787', 10);
const WRAPPER_API_KEY = process.env.WRAPPER_API_KEY || '';
const CLAUDE_BIN = process.env.CLAUDE_BIN || 'claude';
const MODEL_NAME = process.env.MODEL_NAME || 'claude-code';
const CLAUDE_MODEL = process.env.CLAUDE_MODEL || '';
const CLAUDE_TIMEOUT_MS = parseInt(process.env.CLAUDE_TIMEOUT_MS || '180000', 10);

// Run the CLI in a clean, stable working directory so it doesn't pull in the
// context of whatever folder the server happens to start in.
const CLAUDE_WORKDIR = process.env.CLAUDE_WORKDIR
  || fs.mkdtempSync(path.join(os.tmpdir(), 'cc-wrapper-'));

// --- small helpers -------------------------------------------------------

function sendJSON(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(body),
  });
  res.end(body);
}

function sendError(res, status, message, type = 'invalid_request_error') {
  sendJSON(res, status, { error: { message, type } });
}

function authorized(req) {
  if (!WRAPPER_API_KEY) return true;
  const header = req.headers['authorization'] || '';
  return header === `Bearer ${WRAPPER_API_KEY}`;
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > 10 * 1024 * 1024) { reject(new Error('request body too large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

// OpenAI message content can be a plain string or an array of parts.
function contentToText(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((p) => (typeof p === 'string' ? p : (p && p.type === 'text' ? p.text : '')))
      .filter(Boolean)
      .join('\n');
  }
  return '';
}

// Fold an OpenAI messages[] array into (systemPrompt, prompt) for claude -p.
// System turns become an appended system prompt; the rest becomes a labelled
// transcript so multi-turn context is preserved in a single print call.
function messagesToPrompt(messages) {
  const system = messages
    .filter((m) => m.role === 'system')
    .map((m) => contentToText(m.content))
    .filter(Boolean)
    .join('\n\n');

  const convo = messages.filter((m) => m.role !== 'system');

  let prompt;
  if (convo.length === 1 && convo[0].role === 'user') {
    prompt = contentToText(convo[0].content);
  } else {
    const transcript = convo
      .map((m) => {
        const who = m.role === 'assistant' ? 'Assistant' : 'User';
        return `${who}: ${contentToText(m.content)}`;
      })
      .join('\n\n');
    prompt = `${transcript}\n\nAssistant:`;
  }
  return { system, prompt };
}

// --- claude invocation ---------------------------------------------------

function runClaude({ system, prompt, model }) {
  return new Promise((resolve, reject) => {
    const args = ['-p', prompt, '--output-format', 'json', '--no-session-persistence'];
    if (system) args.push('--append-system-prompt', system);
    const useModel = model || CLAUDE_MODEL;
    if (useModel) args.push('--model', useModel);

    const child = spawn(CLAUDE_BIN, args, {
      cwd: CLAUDE_WORKDIR,
      env: process.env,
    });

    let stdout = '';
    let stderr = '';
    let finished = false;

    const timer = setTimeout(() => {
      if (finished) return;
      finished = true;
      child.kill('SIGKILL');
      reject(new Error(`claude timed out after ${CLAUDE_TIMEOUT_MS}ms`));
    }, CLAUDE_TIMEOUT_MS);

    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });

    child.on('error', (err) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      reject(new Error(`failed to launch '${CLAUDE_BIN}': ${err.message}`));
    });

    child.on('close', (code) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      if (code !== 0) {
        reject(new Error(`claude exited ${code}: ${stderr.trim() || stdout.trim() || 'no output'}`));
        return;
      }
      let parsed;
      try {
        parsed = JSON.parse(stdout.trim());
      } catch (e) {
        reject(new Error(`could not parse claude output: ${e.message}\nraw: ${stdout.slice(0, 500)}`));
        return;
      }
      if (parsed.is_error) {
        reject(new Error(`claude reported an error: ${parsed.result || parsed.subtype || 'unknown'}`));
        return;
      }
      resolve({
        text: typeof parsed.result === 'string' ? parsed.result : '',
        usage: parsed.usage || {},
        sessionId: parsed.session_id || null,
      });
    });
  });
}

// --- response shaping ----------------------------------------------------

function makeId() {
  return 'chatcmpl-' + Math.random().toString(36).slice(2) + Date.now().toString(36);
}

function nowSeconds() {
  return Math.floor(Date.now() / 1000);
}

function completionPayload({ id, created, text, usage }) {
  return {
    id,
    object: 'chat.completion',
    created,
    model: MODEL_NAME,
    choices: [
      {
        index: 0,
        message: { role: 'assistant', content: text },
        finish_reason: 'stop',
      },
    ],
    usage: {
      prompt_tokens: usage.input_tokens || 0,
      completion_tokens: usage.output_tokens || 0,
      total_tokens: (usage.input_tokens || 0) + (usage.output_tokens || 0),
    },
  };
}

// Emit the result as Server-Sent Events in the OpenAI streaming shape. The CLI
// gives us the full answer at once, so we send it as a single content delta
// followed by the terminating [DONE]. (Token-by-token streaming can be layered
// on later via --output-format stream-json.)
function streamCompletion(res, { id, created, text }) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  });
  const base = { id, object: 'chat.completion.chunk', created, model: MODEL_NAME };

  res.write(`data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: { role: 'assistant' }, finish_reason: null }] })}\n\n`);
  res.write(`data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: { content: text }, finish_reason: null }] })}\n\n`);
  res.write(`data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })}\n\n`);
  res.write('data: [DONE]\n\n');
  res.end();
}

// --- routing -------------------------------------------------------------

const server = http.createServer(async (req, res) => {
  const url = (req.url || '').split('?')[0];

  if (req.method === 'GET' && url === '/health') {
    return sendJSON(res, 200, { status: 'ok', model: MODEL_NAME });
  }

  if (req.method === 'GET' && url === '/v1/models') {
    if (!authorized(req)) return sendError(res, 401, 'invalid api key', 'authentication_error');
    return sendJSON(res, 200, {
      object: 'list',
      data: [{ id: MODEL_NAME, object: 'model', created: nowSeconds(), owned_by: 'claude-code' }],
    });
  }

  if (req.method === 'POST' && url === '/v1/chat/completions') {
    if (!authorized(req)) return sendError(res, 401, 'invalid api key', 'authentication_error');

    let payload;
    try {
      payload = JSON.parse(await readBody(req));
    } catch (e) {
      return sendError(res, 400, 'invalid JSON body');
    }
    if (!payload || !Array.isArray(payload.messages) || payload.messages.length === 0) {
      return sendError(res, 400, 'messages[] is required');
    }

    const { system, prompt } = messagesToPrompt(payload.messages);
    if (!prompt.trim()) return sendError(res, 400, 'no usable content in messages');

    try {
      const result = await runClaude({ system, prompt, model: payload.model && payload.model !== MODEL_NAME ? payload.model : '' });
      const id = makeId();
      const created = nowSeconds();
      if (payload.stream) {
        return streamCompletion(res, { id, created, text: result.text });
      }
      return sendJSON(res, 200, completionPayload({ id, created, text: result.text, usage: result.usage }));
    } catch (err) {
      return sendError(res, 502, err.message, 'upstream_error');
    }
  }

  return sendError(res, 404, `no route for ${req.method} ${url}`, 'not_found');
});

server.listen(PORT, () => {
  console.log(`[claude-code-api-wrapper] listening on http://localhost:${PORT}`);
  console.log(`[claude-code-api-wrapper] model id: ${MODEL_NAME}  |  claude bin: ${CLAUDE_BIN}`);
  console.log(`[claude-code-api-wrapper] working dir: ${CLAUDE_WORKDIR}`);
  console.log(`[claude-code-api-wrapper] auth: ${WRAPPER_API_KEY ? 'required (Bearer token)' : 'open (no key set)'}`);
});
