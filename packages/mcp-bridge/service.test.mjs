import { test } from 'node:test';
import assert from 'node:assert/strict';
import { findChrome, serviceFile, servicePaths } from './service.mjs';

const command = { node: '/usr/bin/node', args: ['/repo/cli.mjs', '--launch-browser'], log: '/tmp/bridge.log' };

test('the Windows launcher runs node hidden and starts it again when it stops', () => {
  const file = serviceFile('win32', {
    node: 'C:\\Program Files\\nodejs\\node.exe',
    args: ['C:\\nb\\cli.mjs'],
    log: 'C:\\Users\\me\\bridge.log',
  });
  assert.match(file, /^Do\r$/m);
  assert.match(file, /WScript\.Sleep 5000/);
  // inside a VBScript string every quote is doubled
  assert.ok(
    file.includes(
      'shell.Run "cmd /c """"C:\\Program Files\\nodejs\\node.exe"" ""C:\\nb\\cli.mjs"" >> ""C:\\Users\\me\\bridge.log"" 2>&1""", 0, True',
    ),
  );
});

test('the LaunchAgent starts at login and is kept alive', () => {
  const file = serviceFile('darwin', command);
  assert.match(file, /<key>RunAtLoad<\/key><true\/>/);
  assert.match(file, /<key>KeepAlive<\/key><true\/>/);
  assert.match(file, /<string>\/repo\/cli\.mjs<\/string>/);
});

test('the systemd unit restarts the bridge and logs to the file', () => {
  const file = serviceFile('linux', command);
  assert.match(file, /^ExecStart="\/usr\/bin\/node" "\/repo\/cli\.mjs" "--launch-browser"$/m);
  assert.match(file, /^Restart=always$/m);
  assert.match(file, /^StandardOutput=append:\/tmp\/bridge\.log$/m);
});

test('the Windows launcher goes into the Startup folder', () => {
  const { file } = servicePaths('win32', 'C:\\Users\\me', { APPDATA: 'C:\\Users\\me\\AppData\\Roaming' });
  assert.match(file, /Startup[\\/]nanobrowser-bridge\.vbs$/);
});

test('Chrome is looked for where it installs, and NANOBROWSER_CHROME wins', () => {
  assert.equal(
    findChrome('linux', { NANOBROWSER_CHROME: '/opt/chrome' }, () => false),
    '/opt/chrome',
  );
  assert.equal(
    findChrome('win32', { PROGRAMFILES: 'C:\\Program Files' }, candidate => candidate.startsWith('C:\\Program Files')),
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  );
  assert.equal(
    findChrome('linux', {}, () => false),
    null,
  );
});
