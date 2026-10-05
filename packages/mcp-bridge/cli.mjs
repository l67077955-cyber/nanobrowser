#!/usr/bin/env node
/**
 * Start the Nanobrowser MCP bridge, or have it run in the background from login on.
 *
 *   node cli.mjs [--port 8787] [--host 127.0.0.1] [--token-file <path>] [--launch-browser | --launch-cmd <command>]
 *                [--prefer <name,…>] [--run-log <path>] [--telegram-chat <chat id> --telegram-token-file <path>]
 *   node cli.mjs install [same options]     run it in the background from login on, and now; pair the extension
 *   node cli.mjs uninstall                  stop that and remove it, pairing included
 *   node cli.mjs status                     whether it is installed and running
 *   node cli.mjs pair [--profile <dir>]… [--extension-id <id>]…   only pair the extension on this computer
 *
 * The token comes from NANOBROWSER_BRIDGE_TOKEN or from the token file, which is created on first start.
 * With --launch-browser, Chrome is started without a window when an agent needs the browser and none is
 * connected; `install` turns it on. --launch-cmd runs a command for that instead, such as start-browser.mjs on a
 * server. With several browsers connected, a task goes to the first of --prefer that is there, else to a browser
 * on another system than the bridge's. With --run-log, every task's start, steps and end are appended to that
 * file as JSON lines, which viewer.mjs shows as a web page. With --telegram-chat, a task that waits for the user
 * (a code, a QR code to scan, an approval) is sent to that Telegram chat with a screenshot, and the reply goes
 * back to the task; the bot token comes from NANOBROWSER_TELEGRAM_TOKEN or the token file.
 *
 * Pairing hands the extension the bridge's address and token through Chrome's native messaging: an extension
 * with no bridge set asks for them when it starts, and turns remote tasks on. It answers the extension loaded
 * unpacked from this repository's dist folder and the ids given with --extension-id; --profile adds a browser
 * profile that has a folder of its own (a --user-data-dir).
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { createBridge } from './bridge.mjs';
import { createTelegram } from './telegram.mjs';
import { extensionIdForPath, installHost, uninstallHost } from './pairing.mjs';
import { findChrome, installService, launchChrome, serviceStatus, uninstallService } from './service.mjs';

/** the extension as this repository builds it, loaded unpacked from there */
const DIST = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'dist');

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    port: { type: 'string', default: process.env.NANOBROWSER_BRIDGE_PORT ?? '8787' },
    host: { type: 'string', default: process.env.NANOBROWSER_BRIDGE_HOST ?? '127.0.0.1' },
    'token-file': { type: 'string', default: path.join(os.homedir(), '.config', 'nanobrowser', 'bridge-token') },
    'launch-browser': { type: 'boolean', default: false },
    'launch-cmd': { type: 'string' },
    prefer: { type: 'string' },
    'run-log': { type: 'string' },
    'telegram-chat': { type: 'string', default: process.env.NANOBROWSER_TELEGRAM_CHAT },
    'telegram-token-file': {
      type: 'string',
      default: path.join(os.homedir(), '.config', 'nanobrowser', 'telegram-token'),
    },
    profile: { type: 'string', multiple: true, default: [] },
    'extension-id': { type: 'string', multiple: true, default: [] },
  },
});
const tokenFile = path.resolve(values['token-file']);

function loadToken(file) {
  if (process.env.NANOBROWSER_BRIDGE_TOKEN)
    return { token: process.env.NANOBROWSER_BRIDGE_TOKEN, source: 'NANOBROWSER_BRIDGE_TOKEN' };
  if (!fs.existsSync(file)) {
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    fs.writeFileSync(file, `${randomBytes(32).toString('base64url')}\n`, { mode: 0o600 });
  }
  return { token: fs.readFileSync(file, 'utf8').trim(), source: file };
}

async function isListening() {
  try {
    // the bridge answers 401 to a request without the token: something is there
    const response = await fetch(`http://${values.host}:${values.port}/mcp`, { method: 'POST' });
    return response.status === 401;
  } catch {
    return false;
  }
}

/** Let the extension on this computer ask for the bridge's address and token; null when it cannot */
function pair() {
  if (process.env.NANOBROWSER_BRIDGE_TOKEN) {
    console.log('Not paired: the token comes from NANOBROWSER_BRIDGE_TOKEN, which the extension cannot be handed.');
    return null;
  }
  loadToken(tokenFile);
  const dist = fs.existsSync(DIST) ? fs.realpathSync.native(DIST) : DIST;
  const ids = [...new Set([extensionIdForPath(dist), ...values['extension-id']])];
  const { manifests, registry } = installHost({
    port: values.port,
    tokenFile,
    extensionIds: ids,
    profiles: values.profile,
  });
  console.log(`Paired: an extension with no bridge set connects by itself the next time the browser starts.
  extension ids  ${ids.join(', ')}   (${extensionIdForPath(dist)} is the one loaded unpacked from ${dist})
  host           ${[...manifests, ...registry].join('\n                 ') || '(no Chrome, Edge or Chromium profile found)'}
  An extension installed some other way has another id (see chrome://extensions): add --extension-id <id>.`);
  return { ids, manifests, registry };
}

function printConnection(token, source) {
  console.log(`
Connect the browser by hand, when it is not paired: Nanobrowser settings > Remote
  Bridge address  ws://localhost:${values.port}/extension
  Token           ${token}
  then turn on "Allow remote tasks".

Connect an agent:
  MCP endpoint    http://localhost:${values.port}/mcp
  Header          Authorization: Bearer <token>   (token file: ${source})
  Claude Code:    claude mcp add --transport http nanobrowser http://localhost:${values.port}/mcp --header "Authorization: Bearer ${token}"`);
}

