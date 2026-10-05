import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import WebSocket from 'ws';
import { createBridge, CLOSE_UNAUTHORIZED } from './bridge.mjs';

const TOKEN = 'test-token-0123456789';

async function startBridge(options = {}) {
  const bridge = createBridge({ token: TOKEN, pingIntervalMs: 50, requestTimeoutMs: 500, ...options });
  bridge.server.listen(0, '127.0.0.1');
  await once(bridge.server, 'listening');
  const { port } = bridge.server.address();
  return { bridge, port };
}

/** A browser on the bridge; `onRequest` answers what the bridge asks of it; `hello` adds to what it presents */
async function connectBrowser(port, onRequest, token = TOKEN, hello = {}) {
  const socket = new WebSocket(`ws://127.0.0.1:${port}/extension`, { origin: 'chrome-extension://abc' });
  const ready = new Promise((resolve, reject) => {
    socket.on('message', data => {
      const message = JSON.parse(data.toString());
      if (message.type === 'hello_ack') resolve();
      if (message.type === 'ping') socket.send(JSON.stringify({ type: 'pong' }));
      if (message.type === 'request') {
        new Promise(resolve => resolve(onRequest(message.method, message.params, socket))).then(
          result => socket.send(JSON.stringify({ type: 'response', id: message.id, result })),
          error => socket.send(JSON.stringify({ type: 'response', id: message.id, error: error.message })),
        );
      }
    });
    socket.on('close', code => reject(new Error(`closed ${code}`)));
  });
  await once(socket, 'open');
  socket.send(JSON.stringify({ type: 'hello', token, version: '0.1.13', ...hello }));
  await ready;
  return socket;
}

let rpcId = 1;
async function rpc(port, method, params, headers = { Authorization: `Bearer ${TOKEN}` }) {
  const response = await fetch(`http://127.0.0.1:${port}/mcp`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', ...headers },
    body: JSON.stringify({ jsonrpc: '2.0', id: rpcId++, method, params }),
  });
  return { status: response.status, body: response.status === 200 ? await response.json() : null };
}

async function tool(port, name, args = {}) {
  const { body } = await rpc(port, 'tools/call', { name, arguments: args });
  const text = body.result.content[0].text;
  return body.result.isError ? { error: text } : JSON.parse(text);
}

/** Every content block of a tool's result */
async function toolContent(port, name, args = {}) {
  const { body } = await rpc(port, 'tools/call', { name, arguments: args });
  return body.result.content;
}

test('an agent without the token is turned away', async t => {
  const { bridge, port } = await startBridge();
  t.after(() => bridge.close());
  assert.equal((await rpc(port, 'tools/list', {}, {})).status, 401);
  assert.equal((await rpc(port, 'tools/list', {}, { Authorization: 'Bearer wrong-token-0123456789' })).status, 401);
});

test('a web page cannot call the bridge even with the token', async t => {
  const { bridge, port } = await startBridge();
  t.after(() => bridge.close());
  const reply = await rpc(port, 'tools/list', {}, { Authorization: `Bearer ${TOKEN}`, Origin: 'https://evil.example' });
  assert.equal(reply.status, 403);
});

test('a browser with a wrong token is closed and never becomes the browser in use', async t => {
  const { bridge, port } = await startBridge();
  t.after(() => bridge.close());
  await assert.rejects(
    connectBrowser(port, () => ({}), 'wrong-token-0123456789'),
    new RegExp(String(CLOSE_UNAUTHORIZED)),
  );
  assert.deepEqual(await tool(port, 'status'), { connected: false });
});

