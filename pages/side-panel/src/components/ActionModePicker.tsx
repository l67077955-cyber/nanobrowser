import { useEffect, useState } from 'react';
import { FiChevronDown, FiEye, FiUserCheck, FiZap } from 'react-icons/fi';
import { type ActionMode, ACTION_MODES, generalSettingsStore } from '@extension/storage';
import { t } from '@extension/i18n';

const MODES = {
  readonly: { icon: FiEye, label: 'chat_actionMode_readonly', desc: 'chat_actionMode_readonly_desc' },
  auto: { icon: FiZap, label: 'chat_actionMode_auto', desc: 'chat_actionMode_auto_desc' },
  manual: { icon: FiUserCheck, label: 'chat_actionMode_manual', desc: 'chat_actionMode_manual_desc' },
} as const satisfies Record<ActionMode, { icon: unknown; label: string; desc: string }>;

/** How far the agent may act on pages, picked in the composer; the same setting as in Settings */
export default function ActionModePicker({ disabled }: { disabled?: boolean }) {
  const [mode, setMode] = useState<ActionMode>('auto');

  useEffect(() => {
    const load = () => generalSettingsStore.getSettings().then(settings => setMode(settings.actionMode));
    void load();
    return generalSettingsStore.subscribe(load);
  }, []);

  const { icon: Icon, label, desc } = MODES[mode];
  return (
    <label
      title={`${t(desc)} ${t('chat_actionMode_next')}`}
      className={`relative flex items-center gap-1 rounded-md px-1.5 py-1 text-[11.5px] font-medium transition-colors ${
        mode === 'auto' ? 'text-nb-muted hover:text-nb-ink' : 'bg-nb-tile-2 text-nb-ink-2 hover:text-nb-ink'
      } ${disabled ? 'opacity-50' : 'cursor-pointer'}`}>
      <Icon className="size-3.5 shrink-0" aria-hidden="true" />
      <span>{t(label)}</span>
      <FiChevronDown className="size-3 shrink-0" aria-hidden="true" />
      <select
        value={mode}
        disabled={disabled}
        aria-label={t('chat_actionMode_label')}
        onChange={e => {
          const next = e.target.value as ActionMode;
          setMode(next);
          void generalSettingsStore.updateSettings({ actionMode: next });
        }}
        className="absolute inset-0 cursor-pointer appearance-none opacity-0 disabled:cursor-not-allowed">
        {ACTION_MODES.map(m => (
          <option key={m} value={m}>
            {t(MODES[m].label)} — {t(MODES[m].desc)}
          </option>
        ))}
      </select>
    </label>
  );
}
