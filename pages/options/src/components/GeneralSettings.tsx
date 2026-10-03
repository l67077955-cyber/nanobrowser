import { useState, useEffect } from 'react';
import { FiChevronRight } from 'react-icons/fi';
import { type GeneralSettingsConfig, generalSettingsStore, DEFAULT_GENERAL_SETTINGS } from '@extension/storage';
import { t } from '@extension/i18n';
import { SettingsGroup, SettingsRow, Toggle, NumberField, ConfidenceSlider } from './SettingsList';

export const GeneralSettings = () => {
  const [settings, setSettings] = useState<GeneralSettingsConfig>(DEFAULT_GENERAL_SETTINGS);
  const [showAdvanced, setShowAdvanced] = useState(false);

  useEffect(() => {
    // Load initial settings
    generalSettingsStore.getSettings().then(setSettings);
    // settings changed elsewhere (the Memory tab, another settings tab) show up here
    return generalSettingsStore.subscribe(() => {
      generalSettingsStore.getSettings().then(setSettings);
    });
  }, []);

  const updateSetting = async <K extends keyof GeneralSettingsConfig>(key: K, value: GeneralSettingsConfig[K]) => {
    // Optimistically update the local state for responsiveness
    setSettings(prevSettings => ({ ...prevSettings, [key]: value }));

    // Call the store to update the setting
    await generalSettingsStore.updateSettings({ [key]: value } as Partial<GeneralSettingsConfig>);

    // After the store update (which might have side effects, e.g., useVision affecting displayHighlights),
    // fetch the latest settings from the store and update the local state again to ensure UI consistency.
    const latestSettings = await generalSettingsStore.getSettings();
    setSettings(latestSettings);
  };

  // most used first: how the app opens and talks to you, what the agent sees, then Fast Mode;
  // limits and experiments wait behind Advanced
  return (
    <div className="mx-auto max-w-2xl space-y-7 text-left">
      <h2 className="px-4 text-xl font-semibold tracking-tight text-nb-ink">{t('options_general_header')}</h2>

      <SettingsGroup title={t('options_general_group_window')} footer={t('options_general_group_window_footer')}>
        <SettingsRow
          title={t('options_general_openInWindow')}
          subtitle={t('options_general_openInWindow_desc')}
          htmlFor="openInWindow">
          <Toggle id="openInWindow" checked={settings.openInWindow} onChange={v => updateSetting('openInWindow', v)} />
        </SettingsRow>
        <SettingsRow
          title={t('options_general_notifyOnFinish')}
          subtitle={t('options_general_notifyOnFinish_desc')}
          htmlFor="notifyOnFinish">
          <Toggle
            id="notifyOnFinish"
            checked={settings.notifyOnFinish}
            onChange={v => updateSetting('notifyOnFinish', v)}
          />
        </SettingsRow>
      </SettingsGroup>

      <SettingsGroup title={t('options_general_group_seeing')} footer={t('options_general_group_seeing_footer')}>
        <SettingsRow
          title={t('options_general_enableVision')}
          subtitle={t('options_general_enableVision_desc')}
          htmlFor="useVision">
          <Toggle id="useVision" checked={settings.useVision} onChange={v => updateSetting('useVision', v)} />
        </SettingsRow>
        <SettingsRow
          title={t('options_general_displayHighlights')}
          subtitle={
            settings.useVision
              ? t('options_general_displayHighlights_locked')
              : t('options_general_displayHighlights_desc')
          }
          htmlFor="displayHighlights">
          {/* the store keeps highlights on while vision is on */}
          <Toggle
            id="displayHighlights"
            checked={settings.displayHighlights}
            disabled={settings.useVision}
            onChange={v => updateSetting('displayHighlights', v)}
          />
        </SettingsRow>
      </SettingsGroup>

      <SettingsGroup
        title={t('options_general_group_speed')}
        footer={settings.fastMode ? t('options_general_group_fastMode_footer') : undefined}>
        <SettingsRow
          title={t('options_general_fastMode')}
          badge={t('options_general_experimental')}
          subtitle={t('options_general_fastMode_desc')}
          htmlFor="fastMode">
          <Toggle id="fastMode" checked={settings.fastMode} onChange={v => updateSetting('fastMode', v)} />
        </SettingsRow>
        {settings.fastMode && (
          <>
            <SettingsRow
              title={t('options_general_fastModeApiKey')}
              subtitle={t('options_general_fastModeApiKey_desc')}
              htmlFor="fastModeApiKey">
              <input
                id="fastModeApiKey"
                type="password"
                autoComplete="off"
                placeholder="sk-or-..."
                value={settings.fastModeApiKey}
                onChange={e => updateSetting('fastModeApiKey', e.target.value.trim())}
                className="w-60 rounded-md border border-nb-line bg-nb-tile-2 px-2.5 py-1.5 text-sm text-nb-ink focus:border-nb-llm focus:outline-none"
              />
            </SettingsRow>
            <SettingsRow
              title={t('options_general_fastModeMinOperation')}
              subtitle={t('options_general_fastModeMinOperation_desc')}
              htmlFor="fastModeMinOperationConfidence">
              <ConfidenceSlider
                id="fastModeMinOperationConfidence"
                value={settings.fastModeMinOperationConfidence}
                onChange={v => updateSetting('fastModeMinOperationConfidence', v)}
              />
            </SettingsRow>
            <SettingsRow
              title={t('options_general_fastModeMinTarget')}
              subtitle={t('options_general_fastModeMinTarget_desc')}
              htmlFor="fastModeMinTargetConfidence">
              <ConfidenceSlider
                id="fastModeMinTargetConfidence"
                value={settings.fastModeMinTargetConfidence}
                onChange={v => updateSetting('fastModeMinTargetConfidence', v)}
              />
            </SettingsRow>
          </>
        )}
      </SettingsGroup>

      <SettingsGroup>
        <button
          type="button"
          aria-expanded={showAdvanced}
          onClick={() => setShowAdvanced(open => !open)}
          className="flex min-h-[52px] w-full items-center justify-between gap-6 px-4 py-2.5 text-left hover:bg-nb-tile-2 focus-visible:outline focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-nb-llm">
          <span>
            <span className="block text-[13.5px] font-medium text-nb-ink">{t('options_general_advanced')}</span>
            <span className="mt-0.5 block text-xs text-nb-muted">{t('options_general_advanced_desc')}</span>
          </span>
          <FiChevronRight className={`size-4 text-nb-muted transition-transform ${showAdvanced ? 'rotate-90' : ''}`} />
        </button>
      </SettingsGroup>

      {showAdvanced && (
        <>
          <SettingsGroup title={t('options_general_group_limits')} footer={t('options_general_group_limits_footer')}>
            <SettingsRow title={t('options_general_maxSteps')} htmlFor="maxSteps">
              <NumberField
                id="maxSteps"
                min={1}
                max={500}
                value={settings.maxSteps}
                onChange={v => updateSetting('maxSteps', v)}
              />
            </SettingsRow>
            <SettingsRow title={t('options_general_maxActions')} htmlFor="maxActionsPerStep">
              <NumberField
                id="maxActionsPerStep"
                min={1}
                max={50}
                value={settings.maxActionsPerStep}
                onChange={v => updateSetting('maxActionsPerStep', v)}
              />
            </SettingsRow>
            <SettingsRow title={t('options_general_maxFailures')} htmlFor="maxFailures">
              <NumberField
                id="maxFailures"
                min={1}
                max={10}
                value={settings.maxFailures}
                onChange={v => updateSetting('maxFailures', v)}
              />
            </SettingsRow>
            <SettingsRow title={t('options_general_planningInterval')} htmlFor="planningInterval">
              <NumberField
                id="planningInterval"
                min={1}
                max={20}
                unit={t('options_general_unit_steps')}
                value={settings.planningInterval}
                onChange={v => updateSetting('planningInterval', v)}
              />
            </SettingsRow>
            <SettingsRow title={t('options_general_minWaitPageLoad')} htmlFor="minWaitPageLoad">
              <NumberField
                id="minWaitPageLoad"
                min={250}
                max={5000}
                step={50}
                unit="ms"
                value={settings.minWaitPageLoad}
                onChange={v => updateSetting('minWaitPageLoad', v)}
              />
            </SettingsRow>
          </SettingsGroup>

          <SettingsGroup title={t('options_general_experimental')}>
            <SettingsRow
              title={t('options_general_replayHistoricalTasks')}
              subtitle={t('options_general_replayHistoricalTasks_desc')}
              htmlFor="replayHistoricalTasks">
              <Toggle
                id="replayHistoricalTasks"
                checked={settings.replayHistoricalTasks}
                onChange={v => updateSetting('replayHistoricalTasks', v)}
              />
            </SettingsRow>
          </SettingsGroup>
        </>
      )}
    </div>
  );
};