const command = positionals[0] ?? 'serve';

if (command === 'install') {
  const { token, source } = loadToken(tokenFile);
  const args = [
    fileURLToPath(import.meta.url),
    '--port',
    values.port,
    '--host',
    values.host,
    '--token-file',
    tokenFile,
    ...(values['launch-cmd'] ? ['--launch-cmd', values['launch-cmd']] : ['--launch-browser']),
    ...(values.prefer ? ['--prefer', values.prefer] : []),
    ...(values['run-log'] ? ['--run-log', path.resolve(values['run-log'])] : []),
    ...(values['telegram-chat']
      ? [
          '--telegram-chat',
          values['telegram-chat'],
          '--telegram-token-file',
          path.resolve(values['telegram-token-file']),
        ]
      : []),
  ];
  const { file, log } = installService(args);
  console.log(`Installed: the bridge now runs in the background and starts again at every login.
  service  ${file}
  log      ${log}`);
  if (!values['launch-cmd'] && !findChrome())
    console.log('  Chrome was not found: set NANOBROWSER_CHROME to its path for it to be started on demand.');
  pair();
  printConnection(token, source);
} else if (command === 'uninstall') {
  const service = uninstallService();
  const host = uninstallHost();
  console.log(
    service || host ? 'Removed: the bridge no longer runs in the background, nor pairs.' : 'It was not installed.',
  );
} else if (command === 'pair') {
  pair();
} else if (command === 'status') {
  const { installed, file, log } = serviceStatus();
  console.log(`installed  ${installed ? `yes (${file})` : 'no'}`);
  console.log(`running    ${(await isListening()) ? `yes, on ${values.host}:${values.port}` : 'no'}`);
  if (installed) console.log(`log        ${log}`);
} else if (command === 'serve') {
  const { token, source } = loadToken(tokenFile);
  const log = (...args) => console.log(new Date().toISOString(), ...args);
  const launchCmd = values['launch-cmd'];
  const chrome = !launchCmd && values['launch-browser'] ? findChrome() : null;
  if (!launchCmd && values['launch-browser'] && !chrome)
    log('Chrome not found: set NANOBROWSER_CHROME; it will not be started on demand');
  // the command's output goes to the bridge's log; a browser it starts lives on by itself
  const runLaunchCmd = () => {
    const child = spawn(launchCmd, { shell: true, stdio: ['ignore', 'inherit', 'inherit'] });
    child.on('error', error => log('cannot run the launch command:', error.message));
    child.on('exit', code => code && log(`the launch command failed (exit ${code})`));
  };
  const runLog = values['run-log'];
  if (runLog) fs.mkdirSync(path.dirname(runLog), { recursive: true });
  // written in order, one line at a time: a failed write is logged and the task goes on
  const record = runLog
    ? entry => {
        try {
          fs.appendFileSync(runLog, `${JSON.stringify(entry)}\n`);
        } catch (error) {
          log('cannot write the run log', error.message);
        }
      }
    : undefined;
  // the user is reached on Telegram when a task waits for them; the bridge is made first, the relay needs it
  let telegram = null;
  const chatId = values['telegram-chat'];
  const bridge = createBridge({
    token,
    log,
    record,
    startBrowser: launchCmd ? runLaunchCmd : chrome ? () => launchChrome(chrome) : undefined,
    prefer: (values.prefer ?? '')
      .split(',')
      .map(name => name.trim())
      .filter(Boolean),
    onWaiting: task => telegram?.onWaiting(task),
    onWaitingOver: task => telegram?.onWaitingOver(task),
  });
  if (chatId) {
    let botToken = process.env.NANOBROWSER_TELEGRAM_TOKEN;
    try {
      botToken ??= fs.readFileSync(values['telegram-token-file'], 'utf8').trim();
    } catch {
      log(`no Telegram bot token: set NANOBROWSER_TELEGRAM_TOKEN or write it to ${values['telegram-token-file']}`);
    }
    if (botToken) telegram = createTelegram({ token: botToken, chatId, answerTask: bridge.answerTask, log });
  }

  bridge.server.on('error', error => {
    log(`cannot listen on ${values.host}:${values.port}: ${error.message}`);
    process.exit(1);
  });
  bridge.server.listen(Number(values.port), values.host, () => {
    const local = ['127.0.0.1', 'localhost', '::1'].includes(values.host);
    log(`Nanobrowser bridge listening on ${values.host}:${values.port}`);
    log(`  extension: ws://${values.host}:${values.port}/extension`);
    log(`  agents:    http://${values.host}:${values.port}/mcp  (Authorization: Bearer <token>)`);
    log(`  token:     ${source}`);
    if (launchCmd) log(`  browser:   started on demand by ${launchCmd}`);
    if (chrome) log(`  browser:   started on demand (${chrome})`);
    if (values.prefer) log(`  prefer:    ${values.prefer}`);
    if (runLog) log(`  run log:   ${runLog}`);
    if (telegram) log(`  telegram:  tasks waiting for the user are sent to chat ${chatId}`);
    if (!local) {
      log(
        '  WARNING: not bound to this machine only. Put TLS in front of it: the token travels with every connection.',
      );
    }
  });

  for (const signal of ['SIGINT', 'SIGTERM']) {
    process.on(signal, () => {
      void bridge.close().then(() => process.exit(0));
    });
  }
} else {
  console.error(`Unknown command: ${command}. Use install, uninstall, status, pair, or no command to run the bridge.`);
  process.exit(2);
}
