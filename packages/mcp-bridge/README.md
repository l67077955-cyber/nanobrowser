# Nanobrowser MCP bridge

Lets other agents run tasks in a browser that has the Nanobrowser extension, as MCP tools.

```
agent (Claude Code, nanobot, …) ──MCP over HTTP──▶ bridge ◀──WebSocket── Nanobrowser extension
```

An extension cannot listen on a port, so it connects out to the bridge. The bridge can run on the same
computer as the browser or on another one the browser can reach.

## Start the bridge

```bash
node packages/mcp-bridge/cli.mjs            # 127.0.0.1:8787
node packages/mcp-bridge/cli.mjs --port 9000 --host 127.0.0.1 --token-file /path/to/token
```

On first start it creates a token in `~/.config/nanobrowser/bridge-token` (or takes
`NANOBROWSER_BRIDGE_TOKEN`). Both the extension and the agents present this token.

## Run it in the background on your computer

To have agents reach the browser at any time without starting anything by hand, install the bridge on the
computer with the browser:

```bash
node packages/mcp-bridge/cli.mjs install     # runs now and from every login on; restarted if it stops
node packages/mcp-bridge/cli.mjs status      # installed? listening?
node packages/mcp-bridge/cli.mjs uninstall
```

| System  | How it runs                                              | Log                                         |
| ------- | -------------------------------------------------------- | ------------------------------------------- |
| Windows | hidden launcher in the Startup folder (no admin rights)  | `%LOCALAPPDATA%\nanobrowser\bridge.log`     |
| macOS   | LaunchAgent `com.nanobrowser.bridge`                     | `~/Library/Logs/nanobrowser-bridge.log`     |
| Linux   | systemd user service `nanobrowser-bridge`                | `~/.local/state/nanobrowser/bridge.log`     |

