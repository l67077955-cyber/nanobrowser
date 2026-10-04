#!/usr/bin/env node
/**
 * A read-only web page of the bridge's run log: every remote task with its steps and result, and, when the
 * browser has a DevTools port, what its screen shows now.
 *
 *   node viewer.mjs [--port 8788] [--host 127.0.0.1] [--run-log <path>] [--cdp http://127.0.0.1:9222]
 *                   [--token-file <path>]
 *
 * The bridge writes the run log when started with --run-log. The page asks for its own key, not the bridge
 * token: open http://host:port/?key=<key> once and a cookie keeps you in. The key file is created on first start.
 * It can be put behind a tunnel: it only reads, and it never talks to the bridge.
 */
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomBytes, createHash, timingSafeEqual } from 'node:crypto';
import { parseArgs } from 'node:util';
import WebSocket from 'ws';

const configDir = path.join(os.homedir(), '.config', 'nanobrowser');
const { values } = parseArgs({
  options: {
    port: { type: 'string', default: '8788' },
    host: { type: 'string', default: '127.0.0.1' },
    'run-log': { type: 'string', default: path.join(configDir, 'runs.jsonl') },
    cdp: { type: 'string' },
    'token-file': { type: 'string', default: path.join(configDir, 'viewer-token') },
  },
});

function loadKey(file) {
  if (!fs.existsSync(file)) {
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    fs.writeFileSync(file, `${randomBytes(24).toString('base64url')}\n`, { mode: 0o600 });
  }
  return fs.readFileSync(file, 'utf8').trim();
}

const key = loadKey(values['token-file']);
const COOKIE = 'nb_viewer';

function sameKey(given) {
  if (typeof given !== 'string') return false;
  const digest = value => createHash('sha256').update(value).digest();
  return timingSafeEqual(digest(given), digest(key));
}

function cookieValue(request) {
  for (const part of (request.headers.cookie ?? '').split(';')) {
    const [name, ...rest] = part.trim().split('=');
    if (name === COOKIE) return decodeURIComponent(rest.join('='));
  }
  return undefined;
}

/** The run log folded into runs, newest first */
function readRuns() {
  let text;
  try {
    text = fs.readFileSync(values['run-log'], 'utf8');
  } catch {
    return [];
  }
  const runs = new Map();
  for (const line of text.split('\n')) {
    if (!line) continue;
    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    if (entry.kind === 'start') {
      runs.set(entry.taskId, {
        id: entry.taskId,
        text: entry.text,
        status: 'running',
        result: '',
        startedAt: entry.t,
        endedAt: null,
        events: [],
      });
      continue;
    }
    const run = runs.get(entry.taskId);
    if (!run) continue;
    if (entry.kind === 'event') {
      run.events.push({ t: entry.t, actor: entry.actor, state: entry.state, step: entry.step, details: entry.details });
      if (entry.state === 'act.confirm') run.status = 'waiting_confirmation';
      else if (entry.state === 'act.ask') run.status = 'waiting_user';
      else if (run.status !== 'running' && String(entry.state).startsWith('act.')) run.status = 'running';
    } else if (entry.kind === 'end') {
      run.status = entry.status;
      run.result = entry.result;
      run.endedAt = entry.t;
    }
  }
  return [...runs.values()].reverse();
}

// ---- the browser's screen, through its DevTools port ----

let lastShot = { at: 0, image: null };

/** The tab the agent most likely works in: the most recently used web page */
async function agentTab() {
  const targets = await (await fetch(`${values.cdp}/json/list`, { signal: AbortSignal.timeout(2000) })).json();
  return targets.find(target => target.type === 'page' && /^(https?:|about:blank)/.test(target.url));
}

function screenshot(target) {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(target.webSocketDebuggerUrl);
    const timer = setTimeout(() => {
      socket.terminate();
      reject(new Error('the browser did not answer'));
    }, 4000);
    socket.on('open', () =>
      socket.send(JSON.stringify({ id: 1, method: 'Page.captureScreenshot', params: { format: 'jpeg', quality: 60 } })),
    );
    socket.on('message', data => {
      const message = JSON.parse(data.toString());
      if (message.id !== 1) return;
      clearTimeout(timer);
      socket.close();
      if (message.result?.data) resolve(Buffer.from(message.result.data, 'base64'));
      else reject(new Error(message.error?.message ?? 'no image'));
    });
    socket.on('error', error => {
      clearTimeout(timer);
      reject(error);
    });
  });
}

async function currentScreen() {
  // several open pages share one capture a second
  if (Date.now() - lastShot.at < 1000 && lastShot.image) return lastShot;
  const target = await agentTab();
  if (!target) return null;
  lastShot = { at: Date.now(), image: await screenshot(target), url: target.url, title: target.title };
  return lastShot;
}

