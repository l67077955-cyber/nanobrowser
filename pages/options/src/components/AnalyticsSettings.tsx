import React, { useState, useEffect } from 'react';
import { analyticsSettingsStore } from '@extension/storage';

import type { AnalyticsSettingsConfig } from '@extension/storage';

export const AnalyticsSettings: React.FC = () => {
  const [settings, setSettings] = useState<AnalyticsSettingsConfig | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const loadSettings = async () => {
      try {
        const currentSettings = await analyticsSettingsStore.getSettings();
        setSettings(currentSettings);
      } catch (error) {
        console.error('Failed to load analytics settings:', error);
      } finally {
        setLoading(false);
      }
    };

    loadSettings();

    // Listen for storage changes
    const unsubscribe = analyticsSettingsStore.subscribe(loadSettings);
    return () => {
      unsubscribe();
    };
  }, []);

  const handleToggleAnalytics = async (enabled: boolean) => {
    if (!settings) return;

    try {
      await analyticsSettingsStore.updateSettings({ enabled });
      setSettings({ ...settings, enabled });
    } catch (error) {
      console.error('Failed to update analytics settings:', error);
    }
  };

  if (loading) {
    return (
      <section className="space-y-6">
        <div className={`rounded-xl border border-nb-line bg-nb-tile p-6 text-left shadow-nb`}>
          <h2 className={`mb-4 text-base font-semibold tracking-tight text-nb-ink`}>Analytics Settings</h2>
          <div className="animate-pulse">
            <div className={`mb-2 h-4 w-3/4 rounded bg-nb-track`}></div>
            <div className={`h-4 w-1/2 rounded bg-nb-track`}></div>
          </div>
        </div>
      </section>
    );
  }

  if (!settings) {
    return (
      <section className="space-y-6">
        <div className={`rounded-xl border border-nb-line bg-nb-tile p-6 text-left shadow-nb`}>
          <h2 className={`mb-4 text-base font-semibold tracking-tight text-nb-ink`}>Analytics Settings</h2>
          <p className={`text-nb-critical`}>Failed to load analytics settings.</p>
        </div>
      </section>
    );
  }

  return (
    <section className="space-y-6">
      <div className={`rounded-xl border border-nb-line bg-nb-tile p-6 text-left shadow-nb`}>
        <h2 className={`mb-4 text-base font-semibold tracking-tight text-nb-ink`}>Analytics Settings</h2>

        <div className="space-y-6">
          {/* Main toggle */}
          <div className={`my-6 rounded-lg border border-nb-hair bg-nb-tile-2 p-4`}>
            <div className="flex items-center justify-between">
              <label htmlFor="analytics-enabled" className={`text-base font-medium text-nb-ink`}>
                Help improve Nanobrowser
              </label>
              <div className="relative inline-block w-12 select-none">
                <input
                  type="checkbox"
                  checked={settings.enabled}
                  onChange={e => handleToggleAnalytics(e.target.checked)}
                  className="sr-only"
                  id="analytics-enabled"
                />
                <label
                  htmlFor="analytics-enabled"
                  className={`block h-6 cursor-pointer overflow-hidden rounded-full ${
                    settings.enabled ? 'bg-nb-llm' : 'bg-nb-track'
                  }`}>
                  <span className="sr-only">Toggle analytics</span>
                  <span
                    className={`block size-6 rounded-full border border-nb-line bg-nb-tile transition-transform ${
                      settings.enabled ? 'translate-x-6' : 'translate-x-0'
                    }`}
                  />
                </label>
              </div>
            </div>
            <p className={`mt-2 text-sm text-nb-muted`}>Share anonymous usage data to help us improve the extension</p>
          </div>

          {/* Information about what we collect */}
          <div className={`rounded-md border border-nb-hair bg-nb-tile-2 p-4`}>
            <h3 className={`mb-4 text-base font-medium text-nb-ink`}>What we collect:</h3>
            <ul className={`list-disc space-y-2 pl-5 text-left text-sm text-nb-ink-2`}>
              <li>Task execution metrics (start, completion, failure counts and duration)</li>
              <li>Domain names of websites visited (e.g., &quot;amazon.com&quot;, not full URLs)</li>
              <li>Error categories for failed tasks (no sensitive details)</li>
              <li>Anonymous usage statistics</li>
            </ul>

            <h3 className={`mb-4 mt-6 text-base font-medium text-nb-ink`}>What we DON&apos;T collect:</h3>
            <ul className={`list-disc space-y-2 pl-5 text-left text-sm text-nb-ink-2`}>
              <li>Personal information or login credentials</li>
              <li>Full URLs or page content</li>
              <li>Task instructions or user prompts</li>
              <li>Screen recordings or screenshots</li>
              <li>Any sensitive or private data</li>
            </ul>
          </div>

          {/* Opt-out message */}
          {!settings.enabled && (
            <div className={`rounded-md border border-l-[3px] border-nb-line border-l-nb-warning bg-nb-tile-2 p-4`}>
              <p className={`text-sm text-nb-warning`}>
                Analytics disabled. You can re-enable it anytime to help improve Nanobrowser.
              </p>
            </div>
          )}
        </div>
      </div>
    </section>
  );
};
