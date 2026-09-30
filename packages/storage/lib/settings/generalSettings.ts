import { StorageEnum } from '../base/enums';
import { createStorage } from '../base/base';
import type { BaseStorage } from '../base/types';

// Interface for general settings configuration
export interface GeneralSettingsConfig {
  maxSteps: number;
  maxActionsPerStep: number;
  maxFailures: number;
  useVision: boolean;
  useVisionForPlanner: boolean;
  planningInterval: number;
  displayHighlights: boolean;
  minWaitPageLoad: number;
  replayHistoricalTasks: boolean;
  fastMode: boolean;
  fastModeApiKey: string;
  /** Jev runs an operation only at or above this confidence; below it the step goes to the Navigator model */
  fastModeMinOperationConfidence: number;
  /** same, for which element Jev picked */
  fastModeMinTargetConfidence: number;
  /** pause for approval before clicking delete/send/pay-like elements */
  confirmSensitiveActions: boolean;
  /** give the agents the stored memories at the start of every task */
  memoryEnabled: boolean;
  /** after each task, look for new facts about the user in what they wrote */
  memoryAutoExtract: boolean;
  /** the toolbar icon opens Nanobrowser in a window of its own instead of the side panel */
  openInWindow: boolean;
}

export type GeneralSettingsStorage = BaseStorage<GeneralSettingsConfig> & {
  updateSettings: (settings: Partial<GeneralSettingsConfig>) => Promise<void>;
  getSettings: () => Promise<GeneralSettingsConfig>;
  resetToDefaults: () => Promise<void>;
};

// Default settings
export const DEFAULT_GENERAL_SETTINGS: GeneralSettingsConfig = {
  maxSteps: 100,
  maxActionsPerStep: 5,
  maxFailures: 3,
  useVision: false,
  useVisionForPlanner: false,
  planningInterval: 3,
  displayHighlights: true,
  minWaitPageLoad: 250,
  replayHistoricalTasks: false,
  fastMode: false,
  fastModeApiKey: '',
  fastModeMinOperationConfidence: 0.5,
  // Wrong picks seen in practice scored ~0.5 on the target head; correct ones 0.67+
  fastModeMinTargetConfidence: 0.6,
  confirmSensitiveActions: false,
  memoryEnabled: true,
  memoryAutoExtract: true,
  openInWindow: false,
};

const storage = createStorage<GeneralSettingsConfig>('general-settings', DEFAULT_GENERAL_SETTINGS, {
  storageEnum: StorageEnum.Local,
  liveUpdate: true,
});

export const generalSettingsStore: GeneralSettingsStorage = {
  ...storage,
  async updateSettings(settings: Partial<GeneralSettingsConfig>) {
    const currentSettings = (await storage.get()) || DEFAULT_GENERAL_SETTINGS;
    const updatedSettings = {
      ...currentSettings,
      ...settings,
    };

    // If useVision is true, displayHighlights must also be true
    if (updatedSettings.useVision && !updatedSettings.displayHighlights) {
      updatedSettings.displayHighlights = true;
    }

    await storage.set(updatedSettings);
  },
  async getSettings() {
    const settings = await storage.get();
    return {
      ...DEFAULT_GENERAL_SETTINGS,
      ...settings,
    };
  },
  async resetToDefaults() {
    await storage.set(DEFAULT_GENERAL_SETTINGS);
  },
};
