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

`install` prints the token and the settings to enter once in the extension. The installed bridge runs with
`--launch-browser`: when an agent calls and no browser is connected, it starts Chrome without a window
(`--no-startup-window`) and waits up to 30 s for the extension to connect. The extension keeps Chrome
running in the background after its windows are closed (the `background` permission; on Windows the Chrome
setting "Continue running background apps when Google Chrome is closed" must stay on). A task that finds no
browser window opens one without taking the focus. Set `NANOBROWSER_CHROME` to Chrome's path when it is
installed somewhere else.

Keep the repository where it is after installing: the service runs `cli.mjs` from it. Run `install` again
after moving it.

## Connect the browser

In the extension settings, open **Remote**:

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
| `run_task`    | Start a task described in plain language. Returns when it ends or after `wait_seconds` (default 25). |
| `get_task`    | State, result and latest steps of a task; waits up to `wait_seconds` for it to end.         |
| `cancel_task` | Stop a running task.                                                                       |
| `status`      | Whether a browser is connected and whether it is busy.                                     |

A task is `running`, `waiting_user`, `waiting_confirmation`, `completed`, `failed` or `cancelled`.

## What a remote agent can and cannot do

- One task at a time. While the user runs a task of their own, `run_task` is refused; a task the user
  starts in the side panel takes over from a remote one.
- When a task needs the user (a code sent to their phone, a captcha, approval of a sensitive action), it
  waits: the user gets a notification that opens the side panel, and answers there. After 10 minutes
  without an answer the task goes on without them; an action waiting for approval is then not taken.
- The site access rules of the extension apply to remote tasks as well.
- Remote tasks are not read for things to remember about the user.
- An open side panel shows a remote task as a chat of its own, and its stop button ends it.

## Tests

```bash
pnpm -F @extension/mcp-bridge test
```
