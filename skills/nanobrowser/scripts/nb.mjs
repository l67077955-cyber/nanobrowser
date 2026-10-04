#!/usr/bin/env node
/**
 * Call the Nanobrowser bridge from a shell, for agents without an MCP client.
 *
 *   node nb.mjs status
 *   node nb.mjs run "<task>" [--wait 120]
 *   node nb.mjs get <task_id> [--wait 120]
 *   node nb.mjs cancel <task_id>
 *
 * NANOBROWSER_MCP_URL (default http://localhost:8787/mcp) and NANOBROWSER_BRIDGE_TOKEN, or the token file
 * ~/.config/nanobrowser/bridge-token. Prints the tool's JSON result; exits 1 when the tool reports an error.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseArgs } from 'node:util';

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: { wait: { type: 'string' } },
});

const url = process.env.NANOBROWSER_MCP_URL ?? 'http://localhost:8787/mcp';
function token() {
  if (process.env.NANOBROWSER_BRIDGE_TOKEN) return process.env.NANOBROWSER_BRIDGE_TOKEN;
  const file = path.join(os.homedir(), '.config', 'nanobrowser', 'bridge-token');
  try {
    return fs.readFileSync(file, 'utf8').trim();
  } catch {
    console.error(`No token: set NANOBROWSER_BRIDGE_TOKEN or create ${file}`);
    process.exit(2);
  }
}

const [command, arg] = positionals;
const wait = values.wait === undefined ? {} : { wait_seconds: Number(values.wait) };
const calls = {
  status: () => ['status', {}],
  run: () => ['run_task', { task: arg, ...wait }],
  get: () => ['get_task', { task_id: arg, ...wait }],
  cancel: () => ['cancel_task', { task_id: arg }],
};
if (!calls[command] || (command !== 'status' && !arg)) {
  console.error('Usage: nb.mjs status | run "<task>" [--wait N] | get <task_id> [--wait N] | cancel <task_id>');
  process.exit(2);
}
const [name, args] = calls[command]();

let response;
try {
  response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token()}` },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }),
  });
} catch (error) {
  console.error(`The bridge is not reachable at ${url} (${error.cause?.code ?? error.message}). Is it running?`);
  process.exit(1);
}
if (response.status === 401) {
  console.error('The bridge refused the token.');
  process.exit(1);
}
const body = await response.json();
const result = body.result;
if (!result) {
  console.error(JSON.stringify(body.error ?? body));
  process.exit(1);
}
console.log(result.content?.[0]?.text ?? '');
process.exit(result.isError ? 1 : 0);
