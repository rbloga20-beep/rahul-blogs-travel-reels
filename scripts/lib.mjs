// Shared helpers: settings, logging, HTTP, Meta Graph, AI writers (Gemini first, Groq fallback), state files.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const GRAPH = 'https://graph.facebook.com/v26.0';

// .env locally, plain environment variables on GitHub (secrets)
function loadEnv() {
  const env = { ...process.env };
  const f = path.join(ROOT, '.env');
  if (fs.existsSync(f)) {
    for (const line of fs.readFileSync(f, 'utf8').split(/\r?\n/)) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
      if (m && !env[m[1]]) env[m[1]] = m[2].replace(/^["']|["']$/g, '');
    }
  }
  for (const k of Object.keys(env)) if (typeof env[k] === 'string') env[k] = env[k].trim();
  return env;
}
export const ENV = loadEnv();
export const on = (k, def = false) => (ENV[k] === undefined || ENV[k] === '' ? def : /^(1|true|yes|on)$/i.test(ENV[k]));
export function need(...keys) {
  const miss = keys.filter((k) => !ENV[k]);
  if (miss.length) throw new Error('missing settings: ' + miss.join(', '));
}

const LOG_FILE = path.join(ROOT, 'logs', 'run.log');
// every secret value is masked before anything is printed
const SECRET_VALUES = Object.entries(ENV).filter(([k, v]) => /KEY|TOKEN|SECRET/.test(k) && v && v.length > 8).map(([, v]) => v);
export function log(msg) {
  let line = `[${new Date().toISOString()}] ${msg}`;
  for (const s of SECRET_VALUES) line = line.split(s).join('***');
  console.log(line);
  fs.mkdirSync(path.dirname(LOG_FILE), { recursive: true });
  fs.appendFileSync(LOG_FILE, line + '\n');
}
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function http(url, init = {}, timeout = 60000) {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), timeout);
  try {
    const r = await fetch(url, { ...init, signal: ac.signal });
    const text = await r.text();
    let body; try { body = JSON.parse(text); } catch { body = text; }
    return { ok: r.ok, status: r.status, body, headers: r.headers };
  } catch (e) {
    return { ok: false, status: 0, body: { error: String(e.message || e) } };
  } finally { clearTimeout(t); }
}
export const short = (b) => JSON.stringify(b).slice(0, 300);

// ---- state files (committed back to the repo by the workflow) ----
export function readJson(rel, def) {
  const f = path.join(ROOT, rel);
  try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return def; }
}
export function writeJson(rel, data) {
  const f = path.join(ROOT, rel);
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f + '.tmp', JSON.stringify(data, null, 1));
  fs.renameSync(f + '.tmp', f);
}

// ---- Meta ----
let pageTok = null;
export async function pageToken() {
  if (pageTok) return pageTok;
  need('META_SYSTEM_TOKEN', 'FB_PAGE_ID');
  const r = await http(`${GRAPH}/${ENV.FB_PAGE_ID}?fields=access_token&access_token=${encodeURIComponent(ENV.META_SYSTEM_TOKEN)}`);
  if (!r.ok || !r.body.access_token) throw new Error('page token failed: ' + short(r.body));
  return (pageTok = r.body.access_token);
}
export async function graph(pathq, params = {}, method = 'GET', tok) {
  tok = tok || await pageToken();
  if (method === 'GET') {
    const q = new URLSearchParams({ ...params, access_token: tok });
    return http(`${GRAPH}/${pathq}${pathq.includes('?') ? '&' : '?'}${q}`, {}, 60000);
  }
  return http(`${GRAPH}/${pathq}`, { method, headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...params, access_token: tok }) }, 120000);
}

// ---- AI writers: JSON out. Gemini (free AI Studio key) first, Groq free as fallback ----
export async function aiJson(prompt, { temperature = 0.9 } = {}) {
  const errs = [];
  if (ENV.GEMINI_API_KEY) {
    const models = (ENV.GEMINI_MODELS || 'gemini-3.5-flash,gemini-3.1-flash-lite').split(',').map((s) => s.trim()).filter(Boolean);
    for (const m of models) {
      const r = await http(`https://generativelanguage.googleapis.com/v1beta/models/${m}:generateContent`, {
        method: 'POST', headers: { 'Content-Type': 'application/json', 'x-goog-api-key': ENV.GEMINI_API_KEY },
        body: JSON.stringify({ contents: [{ role: 'user', parts: [{ text: prompt }] }],
          generationConfig: { responseMimeType: 'application/json', temperature } }),
      }, 90000);
      if (!r.ok) { errs.push(`${m} ${r.status}`); continue; }
      try { return JSON.parse(r.body.candidates[0].content.parts.map((p) => p.text || '').join('')); }
      catch { errs.push(`${m} bad JSON`); }
    }
  }
  if (ENV.GROQ_API_KEY) {
    for (const m of (ENV.GROQ_MODELS || 'openai/gpt-oss-120b,llama-3.3-70b-versatile').split(',').map((s) => s.trim())) {
      const r = await http('https://api.groq.com/openai/v1/chat/completions', {
        method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + ENV.GROQ_API_KEY },
        body: JSON.stringify({ model: m, temperature, response_format: { type: 'json_object' },
          messages: [{ role: 'user', content: prompt + '\nAnswer with one JSON object only.' }] }),
      }, 90000);
      if (!r.ok) { errs.push(`${m} ${r.status}`); continue; }
      try { return JSON.parse(r.body.choices[0].message.content); } catch { errs.push(`${m} bad JSON`); }
    }
  }
  throw new Error('AI writers failed: ' + (errs.join('; ') || 'no AI key set'));
}
