#!/usr/bin/env node
/**
 * Start the Nanobrowser MCP bridge, or have it run in the background from login on.
 *
 *   node cli.mjs [--port 8787] [--host 127.0.0.1] [--token-file <path>] [--launch-browser]
 *   node cli.mjs install [same options]     run it in the background from login on, and now
 *   node cli.mjs uninstall                  stop that and remove it
 *   node cli.mjs status                     whether it is installed and running
 *
 * The token comes from NANOBROWSER_BRIDGE_TOKEN or from the token file, which is created on first start.
 * With --launch-browser, Chrome is started without a window when an agent needs the browser and none is
 * connected; `install` turns it on.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { createBridge } from './bridge.mjs';
import { findChrome, installService, launchChrome, serviceStatus, uninstallService } from './service.mjs';

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    port: { type: 'string', default: process.env.NANOBROWSER_BRIDGE_PORT ?? '8787' },
    host: { type: 'string', default: process.env.NANOBROWSER_BRIDGE_HOST ?? '127.0.0.1' },
    'token-file': { type: 'string', default: path.join(os.homedir(), '.config', 'nanobrowser', 'bridge-token') },
    'launch-browser': { type: 'boolean', default: false },
  },
});

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

function printConnection(token, source) {
  console.log(`
Connect the browser (once): Nanobrowser settings > Remote
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
  const { token, source } = loadToken(values['token-file']);
  const args = [
    fileURLToPath(import.meta.url),
    '--port',
    values.port,
    '--host',
    values.host,
    '--token-file',
    values['token-file'],
    '--launch-browser',
  ];
  const { file, log } = installService(args);
  console.log(`Installed: the bridge now runs in the background and starts again at every login.
  service  ${file}
  log      ${log}`);
  if (!findChrome())
    console.log('  Chrome was not found: set NANOBROWSER_CHROME to its path for it to be started on demand.');
  printConnection(token, source);
} else if (command === 'uninstall') {
  console.log(uninstallService() ? 'Removed: the bridge no longer runs in the background.' : 'It was not installed.');
} else if (command === 'status') {
  const { installed, file, log } = serviceStatus();
  console.log(`installed  ${installed ? `yes (${file})` : 'no'}`);
  console.log(`running    ${(await isListening()) ? `yes, on ${values.host}:${values.port}` : 'no'}`);
  if (installed) console.log(`log        ${log}`);
} else if (command === 'serve') {
  const { token, source } = loadToken(values['token-file']);
  const log = (...args) => console.log(new Date().toISOString(), ...args);
  const chrome = values['launch-browser'] ? findChrome() : null;
  if (values['launch-browser'] && !chrome)
    log('Chrome not found: set NANOBROWSER_CHROME; it will not be started on demand');
  const bridge = createBridge({ token, log, startBrowser: chrome ? () => launchChrome(chrome) : undefined });

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
    if (chrome) log(`  browser:   started on demand (${chrome})`);
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
  console.error(`Unknown command: ${command}. Use install, uninstall, status, or no command to run the bridge.`);
  process.exit(2);
}
