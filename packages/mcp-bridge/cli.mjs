#!/usr/bin/env node
/**
 * Start the Nanobrowser MCP bridge.
 *
 *   node cli.mjs [--port 8787] [--host 127.0.0.1] [--token-file <path>]
 *
 * The token comes from NANOBROWSER_BRIDGE_TOKEN or from the token file, which is created on first start.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { parseArgs } from 'node:util';
import { createBridge } from './bridge.mjs';

const { values } = parseArgs({
  options: {
    port: { type: 'string', default: process.env.NANOBROWSER_BRIDGE_PORT ?? '8787' },
    host: { type: 'string', default: process.env.NANOBROWSER_BRIDGE_HOST ?? '127.0.0.1' },
    'token-file': { type: 'string', default: path.join(os.homedir(), '.config', 'nanobrowser', 'bridge-token') },
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

const { token, source } = loadToken(values['token-file']);
const log = (...args) => console.log(new Date().toISOString(), ...args);
const bridge = createBridge({ token, log });

bridge.server.listen(Number(values.port), values.host, () => {
  const local = ['127.0.0.1', 'localhost', '::1'].includes(values.host);
  log(`Nanobrowser bridge listening on ${values.host}:${values.port}`);
  log(`  extension: ws://${values.host}:${values.port}/extension`);
  log(`  agents:    http://${values.host}:${values.port}/mcp  (Authorization: Bearer <token>)`);
  log(`  token:     ${source}`);
  if (!local) {
    log('  WARNING: not bound to this machine only. Put TLS in front of it: the token travels with every connection.');
  }
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    void bridge.close().then(() => process.exit(0));
  });
}
