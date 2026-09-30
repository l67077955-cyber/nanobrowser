import { StorageEnum } from '../base/enums';
import { createStorage } from '../base/base';
import type { BaseStorage } from '../base/types';

// Interface for firewall settings configuration
export interface FirewallConfig {
  allowList: string[]; // URLs that are explicitly allowed
  denyList: string[]; // URLs that are explicitly denied
  enabled: boolean; // Whether the firewall is enabled
}

/**
 * Normalizes a site-access entry: lowercase, no protocol, no `*.` wildcard
 * (bare domains already cover subdomains), no query/hash, no trailing slash.
 * @param url The domain or URL to normalize
 * @returns The normalized entry
 */
export function normalizeSiteEntry(url: string): string {
  return url
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, '')
    .replace(/^\*\./, '')
    .replace(/[?#].*$/, '')
    .replace(/\/+$/, '');
}

export type FirewallStorage = BaseStorage<FirewallConfig> & {
  updateFirewall: (settings: Partial<FirewallConfig>) => Promise<void>;
  getFirewall: () => Promise<FirewallConfig>;
  resetToDefaults: () => Promise<void>;
  /** Resolves true when the entry was moved over from the blocked list. */
  addToAllowList: (url: string) => Promise<boolean>;
  removeFromAllowList: (url: string) => Promise<void>;
  /** Resolves true when the entry was moved over from the allowed list. */
  addToDenyList: (url: string) => Promise<boolean>;
  removeFromDenyList: (url: string) => Promise<void>;
};

// Default settings
export const DEFAULT_FIREWALL_SETTINGS: FirewallConfig = {
  allowList: [],
  denyList: [],
  enabled: true,
};

const storage = createStorage<FirewallConfig>('firewall-settings', DEFAULT_FIREWALL_SETTINGS, {
  storageEnum: StorageEnum.Local,
  liveUpdate: true,
});

export const firewallStore: FirewallStorage = {
  ...storage,
  async updateFirewall(settings: Partial<FirewallConfig>) {
    const currentSettings = (await storage.get()) || DEFAULT_FIREWALL_SETTINGS;
    await storage.set({
      ...currentSettings,
      ...settings,
    });
  },
  async getFirewall() {
    const settings = await storage.get();
    return settings || DEFAULT_FIREWALL_SETTINGS;
  },
  async resetToDefaults() {
    await storage.set(DEFAULT_FIREWALL_SETTINGS);
  },
  async addToAllowList(url: string) {
    const normalizedUrl = normalizeSiteEntry(url);
    const currentSettings = await this.getFirewall();
    if (!normalizedUrl || currentSettings.allowList.includes(normalizedUrl)) {
      return false;
    }

    // An entry lives on one list only; adding it here takes it off the other
    const moved = currentSettings.denyList.includes(normalizedUrl);
    await this.updateFirewall({
      allowList: [...currentSettings.allowList, normalizedUrl],
      denyList: currentSettings.denyList.filter(item => item !== normalizedUrl),
    });
    return moved;
  },
  async removeFromAllowList(url: string) {
    const normalizedUrl = normalizeSiteEntry(url);
    const currentSettings = await this.getFirewall();
    await this.updateFirewall({
      allowList: currentSettings.allowList.filter(item => item !== normalizedUrl),
    });
  },
  async addToDenyList(url: string) {
    const normalizedUrl = normalizeSiteEntry(url);
    const currentSettings = await this.getFirewall();
    if (!normalizedUrl || currentSettings.denyList.includes(normalizedUrl)) {
      return false;
    }

    // An entry lives on one list only; adding it here takes it off the other
    const moved = currentSettings.allowList.includes(normalizedUrl);
    await this.updateFirewall({
      denyList: [...currentSettings.denyList, normalizedUrl],
      allowList: currentSettings.allowList.filter(item => item !== normalizedUrl),
    });
    return moved;
  },
  async removeFromDenyList(url: string) {
    const normalizedUrl = normalizeSiteEntry(url);
    const currentSettings = await this.getFirewall();
    await this.updateFirewall({
      denyList: currentSettings.denyList.filter(item => item !== normalizedUrl),
    });
  },
};
