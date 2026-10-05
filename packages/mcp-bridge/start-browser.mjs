#!/usr/bin/env node
/**
 * Start a browser with the Nanobrowser extension for the bridge, where the extension cannot stay installed:
 * a server without a screen, or a Chrome or Edge that ignores --load-extension. The browser gets a profile and
 * a DevTools port of its own, and the extension is loaded through that port every time the browser starts.
 * A browser already running is left as it is; the extension is loaded again only when it is missing, or with
 * --reload (after a build).
 *
 *   node start-browser.mjs --profile <dir> --extension <dist> [--browser <path>] [--cdp-port 9222]
 *                          [--display :98] [--log <file>] [--reload]
 *
 * --display starts Xvfb on that display when nothing listens there. As the bridge's --launch-cmd, the first
 * task after a reboot brings the browser up.
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { parseArgs } from 'node:util';
import { setTimeout as wait } from 'node:timers/promises';
import { findChrome } from './service.mjs';
import { extensionIdForPath } from './pairing.mjs';

const { values } = parseArgs({
  options: {
    browser: { type: 'string' },
    profile: { type: 'string' },
    extension: { type: 'string' },
    'cdp-port': { type: 'string', default: '9222' },
    display: { type: 'string' },
    log: { type: 'string' },
    reload: { type: 'boolean', default: false },
  },
});

const say = (...args) => console.log(new Date().toISOString(), 'start-browser:', ...args);
function fail(message) {
  console.error(new Date().toISOString(), 'start-browser:', message);
  process.exit(1);
}

if (!values.profile || !values.extension) fail('--profile and --extension are required');
const browser = values.browser ?? findChrome();
if (!browser) fail('no browser found: pass --browser or set NANOBROWSER_CHROME');
if (!fs.existsSync(values.extension)) fail(`no extension at ${values.extension}: build it first`);
const profile = path.resolve(values.profile);
const extension = fs.realpathSync(values.extension);
const port = Number(values['cdp-port']);
const devtools = `http://127.0.0.1:${port}`;
const logFile = path.resolve(values.log ?? path.join(profile, 'nanobrowser-browser.log'));

/** The browser's DevTools description, or null when nothing answers on the port */
async function version() {
  try {
    return await (await fetch(`${devtools}/json/version`, { signal: AbortSignal.timeout(2000) })).json();
  } catch {
    return null;
  }
}

async function startDisplay(display) {
  const socket = `/tmp/.X11-unix/X${display.replace(/^:/, '').split('.')[0]}`;
  if (fs.existsSync(socket)) return;
  say('starting Xvfb on', display);
  spawn('Xvfb', [display, '-screen', '0', '1600x1000x24', '-nolisten', 'tcp'], {
    detached: true,
    stdio: 'ignore',
  }).unref();
  for (let i = 0; i < 50 && !fs.existsSync(socket); i++) await wait(100);
}

async function startBrowser() {
  fs.mkdirSync(profile, { recursive: true });
  const out = fs.openSync(logFile, 'a');
  const args = [
    `--user-data-dir=${profile}`,
    `--remote-debugging-port=${port}`,
    // lets Extensions.loadUnpacked load the extension through the DevTools port
    '--enable-unsafe-extension-debugging',
    '--no-first-run',
    '--no-default-browser-check',
    // Chrome refuses to run as root with its sandbox
    ...(process.getuid?.() === 0 ? ['--no-sandbox'] : []),
  ];
  say('starting', browser, 'with the profile', profile);
  spawn(browser, args, {
    detached: true,
    stdio: ['ignore', out, out],
    env: values.display ? { ...process.env, DISPLAY: values.display } : process.env,
  }).unref();
  for (let i = 0; i < 60; i++) {
    const found = await version();
    if (found) return found;
    await wait(500);
  }
  return null;
}

/** Send one DevTools command to the browser and return its result */
async function command(webSocketUrl, method, params) {
  const socket = new WebSocket(webSocketUrl);
  await new Promise((resolve, reject) => {
    socket.addEventListener('open', resolve, { once: true });
    socket.addEventListener('error', () => reject(new Error('cannot reach the DevTools port')), { once: true });
  });
  try {
    return await new Promise((resolve, reject) => {
      socket.addEventListener('message', event => {
        const message = JSON.parse(String(event.data));
        if (message.id !== 1) return;
        if (message.error) reject(new Error(message.error.message));
        else resolve(message.result);
      });
      socket.send(JSON.stringify({ id: 1, method, params }));
    });
  } finally {
    socket.close();
  }
}

let running = await version();
const started = !running;
if (started) {
  if (values.display) await startDisplay(values.display);
  running = await startBrowser();
  if (!running) fail(`the browser did not open its DevTools port ${port}; see ${logFile}`);
}

const id = extensionIdForPath(extension);
const targets = await (await fetch(`${devtools}/json/list`)).json();
// a service worker that went to sleep is not listed: the extension is then loaded again, which does no harm
const present = targets.some(target => target.url.startsWith(`chrome-extension://${id}/`));
if (started || !present || values.reload) {
  // a browser that has just opened its port may not take extensions yet
  for (let attempt = 1; ; attempt++) {
    try {
      const result = await command(running.webSocketDebuggerUrl, 'Extensions.loadUnpacked', { path: extension });
      say(`extension loaded from ${extension} (${result.id})`);
      break;
    } catch (error) {
      if (attempt === 5) fail(`cannot load the extension: ${error.message}`);
      await wait(1000);
    }
  }
} else {
  say('the browser and the extension are running already');
}