test('the MCP handshake lists the tools', async t => {
  const { bridge, port } = await startBridge();
  t.after(() => bridge.close());
  const init = await rpc(port, 'initialize', { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: {} });
  assert.equal(init.body.result.protocolVersion, '2025-03-26');
  assert.equal(init.body.result.serverInfo.name, 'nanobrowser');

  const notified = await fetch(`http://127.0.0.1:${port}/mcp`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${TOKEN}` },
    body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }),
  });
  assert.equal(notified.status, 202);

  const list = await rpc(port, 'tools/list', {});
  assert.deepEqual(
    list.body.result.tools.map(one => one.name),
    ['run_task', 'get_task', 'answer_task', 'cancel_task', 'status'],
  );
});

test('run_task without a browser says so', async t => {
  const { bridge, port } = await startBridge();
  t.after(() => bridge.close());
  assert.match((await tool(port, 'run_task', { task: 'open example.com' })).error, /No browser is connected/);
});

test('a task runs to its end and the agent gets the answer', async t => {
  const { bridge, port } = await startBridge();
  t.after(() => bridge.close());
  const browser = await connectBrowser(port, (method, params, socket) => {
    assert.equal(method, 'run_task');
    assert.equal(params.task, 'what is the title of example.com');
    const say = message => socket.send(JSON.stringify({ taskId: 't1', ...message }));
    setTimeout(() => {
      say({ type: 'event', actor: 'navigator', state: 'act.ok', step: 1, details: 'Navigated to example.com' });
      say({ type: 'task_end', status: 'completed', result: 'Example Domain' });
    }, 30);
    return { taskId: 't1' };
  });
  t.after(() => browser.close());

  const done = await tool(port, 'run_task', { task: 'what is the title of example.com', wait_seconds: 5 });
  assert.equal(done.task_id, 't1');
  assert.equal(done.status, 'completed');
  assert.equal(done.result, 'Example Domain');
  assert.deepEqual(done.recent_steps, ['navigator act.ok: Navigated to example.com']);
});

test('every start, step and end of a task is recorded for the run log', async t => {
  const records = [];
  const { bridge, port } = await startBridge({ record: entry => records.push(entry) });
  t.after(() => bridge.close());
  const browser = await connectBrowser(port, (method, params, socket) => {
    const say = message => socket.send(JSON.stringify({ taskId: 't1', ...message }));
    setTimeout(() => {
      say({ type: 'event', actor: 'planner', state: 'step.start', step: 1, details: '' });
      say({ type: 'event', actor: 'navigator', state: 'act.ok', step: 1, details: 'Navigated to example.com' });
      say({ type: 'task_end', status: 'completed', result: 'Example Domain' });
    }, 30);
    return { taskId: 't1' };
  });
  t.after(() => browser.close());

  await tool(port, 'run_task', { task: 'what is the title of example.com', wait_seconds: 5 });
  assert.deepEqual(
    records.map(({ t: time, ...entry }) => (assert.equal(typeof time, 'number'), entry)),
    [
      { kind: 'start', taskId: 't1', text: 'what is the title of example.com', browser: 'browser' },
      { kind: 'event', taskId: 't1', actor: 'planner', state: 'step.start', step: 1, details: '' },
      {
        kind: 'event',
        taskId: 't1',
        actor: 'navigator',
        state: 'act.ok',
        step: 1,
        details: 'Navigated to example.com',
      },
      { kind: 'end', taskId: 't1', status: 'completed', result: 'Example Domain' },
    ],
  );
});

test('a long task is returned as running and followed with get_task', async t => {
  const { bridge, port } = await startBridge();
  t.after(() => bridge.close());
  let cancelled = false;
  const browser = await connectBrowser(port, (method, params, socket) => {
    if (method === 'status') return { busy: true, taskId: 't2' };
    if (method === 'cancel_task') {
      cancelled = true;
      socket.send(JSON.stringify({ type: 'task_end', taskId: params.taskId, status: 'cancelled', result: 'stopped' }));
      return { cancelled: true };
    }
    setTimeout(() => {
      const event = {
        type: 'event',
        taskId: 't2',
        actor: 'navigator',
        state: 'act.confirm',
        step: 2,
        details: 'Click "Send"',
      };
      socket.send(JSON.stringify(event));
    }, 20);
    return { taskId: 't2' };
  });
  t.after(() => browser.close());

  const started = await tool(port, 'run_task', { task: 'send the mail', wait_seconds: 0 });
  assert.equal(started.status, 'running');
  assert.equal(started.result, undefined);

  const waiting = await tool(port, 'get_task', { task_id: 't2', wait_seconds: 0.1 });
  assert.equal(waiting.status, 'waiting_confirmation');
  assert.deepEqual(await tool(port, 'status'), {
    connected: true,
    extension_version: '0.1.13',
    busy: true,
    task_id: 't2',
    browsers: [
      {
        name: 'browser',
        id: 'browser',
        platform: null,
        extension_version: '0.1.13',
        busy: true,
        task_id: 't2',
        default: true,
      },
    ],
  });

  const stopped = await tool(port, 'cancel_task', { task_id: 't2' });
  assert.equal(cancelled, true);
  assert.equal(stopped.status, 'cancelled');
  assert.match((await tool(port, 'get_task', { task_id: 'nope' })).error, /No task/);
});

test('a busy browser refuses and the agent is told why', async t => {
  const { bridge, port } = await startBridge();
  t.after(() => bridge.close());
  const browser = await connectBrowser(port, () => {
    throw new Error('The browser is busy with another task');
  });
  t.after(() => browser.close());
  assert.deepEqual(await tool(port, 'run_task', { task: 'anything' }), {
    error: 'The browser is busy with another task',
  });
});

test('a task whose browser goes away fails instead of hanging', async t => {
  const { bridge, port } = await startBridge();
  t.after(() => bridge.close());
  const browser = await connectBrowser(port, () => ({ taskId: 't3' }));
  setTimeout(() => browser.close(), 50);
  const lost = await tool(port, 'run_task', { task: 'something slow', wait_seconds: 5 });
  assert.equal(lost.status, 'failed');
  assert.match(lost.result, /disconnected/);
});

test('the browser is pinged so that its service worker stays awake', async t => {
  const { bridge, port } = await startBridge();
  t.after(() => bridge.close());
  const browser = await connectBrowser(port, () => ({}));
  t.after(() => browser.close());
  const [data] = await once(browser, 'message');
  assert.equal(JSON.parse(data.toString()).type, 'ping');
});

test('a browser that is not connected is started, and the task waits for it', async t => {
  let port;
  let browser;
  const startBrowser = () => {
    setTimeout(async () => {
      browser = await connectBrowser(port, method => (method === 'run_task' ? { taskId: 't-started' } : {}));
    }, 50);
  };
  const started = await startBridge({ startBrowser, browserStartMs: 2000 });
  port = started.port;
  t.after(() => {
    browser?.close();
    return started.bridge.close();
  });
  const task = await tool(port, 'run_task', { task: 'open example.com', wait_seconds: 0 });
  assert.equal(task.task_id, 't-started');
});

test('a browser that does not come up in time is reported as missing', async t => {
  const { bridge, port } = await startBridge({ startBrowser: () => {}, browserStartMs: 100 });
  t.after(() => bridge.close());
  const reply = await tool(port, 'run_task', { task: 'open example.com' });
  assert.match(reply.error, /No browser is connected/);
});

test('a task that asks the user is reported as waiting for them, and running again once answered', async t => {
  const { bridge, port } = await startBridge();
  t.after(() => bridge.close());
  let say;
  const browser = await connectBrowser(port, (method, params, socket) => {
    say = message => socket.send(JSON.stringify({ taskId: 't-ask', ...message }));
    return { taskId: 't-ask' };
  });
  t.after(() => browser.close());
  await tool(port, 'run_task', { task: 'sign in', wait_seconds: 0 });
  say({ type: 'event', actor: 'navigator', state: 'act.ask', step: 2, details: 'The SMS code?' });
  await new Promise(resolve => setTimeout(resolve, 50));
  say({ type: 'event', actor: 'planner', state: 'step.ok', step: 2, details: 'Waiting for the code' });
  await new Promise(resolve => setTimeout(resolve, 50));
  const waiting = await tool(port, 'get_task', { task_id: 't-ask', wait_seconds: 0 });
  assert.equal(waiting.status, 'waiting_user');
  assert.deepEqual(waiting.recent_steps, ['navigator act.ask: The SMS code?', 'planner step.ok: Waiting for the code']);
  say({ type: 'event', actor: 'navigator', state: 'act.ok', step: 3, details: 'Typed the code' });
  await new Promise(resolve => setTimeout(resolve, 50));
  assert.equal((await tool(port, 'get_task', { task_id: 't-ask', wait_seconds: 0 })).status, 'running');
});

test('the user is told what a task waits for, with the page, and their answer goes to the browser', async t => {
  const waits = [];
  const overs = [];
  const { bridge, port } = await startBridge({
    onWaiting: task => waits.push({ id: task.id, ...task.waiting }),
    onWaitingOver: task => overs.push(task.id),
  });
  t.after(() => bridge.close());
  let say;
  const answers = [];
  const browser = await connectBrowser(port, (method, params, socket) => {
    say = message => socket.send(JSON.stringify({ taskId: 't-code', ...message }));
    if (method === 'answer_task') answers.push(params);
    return method === 'run_task' ? { taskId: 't-code' } : { answered: true };
  });
  t.after(() => browser.close());

  assert.match((await tool(port, 'answer_task', { task_id: 'nope', answer: '1' })).error, /No task/);
  await tool(port, 'run_task', { task: 'sign in', wait_seconds: 0 });
  assert.match((await tool(port, 'answer_task', { task_id: 't-code', answer: '1' })).error, /not waiting/);

  say({
    type: 'event',
    actor: 'navigator',
    state: 'act.ask',
    step: 2,
    details: 'The SMS code?',
    fields: ['code'],
    screenshot: 'AAAA',
  });
  await new Promise(resolve => setTimeout(resolve, 50));
  assert.deepEqual(waits, [{ id: 't-code', question: 'The SMS code?', fields: ['code'], screenshot: 'AAAA' }]);
  assert.equal((await tool(port, 'get_task', { task_id: 't-code', wait_seconds: 0 })).question, 'The SMS code?');

  const answered = await tool(port, 'answer_task', { task_id: 't-code', answer: '123456' });
  assert.equal(answered.status, 'running');
  assert.deepEqual(answers, [{ taskId: 't-code', answer: '123456' }]);
  assert.deepEqual(overs, ['t-code']);
});

test('a waiting task shows its page once, as an image next to the question and its fields', async t => {
  const { bridge, port } = await startBridge();
  t.after(() => bridge.close());
  let say;
  const browser = await connectBrowser(port, (method, params, socket) => {
    say = message => socket.send(JSON.stringify({ taskId: 't-qr', ...message }));
    return { taskId: 't-qr' };
  });
  t.after(() => browser.close());
  await tool(port, 'run_task', { task: 'sign in', wait_seconds: 0 });
  say({
    type: 'event',
    actor: 'navigator',
    state: 'act.ask',
    step: 1,
    details: 'Scan the QR code',
    screenshot: 'QUJD',
  });
  await new Promise(resolve => setTimeout(resolve, 50));

  const first = await toolContent(port, 'get_task', { task_id: 't-qr', wait_seconds: 0 });
  assert.deepEqual(first[1], { type: 'image', data: 'QUJD', mimeType: 'image/jpeg' });
  const described = JSON.parse(first[0].text);
  assert.equal(described.question, 'Scan the QR code');
  assert.deepEqual(described.fields, []);
  // the agent has the page: polling again does not send it again
  assert.equal((await toolContent(port, 'get_task', { task_id: 't-qr', wait_seconds: 0 })).length, 1);
});

test('browsers with ids of their own are all kept, and tasks go to the one asked for or the default', async t => {
  const { bridge, port } = await startBridge({ hostPlatform: 'linux' });
  t.after(() => bridge.close());
  const ran = [];
  const answer = name => method => {
    if (method === 'run_task') ran.push(name);
    return method === 'run_task' ? { taskId: `t-${name}-${ran.length}` } : { busy: false, taskId: null };
  };
  const server = await connectBrowser(port, answer('server'), TOKEN, { id: 's1', name: 'server', platform: 'linux' });
  const laptop = await connectBrowser(port, answer('laptop'), TOKEN, { id: 'l1', name: 'laptop', platform: 'win' });
  t.after(() => {
    server.close();
    laptop.close();
  });

  const status = await tool(port, 'status');
  assert.deepEqual(
    status.browsers.map(({ name, id, platform, default: chosen }) => ({ name, id, platform, chosen })),
    [
      { name: 'server', id: 's1', platform: 'linux', chosen: undefined },
      { name: 'laptop', id: 'l1', platform: 'win', chosen: true },
    ],
  );
  // a browser on another system than the bridge's is the user's own computer: it comes first
  assert.equal((await tool(port, 'run_task', { task: 'a', wait_seconds: 0 })).browser, 'laptop');
  assert.equal((await tool(port, 'run_task', { task: 'b', wait_seconds: 0, browser: 'server' })).browser, 'server');
  assert.equal((await tool(port, 'run_task', { task: 'c', wait_seconds: 0, browser: 'l1' })).browser, 'laptop');
  assert.deepEqual(ran, ['laptop', 'server', 'laptop']);
  assert.match((await tool(port, 'run_task', { task: 'd', browser: 'phone' })).error, /phone.*server, laptop/);
});

test('the browsers named with prefer come first', async t => {
  const { bridge, port } = await startBridge({ hostPlatform: 'linux', prefer: ['server'] });
  t.after(() => bridge.close());
  const run = () => ({ taskId: 't-p' });
  const server = await connectBrowser(port, run, TOKEN, { id: 's1', name: 'server', platform: 'linux' });
  const laptop = await connectBrowser(port, run, TOKEN, { id: 'l1', name: 'laptop', platform: 'win' });
  t.after(() => {
    server.close();
    laptop.close();
  });
  assert.equal((await tool(port, 'run_task', { task: 'a', wait_seconds: 0 })).browser, 'server');
});

test('the same browser connecting again replaces its old connection, and the task it was running fails', async t => {
  const { bridge, port } = await startBridge();
  t.after(() => bridge.close());
  const first = await connectBrowser(port, () => ({ taskId: 't-r' }), TOKEN, {
    id: 'same',
    name: 'pc',
    platform: 'win',
  });
  const closed = once(first, 'close');
  const task = await tool(port, 'run_task', { task: 'slow', wait_seconds: 0 });
  assert.equal(task.status, 'running');
  const second = await connectBrowser(port, () => ({ busy: false }), TOKEN, {
    id: 'same',
    name: 'pc',
    platform: 'win',
  });
  t.after(() => second.close());
  const [code] = await closed;
  assert.equal(code, 4409);
  assert.equal((await tool(port, 'status')).browsers.length, 1);
  assert.equal((await tool(port, 'get_task', { task_id: 't-r', wait_seconds: 0 })).status, 'failed');
});