`install` also pairs the extension on this computer (see [Connect the browser](#connect-the-browser)) and prints
the token. Options given to `install` (`--launch-cmd`, `--prefer`, `--run-log`, `--telegram-chat`) are kept
for the service. The installed bridge runs with
`--launch-browser`: when an agent calls and no browser is connected, it starts Chrome without a window
(`--no-startup-window`) and waits up to 60 s for the extension to connect. The extension keeps Chrome
running in the background after its windows are closed (the `background` permission; on Windows the Chrome
setting "Continue running background apps when Google Chrome is closed" must stay on). A task that finds no
browser window opens one without taking the focus. Set `NANOBROWSER_CHROME` to Chrome's path when it is
installed somewhere else.

A browser the bridge started stays open when the bridge stops or restarts.

Keep the repository where it is after installing: the service runs `cli.mjs` from it. Run `install` again
after moving it.

### A browser on a server

A server without a screen keeps a browser of its own, with its own profile, and the extension cannot stay
installed there (Chrome and Edge ignore `--load-extension`). `start-browser.mjs` starts Xvfb, the browser
with a DevTools port, and loads the extension through that port; a browser already running is left as it is.
Give it to the bridge as `--launch-cmd`, and the first task after a reboot brings the browser up:

```bash
node packages/mcp-bridge/cli.mjs install --launch-cmd "node $PWD/packages/mcp-bridge/start-browser.mjs \
  --browser /usr/bin/microsoft-edge --profile ~/.config/edge-nb-profile --extension $PWD/dist --display :98"
```

After a build, `start-browser.mjs … --reload` loads the new extension into the running browser.

## Connect the browser

`install` pairs the extension on the same computer: it writes a Chrome native messaging host
(`com.nanobrowser.bridge`, for Chrome, Edge and Chromium) that hands the extension the bridge's address and
token. An extension with no bridge set asks for them when it starts, and turns remote tasks on. The host only
answers the extension loaded unpacked from this repository's `dist/` (its id follows from the folder's path)
and the ids given with `--extension-id`. `node cli.mjs pair` pairs without installing the service;
`--profile <dir>` adds a profile started with a `--user-data-dir` of its own.

By hand, or when the bridge is on another computer, open **Remote** in the extension settings:

1. **Bridge address**: `ws://localhost:8787/extension` when the bridge is on the same computer.
2. **Token**: the content of the token file.
3. Save, then turn on **Allow remote tasks**. The status line shows `Connected to the bridge`.

When the bridge runs on another machine, do not expose the port. Forward it instead and keep the address
above:

```bash
ssh -L 8787:127.0.0.1:8787 user@server      # or forward port 8787 in VS Code's Ports panel
```

To reach it over the network without a tunnel, put a TLS reverse proxy in front and use `wss://`: the
token travels with every connection.

## Connect an agent

The MCP endpoint is `http://127.0.0.1:8787/mcp` with the header `Authorization: Bearer <token>`.

```bash
claude mcp add --transport http nanobrowser http://127.0.0.1:8787/mcp \
  --header "Authorization: Bearer $(cat ~/.config/nanobrowser/bridge-token)"
```

An MCP client that only speaks stdio (such as Claude Desktop's config file) can go through
[`mcp-remote`](https://www.npmjs.com/package/mcp-remote):
`npx mcp-remote http://localhost:8787/mcp --header "Authorization: Bearer <token>"`.

| Tool          | What it does                                                                               |
| ------------- | ------------------------------------------------------------------------------------------ |
| `run_task`    | Start a task described in plain language, in the default browser or the one named in `browser`. Returns when it ends or after `wait_seconds` (default 25). |
| `get_task`    | State, result and latest steps of a task; waits up to `wait_seconds` for it to end. A task waiting for the user says what it asks (`question`, `fields`) and brings a screenshot of the page once, as an image. |
| `answer_task` | Pass the user's reply to a waiting task (`answer`, or `approve` for an approval).            |
| `cancel_task` | Stop a running task.                                                                       |
| `status`      | The browsers connected (name, id, platform, busy) and the default one.                     |

A task is `running`, `waiting_user`, `waiting_confirmation`, `completed`, `failed` or `cancelled`.

### Several browsers

More than one browser can be connected, for example the user's computer and a browser on a server. Each
extension presents an id of its own (made once per profile) and a name, by default its operating system
(`win`, `mac`, `linux`). The same browser connecting again replaces its old connection; another one is kept
next to it. A task goes to the browser named in `browser`, else to the first of `--prefer name,…` that is
connected, else to a browser on another system than the bridge's, which is taken for the user's own
computer, else to the browser that connected last.

## What a remote agent can and cannot do

- One task at a time in each browser. While the user runs a task of their own, `run_task` is refused; a
  task the user starts in the side panel takes over from a remote one.
- When a task needs the user (a code sent to their phone, a captcha, a QR code, approval of a sensitive
  action), it waits. The agent can pass on the question and the page and give back the user's reply with
  `answer_task`; the user can also answer in the side panel, which a notification opens, or on Telegram
  with `--telegram-chat`. After 10 minutes without an answer the task goes on without them; an action
  waiting for approval is then not taken.
- The site access rules of the extension apply to remote tasks as well.
- Remote tasks are not read for things to remember about the user.
- An open side panel shows a remote task as a chat of its own, and its stop button ends it.

## See what the tasks did

Start the bridge with `--run-log ~/.config/nanobrowser/runs.jsonl` and every remote task's start, steps and end are
appended to that file. `viewer.mjs` shows it as a web page that updates itself:

```bash
node viewer.mjs --cdp http://127.0.0.1:9222   # --cdp: also show the browser's screen, if it has a DevTools port
```

Open the address it prints once (`http://127.0.0.1:8788/?key=…`); a cookie keeps you in. The key is its own
(`~/.config/nanobrowser/viewer-token`), not the bridge token, and the page only reads: it can be put behind a tunnel,
for example `cloudflared tunnel --url http://127.0.0.1:8788`.

## Tests

```bash
pnpm -F @extension/mcp-bridge test
```