// ---- the page ----

const server = http.createServer(async (request, response) => {
  const url = new URL(request.url ?? '/', 'http://viewer');
  const send = (status, body, type = 'application/json', headers = {}) => {
    response.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'no-store', ...headers });
    response.end(type === 'application/json' ? JSON.stringify(body) : body);
  };

  if (url.searchParams.has('key')) {
    if (!sameKey(url.searchParams.get('key'))) return send(401, 'Wrong key', 'text/plain');
    const secure = request.headers['x-forwarded-proto'] === 'https' ? '; Secure' : '';
    return send(302, '', 'text/plain', {
      Location: '/',
      'Set-Cookie': `${COOKIE}=${encodeURIComponent(key)}; HttpOnly; SameSite=Strict; Path=/; Max-Age=2592000${secure}`,
    });
  }
  if (!sameKey(cookieValue(request))) return send(401, 'Open this page with ?key=<viewer key>', 'text/plain');
  if (request.method !== 'GET') return send(405, { error: 'Method not allowed' });

  switch (url.pathname) {
    case '/':
      return send(200, PAGE, 'text/html; charset=utf-8');
    case '/api/runs':
      return send(200, { runs: readRuns(), screen: Boolean(values.cdp) });
    case '/api/screen': {
      if (!values.cdp) return send(404, { error: 'No DevTools port given' });
      try {
        const shot = await currentScreen();
        if (!shot) return send(404, { error: 'No web page open' });
        return send(200, shot.image, 'image/jpeg', {
          'X-Page-Url': encodeURIComponent(shot.url ?? ''),
          'X-Page-Title': encodeURIComponent(shot.title ?? ''),
        });
      } catch (error) {
        return send(502, { error: error.message });
      }
    }
    default:
      return send(404, { error: 'Not found' });
  }
});

server.listen(Number(values.port), values.host, () => {
  const now = new Date().toISOString();
  console.log(`${now} Nanobrowser run viewer on http://${values.host}:${values.port}/?key=${key}`);
  console.log(`${now}   run log: ${values['run-log']}${values.cdp ? `, screen: ${values.cdp}` : ''}`);
});

