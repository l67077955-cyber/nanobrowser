import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { extensionIdForPath, hostLauncher, hostLocations, hostManifest, HOST_NAME } from './pairing.mjs';

test('the extension id is the one Chrome gives the unpacked folder', () => {
  // as Edge reported it for the extension loaded from this path
  assert.equal(extensionIdForPath('/root/projects/nanobrowser/dist', 'linux'), 'kneeidnagemgdllpegdkcmpeiihpablp');
  // Windows holds the path as UTF-16 with an upper-case drive letter
  assert.equal(extensionIdForPath('c:\\code\\dist', 'win32'), extensionIdForPath('C:\\code\\dist', 'win32'));
  assert.notEqual(extensionIdForPath('C:\\code\\dist', 'win32'), extensionIdForPath('C:\\code\\dist', 'linux'));
  assert.match(extensionIdForPath('C:\\code\\dist', 'win32'), /^[a-p]{32}$/);
});

test('the manifest goes where Chrome, Edge, Chromium and the profiles named look for it', () => {
  const linux = hostLocations('linux', '/home/me', {}, ['/srv/edge-profile']);
  assert.deepEqual(linux.manifests, [
    `/home/me/.config/google-chrome/NativeMessagingHosts/${HOST_NAME}.json`,
    `/home/me/.config/chromium/NativeMessagingHosts/${HOST_NAME}.json`,
    `/home/me/.config/microsoft-edge/NativeMessagingHosts/${HOST_NAME}.json`,
    `/srv/edge-profile/NativeMessagingHosts/${HOST_NAME}.json`,
  ]);
  assert.equal(linux.launcher, '/home/me/.local/share/nanobrowser/pair-host.sh');

  const windows = hostLocations('win32', 'C:\\Users\\me', { LOCALAPPDATA: 'C:\\Users\\me\\AppData\\Local' });
  assert.equal(windows.launcher, 'C:\\Users\\me\\AppData\\Local\\nanobrowser\\pair-host.cmd');
  assert.deepEqual(windows.registry, [
    `HKCU\\Software\\Google\\Chrome\\NativeMessagingHosts\\${HOST_NAME}`,
    `HKCU\\Software\\Microsoft\\Edge\\NativeMessagingHosts\\${HOST_NAME}`,
    `HKCU\\Software\\Chromium\\NativeMessagingHosts\\${HOST_NAME}`,
  ]);
});

test('the launcher starts node quietly, with the paths quoted', () => {
  const windows = hostLauncher('win32', {
    node: 'C:\\Program Files\\nodejs\\node.exe',
    script: 'C:\\nb\\pair-host.mjs',
    port: '8787',
    tokenFile: 'C:\\Users\\100%\\bridge-token',
  });
  assert.equal(
    windows,
    '@echo off\r\n"C:\\Program Files\\nodejs\\node.exe" "C:\\nb\\pair-host.mjs" --port 8787 --token-file "C:\\Users\\100%%\\bridge-token"\r\n',
  );
  const posix = hostLauncher('linux', {
    node: '/usr/bin/node',
    script: "/it's/pair-host.mjs",
    port: '8787',
    tokenFile: '/t',
  });
  assert.match(posix, /^#!\/bin\/sh\n/);
  assert.match(posix, /^exec '\/usr\/bin\/node' '\/it'\\''s\/pair-host\.mjs' '--port' '8787' '--token-file' '\/t'$/m);
});

test('the manifest lets only the extensions given start the host', () => {
  const manifest = JSON.parse(hostManifest({ launcher: '/x/pair-host.sh', extensionIds: ['abc', 'def'] }));
  assert.equal(manifest.name, HOST_NAME);
  assert.equal(manifest.type, 'stdio');
  assert.equal(manifest.path, '/x/pair-host.sh');
  assert.deepEqual(manifest.allowed_origins, ['chrome-extension://abc/', 'chrome-extension://def/']);
});

test('the host answers a pairing request with the address and the token, in native messaging framing', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nb-pair-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const tokenFile = path.join(dir, 'bridge-token');
  fs.writeFileSync(tokenFile, 'token-0123456789abcdef\n');

  const host = spawn(process.execPath, [
    new URL('./pair-host.mjs', import.meta.url).pathname,
    '--port',
    '9999',
    '--token-file',
    tokenFile,
    // Chrome adds the caller's origin
    'chrome-extension://abc/',
  ]);
  const body = Buffer.from(JSON.stringify({ type: 'pair' }));
  const head = Buffer.alloc(4);
  head.writeUInt32LE(body.length, 0);
  host.stdin.write(Buffer.concat([head, body]));

  const chunks = [];
  host.stdout.on('data', chunk => chunks.push(chunk));
  await once(host, 'exit');
  const out = Buffer.concat(chunks);
  assert.equal(out.readUInt32LE(0), out.length - 4);
  assert.deepEqual(JSON.parse(out.subarray(4).toString()), {
    type: 'paired',
    url: 'ws://localhost:9999/extension',
    token: 'token-0123456789abcdef',
  });
});
