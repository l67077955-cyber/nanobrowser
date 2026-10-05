/**
 * Pairing: the bridge hands the extension on this computer its address and token through Chrome's native
 * messaging, so that installing the bridge is all it takes to connect the two. Chrome starts the host program a
 * manifest file names, and only for the extension ids the manifest allows; the extension asks it when it has no
 * bridge set.
 *
 * Chrome, Edge and Chromium find the manifest in a folder of the profile's user data directory, and on Windows
 * through a registry key.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export const HOST_NAME = 'com.nanobrowser.bridge';
const HOST_SCRIPT = fileURLToPath(new URL('./pair-host.mjs', import.meta.url));

/**
 * The id Chrome gives an extension loaded unpacked from a folder. It comes from the folder's path as Chrome
 * holds it: UTF-16 with an upper-case drive letter on Windows, the bytes of the path elsewhere.
 */
export function extensionIdForPath(dir, platform = process.platform) {
  const bytes =
    platform === 'win32'
      ? Buffer.from(/^[a-z]:/.test(dir) ? dir[0].toUpperCase() + dir.slice(1) : dir, 'utf16le')
      : Buffer.from(dir, 'utf8');
  return [...createHash('sha256').update(bytes).digest().subarray(0, 16).toString('hex')]
    .map(digit => String.fromCharCode(97 + parseInt(digit, 16)))
    .join('');
}

/**
 * Where the host's files go, and where the browsers look for its manifest; `profiles` adds browser profiles
 * started with a --user-data-dir of their own (outside Windows, where the registry points to one manifest)
 */
export function hostLocations(platform = process.platform, home = os.homedir(), env = process.env, profiles = []) {
  const manifestIn = dirs => dirs.map(dir => path.join(dir, 'NativeMessagingHosts', `${HOST_NAME}.json`));
  switch (platform) {
    case 'win32': {
      const dir = path.win32.join(env.LOCALAPPDATA ?? path.win32.join(home, 'AppData', 'Local'), 'nanobrowser');
      return {
        launcher: path.win32.join(dir, 'pair-host.cmd'),
        manifests: [path.win32.join(dir, `${HOST_NAME}.json`)],
        registry: ['Google\\Chrome', 'Microsoft\\Edge', 'Chromium'].map(
          browser => `HKCU\\Software\\${browser}\\NativeMessagingHosts\\${HOST_NAME}`,
        ),
      };
    }
    case 'darwin': {
      const support = path.join(home, 'Library', 'Application Support');
      return {
        launcher: path.join(support, 'nanobrowser', 'pair-host.sh'),
        manifests: manifestIn([
          ...['Google/Chrome', 'Microsoft Edge', 'Chromium'].map(dir => path.join(support, dir)),
          ...profiles,
        ]),
        registry: [],
      };
    }
    default: {
      const config = env.XDG_CONFIG_HOME ?? path.join(home, '.config');
      const data = env.XDG_DATA_HOME ?? path.join(home, '.local', 'share');
      return {
        launcher: path.join(data, 'nanobrowser', 'pair-host.sh'),
        manifests: manifestIn([
          ...['google-chrome', 'chromium', 'microsoft-edge'].map(dir => path.join(config, dir)),
          ...profiles,
        ]),
        registry: [],
      };
    }
  }
}

const shellQuote = value => `'${value.replaceAll("'", `'\\''`)}'`;

/** The program Chrome starts: node running pair-host.mjs with the bridge's port and token file */
export function hostLauncher(platform, { node, script, port, tokenFile }) {
  if (platform === 'win32') {
    // no echo: only the answer may reach Chrome; % is doubled so that cmd leaves it as it is
    const quote = value => `"${value.replaceAll('%', '%%')}"`;
    return `@echo off\r\n${quote(node)} ${quote(script)} --port ${port} --token-file ${quote(tokenFile)}\r\n`;
  }
  return `#!/bin/sh\n# Nanobrowser: hands the extension the bridge's address and token\nexec ${[node, script, '--port', String(port), '--token-file', tokenFile].map(shellQuote).join(' ')}\n`;
}

export function hostManifest({ launcher, extensionIds }) {
  return `${JSON.stringify(
    {
      name: HOST_NAME,
      description: 'Nanobrowser bridge: its address and token for the extension on this computer',
      path: launcher,
      type: 'stdio',
      allowed_origins: extensionIds.map(id => `chrome-extension://${id}/`),
    },
    null,
    2,
  )}\n`;
}

/**
 * Write the host for the extension ids given. A browser that never ran here has no folder yet and is left out,
 * the profiles named are always written.
 * @returns {{ launcher: string, manifests: string[], registry: string[] }}
 */
export function installHost({ port, tokenFile, extensionIds, profiles = [] }, platform = process.platform) {
  const where = hostLocations(platform, os.homedir(), process.env, profiles);
  fs.mkdirSync(path.dirname(where.launcher), { recursive: true });
  fs.writeFileSync(
    where.launcher,
    hostLauncher(platform, { node: process.execPath, script: HOST_SCRIPT, port, tokenFile }),
    { mode: 0o755 },
  );
  const manifest = hostManifest({ launcher: where.launcher, extensionIds });
  const named = profiles.map(profile => path.resolve(profile));
  const written = [];
  for (const file of where.manifests) {
    const browserDir = path.dirname(path.dirname(file));
    if (platform !== 'win32' && !named.includes(path.resolve(browserDir)) && !fs.existsSync(browserDir)) continue;
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, manifest);
    written.push(file);
  }
  for (const key of where.registry) {
    execFileSync('reg', ['add', key, '/ve', '/t', 'REG_SZ', '/d', where.manifests[0], '/f'], { stdio: 'pipe' });
  }
  return { launcher: where.launcher, manifests: written, registry: where.registry };
}

/** Remove the host from the usual places; true when there was one */
export function uninstallHost(platform = process.platform) {
  const where = hostLocations(platform);
  let found = false;
  for (const file of [where.launcher, ...where.manifests]) {
    if (fs.existsSync(file)) found = true;
    fs.rmSync(file, { force: true });
  }
  for (const key of where.registry) {
    try {
      execFileSync('reg', ['delete', key, '/f'], { stdio: 'pipe' });
      found = true;
    } catch {
      // not there
    }
  }
  return found;
}
