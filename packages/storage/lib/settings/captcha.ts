import { StorageEnum } from '../base/enums';
import { createStorage } from '../base/base';
import type { BaseStorage } from '../base/types';

/** The model that reads image captchas: it has to accept images, which the agent models need not */
export interface CaptchaModelConfig {
  provider: string;
  modelName: string;
}

export interface CaptchaModelRecord {
  captchaModel?: CaptchaModelConfig;
}

export type CaptchaModelStorage = BaseStorage<CaptchaModelRecord> & {
  setCaptchaModel: (config: CaptchaModelConfig) => Promise<void>;
  getCaptchaModel: () => Promise<CaptchaModelConfig | undefined>;
  resetCaptchaModel: () => Promise<void>;
};

const storage = createStorage<CaptchaModelRecord>(
  'captcha-model',
  { captchaModel: undefined },
  {
    storageEnum: StorageEnum.Local,
    liveUpdate: true,
  },
);

export const captchaModelStore: CaptchaModelStorage = {
  ...storage,
  setCaptchaModel: async (config: CaptchaModelConfig) => {
    if (!config.provider || !config.modelName) {
      throw new Error('Provider and model name must be specified for the captcha model');
    }
    await storage.set({ captchaModel: config });
  },
  getCaptchaModel: async () => {
    const data = await storage.get();
    return data.captchaModel;
  },
  resetCaptchaModel: async () => {
    await storage.set({ captchaModel: undefined });
  },
};
