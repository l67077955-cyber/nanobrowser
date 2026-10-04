/**
 * Run the bridge in the background from login on, and start it again when it stops:
 *   - Windows: a hidden launcher in the Startup folder (no admin rights needed)
 *   - macOS:   a LaunchAgent
 *   - Linux:   a systemd user service
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawn } from 'node:child_process';

const NAME = 'nanobrowser-bridge';
const LABEL = 'com.nanobrowser.bridge';

/** Where the service keeps its files on this computer */
export function servicePaths(platform = process.platform, home = os.homedir(), env = process.env) {
  switch (platform) {
    case 'win32': {
      const appData = env.APPDATA ?? path.join(home, 'AppData', 'Roaming');
      const localAppData = env.LOCALAPPDATA ?? path.join(home, 'AppData', 'Local');
      return {
        file: path.join(appData, 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup', `${NAME}.vbs`),
        log: path.join(localAppData, 'nanobrowser', 'bridge.log'),
      };
    }
    case 'darwin':
      return {
        file: path.join(home, 'Library', 'LaunchAgents', `${LABEL}.plist`),
        log: path.join(home, 'Library', 'Logs', 'nanobrowser-bridge.log'),
      };
    default:
      return {
        file: path.join(env.XDG_CONFIG_HOME ?? path.join(home, '.config'), 'systemd', 'user', `${NAME}.service`),
        log: path.join(env.XDG_STATE_HOME ?? path.join(home, '.local', 'state'), 'nanobrowser', 'bridge.log'),
      };
  }
}

const vbsString = value => `"${value.replaceAll('"', '""')}"`;
const xml = value => value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
const systemdArg = value => `"${value.replaceAll('\\', '\\\\').replaceAll('"', '\\"')}"`;

/**
 * The service file for a platform.
 * @param {{ node: string, args: string[], log: string }} command node, the arguments after it, the log file
 */
export function serviceFile(platform, { node, args, log }) {
  switch (platform) {
    case 'win32': {
      // node runs without a window; when it stops it is started again after 5 s
      const quoted = [node, ...args].map(part => `"${part.replaceAll('"', '')}"`).join(' ');
      const command = `cmd /c "${quoted} >> "${log}" 2>&1"`;
      return [
        "' Nanobrowser bridge: started at login, runs hidden, restarted when it stops",
        'Set shell = CreateObject("WScript.Shell")',
        'Do',
        `  shell.Run ${vbsString(command)}, 0, True`,
        '  WScript.Sleep 5000',
        'Loop',
        '',
      ].join('\r\n');
    }
    case 'darwin':
      return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${LABEL}</string>
  <key>ProgramArguments</key>
  <array>
${[node, ...args].map(part => `    <string>${xml(part)}</string>`).join('\n')}
  </array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>${xml(log)}</string>
  <key>StandardErrorPath</key><string>${xml(log)}</string>
</dict>
</plist>
`;
    default:
      return `[Unit]
Description=Nanobrowser MCP bridge
After=network.target

[Service]
ExecStart=${[node, ...args].map(systemdArg).join(' ')}
Restart=always
RestartSec=5
StandardOutput=append:${log}
StandardError=append:${log}

[Install]
WantedBy=default.target
`;
  }
}

const run = (command, args) => execFileSync(command, args, { stdio: 'pipe' }).toString();

/**
 * Install the service and start it now.
 * @param {string[]} args the arguments for node: the bridge script and its options
 * @returns {{ file: string, log: string }}
 */
export function installService(args, platform = process.platform) {
  const paths = servicePaths(platform);
  fs.mkdirSync(path.dirname(paths.file), { recursive: true });
  fs.mkdirSync(path.dirname(paths.log), { recursive: true });
  if (fs.existsSync(paths.file)) uninstallService(platform);
  fs.writeFileSync(paths.file, serviceFile(platform, { node: process.execPath, args, log: paths.log }));
  switch (platform) {
    case 'win32':
      spawn('wscript.exe', [paths.file], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
      break;
    case 'darwin':
      run('launchctl', ['load', '-w', paths.file]);
      break;
    default:
      run('systemctl', ['--user', 'daemon-reload']);
      run('systemctl', ['--user', 'enable', '--now', `${NAME}.service`]);
      // without lingering, systemd stops user services at logout
      try {
        run('loginctl', ['enable-linger', os.userInfo().username]);
      } catch {
        // not allowed here: the bridge then runs while the user is logged in
      }
  }
  return paths;
}

/** Stop the service and remove it; true when there was one */
export function uninstallService(platform = process.platform) {
  const paths = servicePaths(platform);
  if (!fs.existsSync(paths.file)) return false;
  try {
    switch (platform) {
      case 'win32':
        // the launcher and the node it started: found by their command lines
        run('powershell.exe', [
          '-NoProfile',
          '-Command',
          `Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -like '*${NAME}.vbs*' -or ($_.Name -eq 'node.exe' -and $_.CommandLine -like '*mcp-bridge*cli.mjs*') } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }`,
        ]);
        break;
      case 'darwin':
        run('launchctl', ['unload', '-w', paths.file]);
        break;
      default:
        run('systemctl', ['--user', 'disable', '--now', `${NAME}.service`]);
    }
  } catch {
    // not running
  }
  fs.rmSync(paths.file, { force: true });
  if (platform !== 'win32' && platform !== 'darwin') {
    try {
      run('systemctl', ['--user', 'daemon-reload']);
    } catch {
      // nothing to reload
    }
  }
  return true;
}

/** Whether the service is installed, and where its log is */
export function serviceStatus(platform = process.platform) {
  const paths = servicePaths(platform);
  return { installed: fs.existsSync(paths.file), ...paths };
}

/** Chrome on this computer, or null when it is not found */
export function findChrome(platform = process.platform, env = process.env, exists = fs.existsSync) {
  if (env.NANOBROWSER_CHROME) return env.NANOBROWSER_CHROME;
  const candidates =
    platform === 'win32'
      ? [env.PROGRAMFILES, env['PROGRAMFILES(X86)'], env.LOCALAPPDATA]
          .filter(Boolean)
          .map(base => path.win32.join(base, 'Google', 'Chrome', 'Application', 'chrome.exe'))
      : platform === 'darwin'
        ? ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome']
        : ['/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium', '/usr/bin/chromium-browser'];
  return candidates.find(candidate => exists(candidate)) ?? null;
}

/**
 * Start Chrome without opening a window: the extension's background starts with it and connects to the
 * bridge. A Chrome already running opens nothing.
 */
export function launchChrome(chrome) {
  spawn(chrome, ['--no-startup-window'], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
}
