import { StorageEnum } from '../base/enums';
import { createStorage } from '../base/base';
import type { BaseStorage } from '../base/types';

/** How other agents reach this browser: through a bridge process the extension connects out to */
export interface RemoteControlConfig {
  /** off by default: with it on, whoever holds the token can run tasks in this browser */
  enabled: boolean;
  /** WebSocket address of the bridge */
  url: string;
  /** shared secret the bridge checks before it accepts this browser */
  token: string;
}

export type RemoteControlStorage = BaseStorage<RemoteControlConfig> & {
  updateConfig: (config: Partial<RemoteControlConfig>) => Promise<void>;
  getConfig: () => Promise<RemoteControlConfig>;
};

export const DEFAULT_REMOTE_CONTROL: RemoteControlConfig = {
  enabled: false,
  url: 'ws://localhost:8787/extension',
  token: '',
};

const storage = createStorage<RemoteControlConfig>('remote-control', DEFAULT_REMOTE_CONTROL, {
  storageEnum: StorageEnum.Local,
  liveUpdate: true,
});

export const remoteControlStore: RemoteControlStorage = {
  ...storage,
  async updateConfig(config: Partial<RemoteControlConfig>) {
    await storage.set({ ...(await this.getConfig()), ...config });
  },
  async getConfig() {
    return { ...DEFAULT_REMOTE_CONTROL, ...(await storage.get()) };
  },
};
