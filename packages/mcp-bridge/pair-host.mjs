#!/usr/bin/env node
/**
 * Chrome native messaging host for pairing (see pairing.mjs). Chrome starts it when the Nanobrowser extension
 * asks, sends one message and reads one answer: the bridge's address and token. Nothing else may be written
 * to stdout.
 *
 *   pair-host.mjs --port 8787 --token-file <path>
 */
import fs from 'node:fs';
import os from 'node:os';
import { parseArgs } from 'node:util';

const { values } = parseArgs({
  strict: false,
  options: { port: { type: 'string', default: '8787' }, 'token-file': { type: 'string' } },
});
const LITTLE_ENDIAN = os.endianness() === 'LE';

/** One message: its length as 32 bits in this computer's byte order, then that much JSON */
async function readMessage(stream) {
  let data = Buffer.alloc(0);
  for await (const chunk of stream) {
    data = Buffer.concat([data, chunk]);
    if (data.length < 4) continue;
    const length = LITTLE_ENDIAN ? data.readUInt32LE(0) : data.readUInt32BE(0);
    if (data.length >= 4 + length) return JSON.parse(data.subarray(4, 4 + length).toString('utf8'));
  }
  return null;
}

function writeMessage(message) {
  const body = Buffer.from(JSON.stringify(message), 'utf8');
  const head = Buffer.alloc(4);
  if (LITTLE_ENDIAN) head.writeUInt32LE(body.length, 0);
  else head.writeUInt32BE(body.length, 0);
  return new Promise(resolve => process.stdout.write(Buffer.concat([head, body]), resolve));
}

let reply;
try {
  const message = await readMessage(process.stdin);
  if (message?.type !== 'pair') throw new Error('Unknown request');
  const token = fs.readFileSync(String(values['token-file']), 'utf8').trim();
  reply = { type: 'paired', url: `ws://localhost:${values.port}/extension`, token };
} catch (error) {
  reply = { type: 'error', error: error.message };
}
await writeMessage(reply);
process.exit(0);