const PAGE = String.raw`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Nanobrowser Runs</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600&family=JetBrains+Mono:wght@400&display=swap" rel="stylesheet">
<style>
:root {
  --bg: #f7f7f8; --panel: #ffffff; --line: #e6e6ea; --text: #1d1d22; --muted: #6e6e78; --faint: #a0a0aa;
  --accent: #5e6ad2; --ok: #3f8f6b; --fail: #c4554d; --wait: #b98a2e; --run: #5e6ad2; --hover: #f1f1f4;
}
@media (prefers-color-scheme: dark) {
  :root { --bg: #0f0f11; --panel: #17171a; --line: #26262b; --text: #e6e6ea; --muted: #9a9aa4; --faint: #64646e;
    --accent: #8189e6; --ok: #5fb38e; --fail: #e07a72; --wait: #d4a64e; --run: #8189e6; --hover: #1e1e22; }
}
* { box-sizing: border-box; }
body { margin: 0; background: var(--bg); color: var(--text); font: 13px/1.5 Inter, system-ui, sans-serif; }
header { display: flex; align-items: center; gap: 12px; padding: 14px 20px; border-bottom: 1px solid var(--line); }
header h1 { font-size: 14px; font-weight: 600; margin: 0; }
header .live { margin-left: auto; color: var(--muted); font-size: 12px; display: flex; align-items: center; gap: 6px; }
.dot { width: 7px; height: 7px; border-radius: 50%; background: var(--faint); display: inline-block; }
.dot.on { background: var(--ok); }
main { display: grid; grid-template-columns: 340px 1fr; gap: 16px; padding: 16px 20px; }
.tiles { grid-column: 1 / -1; display: grid; grid-template-columns: repeat(4, 1fr); gap: 12px; }
.tile, .card { background: var(--panel); border: 1px solid var(--line); border-radius: 10px; }
.tile { padding: 12px 14px; }
.tile .k { color: var(--muted); font-size: 12px; }
.tile .v { font-size: 20px; font-weight: 600; margin-top: 2px; font-variant-numeric: tabular-nums; }
.list { overflow: auto; max-height: calc(100vh - 190px); }
.run { padding: 10px 14px; border-bottom: 1px solid var(--line); cursor: pointer; }
.run:hover { background: var(--hover); }
.run.sel { background: var(--hover); box-shadow: inset 2px 0 0 var(--accent); }
.run .t { overflow: hidden; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; }
.run .m { color: var(--muted); font-size: 12px; margin-top: 4px; display: flex; gap: 8px; align-items: center; }
.pill { font-size: 11px; padding: 1px 7px; border-radius: 999px; border: 1px solid currentColor; }
.s-completed { color: var(--ok); } .s-failed, .s-cancelled { color: var(--fail); }
.s-running { color: var(--run); } .s-waiting_user, .s-waiting_confirmation { color: var(--wait); }
.detail { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); gap: 16px; align-content: start; }
.card h2 { font-size: 12px; font-weight: 500; color: var(--muted); margin: 0; padding: 10px 14px; border-bottom: 1px solid var(--line); display: flex; gap: 8px; }
.card .body { padding: 12px 14px; }
.task { grid-column: 1 / -1; }
.task .text { font-size: 15px; font-weight: 500; white-space: pre-wrap; overflow-wrap: anywhere; }
.run .t, .result { overflow-wrap: anywhere; }
.task .meta { color: var(--muted); font-size: 12px; margin-top: 6px; display: flex; gap: 14px; flex-wrap: wrap; }
.result { white-space: pre-wrap; margin-top: 10px; padding: 10px 12px; background: var(--bg); border-radius: 8px; border: 1px solid var(--line); }
.screen img { width: 100%; display: block; border-radius: 0 0 10px 10px; }
.screen .empty, .empty { color: var(--faint); padding: 24px 14px; text-align: center; }
.screen h2 span { margin-left: auto; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 60%; }
.timeline { max-height: calc(100vh - 330px); overflow: auto; }
.ev { display: grid; grid-template-columns: 58px 74px 1fr; gap: 8px; padding: 6px 14px; border-bottom: 1px solid var(--line); }
.ev .time { color: var(--faint); font: 11px/1.8 'JetBrains Mono', monospace; }
.ev .who { color: var(--muted); font-size: 12px; }
.ev .what { white-space: pre-wrap; word-break: break-word; }
.ev .st { font: 11px 'JetBrains Mono', monospace; color: var(--muted); margin-right: 6px; }
.ev.minor .what { color: var(--muted); }
.ev.fail .st { color: var(--fail); } .ev.ok .st { color: var(--ok); } .ev.wait .st { color: var(--wait); }
.ev .what.clamp { display: -webkit-box; -webkit-line-clamp: 6; -webkit-box-orient: vertical; overflow: hidden; cursor: pointer; }
@media (max-width: 900px) {
  main { grid-template-columns: minmax(0, 1fr); padding: 12px 16px; }
  .tiles { grid-template-columns: repeat(2, 1fr); }
  .detail { grid-template-columns: minmax(0, 1fr); }
  .list { max-height: 260px; }
  .timeline { max-height: none; }
}
</style>
</head>
<body>
<header><h1>Nanobrowser runs</h1><div class="live"><span class="dot" id="dot"></span><span id="updated">connecting</span></div></header>
<main>
  <section class="tiles">
    <div class="tile"><div class="k">Runs</div><div class="v" id="n-runs">–</div></div>
    <div class="tile"><div class="k">Completed</div><div class="v" id="n-ok">–</div></div>
    <div class="tile"><div class="k">Failed or cancelled</div><div class="v" id="n-fail">–</div></div>
    <div class="tile"><div class="k">Median duration</div><div class="v" id="n-dur">–</div></div>
  </section>
  <section class="card list" id="list"></section>
  <section class="detail" id="detail"></section>
</main>
<script>
let runs = [], selected = null, screenOn = false, expanded = new Set();
const $ = id => document.getElementById(id);
const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text !== undefined) e.textContent = text; return e; };
const dur = ms => ms == null ? '–' : ms < 60000 ? (ms / 1000).toFixed(1) + 's' : Math.floor(ms / 60000) + 'm ' + Math.round(ms % 60000 / 1000) + 's';
const clock = t => new Date(t).toLocaleTimeString([], { hour12: false });
const label = s => s.replace('_', ' ');
const ended = r => ['completed', 'failed', 'cancelled'].includes(r.status);

async function refresh() {
  try {
    const data = await (await fetch('api/runs', { cache: 'no-store' })).json();
    runs = data.runs; screenOn = data.screen;
    $('dot').className = 'dot on'; $('updated').textContent = 'updated ' + clock(Date.now());
  } catch { $('dot').className = 'dot'; $('updated').textContent = 'offline'; return; }
  if (!selected && runs[0]) selected = runs[0].id;
  renderTiles(); renderList(); renderDetail();
}

function renderTiles() {
  const done = runs.filter(ended);
  $('n-runs').textContent = runs.length;
  $('n-ok').textContent = runs.filter(r => r.status === 'completed').length;
  $('n-fail').textContent = runs.filter(r => r.status === 'failed' || r.status === 'cancelled').length;
  const ds = done.map(r => r.endedAt - r.startedAt).sort((a, b) => a - b);
  $('n-dur').textContent = ds.length ? dur(ds[Math.floor(ds.length / 2)]) : '–';
}

function renderList() {
  const list = $('list'); const top = list.scrollTop; list.replaceChildren();
  if (!runs.length) list.append(el('div', 'empty', 'No runs yet. Tasks sent through the bridge show up here.'));
  for (const r of runs) {
    const row = el('div', 'run' + (r.id === selected ? ' sel' : ''));
    row.append(el('div', 't', r.text));
    const m = el('div', 'm');
    m.append(el('span', 'pill s-' + r.status, label(r.status)), el('span', '', clock(r.startedAt)),
      el('span', '', dur((r.endedAt ?? Date.now()) - r.startedAt)), el('span', '', r.events.length + ' events'));
    row.append(m);
    row.onclick = () => { selected = r.id; renderList(); renderDetail(); };
    list.append(row);
  }
  list.scrollTop = top;
}

function renderDetail() {
  const box = $('detail'); const r = runs.find(x => x.id === selected);
  const tl = box.querySelector('.timeline'); const keep = tl ? tl.scrollTop : null;
  const atBottom = tl ? tl.scrollHeight - tl.scrollTop - tl.clientHeight < 40 : true;
  const oldScreen = box.querySelector('.screen');
  box.replaceChildren();
  if (!r) return;

  const task = el('div', 'card task'); const tb = el('div', 'body');
  tb.append(el('div', 'text', r.text));
  const meta = el('div', 'meta');
  meta.append(el('span', 'pill s-' + r.status, label(r.status)), el('span', '', 'started ' + new Date(r.startedAt).toLocaleString()),
    el('span', '', 'duration ' + dur((r.endedAt ?? Date.now()) - r.startedAt)), el('span', '', r.id));
  tb.append(meta);
  if (r.result) {
    // the agent writes **bold** in its answers
    const result = el('div', 'result');
    r.result.split('**').forEach((part, i) => result.append(i % 2 ? el('strong', '', part) : document.createTextNode(part)));
    tb.append(result);
  }
  task.append(tb); box.append(task);

  const tlCard = el('div', 'card'); tlCard.append(el('h2', '', 'Steps'));
  const list = el('div', 'timeline');
  if (!r.events.length) list.append(el('div', 'empty', 'No steps yet'));
  r.events.forEach((e, i) => {
    const kind = /fail/.test(e.state) ? 'fail' : /ok$/.test(e.state) ? 'ok' : /confirm|ask/.test(e.state) ? 'wait' : 'minor';
    const row = el('div', 'ev ' + kind);
    row.append(el('div', 'time', clock(e.t)), el('div', 'who', e.actor + (e.step != null ? ' · ' + e.step : '')));
    const what = el('div', 'what' + (expanded.has(r.id + i) ? '' : ' clamp'));
    what.append(el('span', 'st', e.state), document.createTextNode(e.details || ''));
    what.onclick = () => { expanded.has(r.id + i) ? expanded.delete(r.id + i) : expanded.add(r.id + i); renderDetail(); };
    row.append(what); list.append(row);
  });
  tlCard.append(list); box.append(tlCard);

  if (oldScreen) box.append(oldScreen);
  else {
    const sc = el('div', 'card screen');
    sc.append(el('h2', '', 'Browser now'));
    sc.append(el('div', 'empty', screenOn ? 'Loading…' : 'No DevTools port: start the viewer with --cdp to see the screen'));
    box.append(sc);
  }
  if (keep != null) list.scrollTop = atBottom ? list.scrollHeight : keep; else list.scrollTop = list.scrollHeight;
}

async function refreshScreen() {
  if (!screenOn || document.hidden) return;
  const sc = document.querySelector('.screen'); if (!sc) return;
  try {
    const res = await fetch('api/screen', { cache: 'no-store' });
    if (!res.ok) throw new Error((await res.json()).error);
    const url = URL.createObjectURL(await res.blob());
    const h = el('h2', ''); h.append(el('span', '', decodeURIComponent(res.headers.get('X-Page-Url') || '')));
    h.prepend(document.createTextNode('Browser now'));
    let img = sc.querySelector('img');
    if (!img) { sc.replaceChildren(h, img = el('img')); } else { sc.querySelector('h2').replaceWith(h); URL.revokeObjectURL(img.src); }
    img.src = url;
  } catch (error) {
    sc.replaceChildren(el('h2', '', 'Browser now'), el('div', 'empty', String(error.message || error)));
  }
}

refresh(); setInterval(refresh, 2000);
setInterval(refreshScreen, 1500); setTimeout(refreshScreen, 300);
</script>
</body>
</html>`;
