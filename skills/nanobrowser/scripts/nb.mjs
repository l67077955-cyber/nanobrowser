#!/usr/bin/env node
/**
 * Call the Nanobrowser bridge from a shell, for agents without an MCP client.
 *
 *   node nb.mjs status
 *   node nb.mjs run "<task>" [--wait 120] [--browser <name>]
 *   node nb.mjs get <task_id> [--wait 120]
 *   node nb.mjs answer <task_id> "<the user's reply>"      or  answer <task_id> --approve | --decline
 *   node nb.mjs cancel <task_id>
 *
 * NANOBROWSER_MCP_URL (default http://localhost:8787/mcp) and NANOBROWSER_BRIDGE_TOKEN, or the token file
 * ~/.config/nanobrowser/bridge-token. Prints the tool's JSON result; exits 1 when the tool reports an error.
 * A task waiting for the user comes with a screenshot of the page once: it is saved to a file, whose path is
 * added to the JSON as screenshot_file.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseArgs } from 'node:util';

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    wait: { type: 'string' },
    browser: { type: 'string' },
    approve: { type: 'boolean', default: false },
    decline: { type: 'boolean', default: false },
  },
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

const [command, arg, reply] = positionals;
const wait = values.wait === undefined ? {} : { wait_seconds: Number(values.wait) };
const decision = values.approve ? { approve: true } : values.decline ? { approve: false } : {};
const calls = {
  status: () => ['status', {}],
  run: () => ['run_task', { task: arg, ...wait, ...(values.browser ? { browser: values.browser } : {}) }],
  get: () => ['get_task', { task_id: arg, ...wait }],
  answer: () => ['answer_task', { task_id: arg, answer: reply ?? '', ...decision }],
  cancel: () => ['cancel_task', { task_id: arg }],
};
const incomplete =
  (command !== 'status' && !arg) || (command === 'answer' && reply === undefined && !values.approve && !values.decline);
if (!calls[command] || incomplete) {
  console.error(
    'Usage: nb.mjs status | run "<task>" [--wait N] [--browser <name>] | get <task_id> [--wait N]\n' +
      '       | answer <task_id> "<reply>" | answer <task_id> --approve|--decline | cancel <task_id>',
  );
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
const text = result.content?.find(part => part.type === 'text')?.text ?? '';
const image = result.content?.find(part => part.type === 'image');
if (image && !result.isError) {
  // the page the task shows while it waits for the user: for passing on to them
  const described = JSON.parse(text);
  const file = path.join(os.tmpdir(), `nanobrowser-${described.task_id ?? 'page'}-${Date.now()}.jpg`);
  fs.writeFileSync(file, Buffer.from(image.data, 'base64'));
  console.log(JSON.stringify({ ...described, screenshot_file: file }, null, 2));
} else {
  console.log(text);
}
process.exit(result.isError ? 1 : 0);
