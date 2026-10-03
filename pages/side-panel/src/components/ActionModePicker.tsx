import { useEffect, useRef, useState } from 'react';
import { FiEye, FiUserCheck, FiZap } from 'react-icons/fi';
import { type ActionMode, ACTION_MODES, generalSettingsStore } from '@extension/storage';
import { t } from '@extension/i18n';

const MODES = {
  readonly: {
    icon: FiEye,
    label: 'chat_actionMode_readonly',
    desc: 'chat_actionMode_readonly_desc',
    tone: 'text-nb-llm',
  },
  auto: { icon: FiZap, label: 'chat_actionMode_auto', desc: 'chat_actionMode_auto_desc', tone: 'text-nb-muted' },
  manual: {
    icon: FiUserCheck,
    label: 'chat_actionMode_manual',
    desc: 'chat_actionMode_manual_desc',
    tone: 'text-nb-warning',
  },
} as const satisfies Record<ActionMode, { icon: unknown; label: string; desc: string; tone: string }>;

/** Moves to the next action mode, as the button and Shift+Tab in the chat box do */
export async function cycleActionMode(): Promise<void> {
  const { actionMode } = await generalSettingsStore.getSettings();
  const next = ACTION_MODES[(ACTION_MODES.indexOf(actionMode) + 1) % ACTION_MODES.length];
  await generalSettingsStore.updateSettings({ actionMode: next });
}

/** How far the agent may act on pages: one click (or Shift+Tab) moves to the next mode */
export default function ActionModePicker() {
  const [mode, setMode] = useState<ActionMode>('auto');
  // right after a switch the button says what the new mode does, then goes back to its name
  const [explain, setExplain] = useState(false);
  const loaded = useRef<ActionMode | null>(null);

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const load = () =>
      generalSettingsStore.getSettings().then(({ actionMode }) => {
        if (loaded.current !== null && loaded.current !== actionMode) {
          setExplain(true);
          clearTimeout(timer);
          timer = setTimeout(() => setExplain(false), 2500);
        }
        loaded.current = actionMode;
        setMode(actionMode);
      });
    void load();
    const unsubscribe = generalSettingsStore.subscribe(load);
    return () => {
      unsubscribe();
      clearTimeout(timer);
    };
  }, []);

  const { icon: Icon, label, desc, tone } = MODES[mode];
  return (
    <button
      type="button"
      onClick={() => void cycleActionMode()}
      aria-label={`${t('chat_actionMode_label')}: ${t(label)}`}
      title={`${t(desc)} ${t('chat_actionMode_next')}`}
      className={`flex min-w-0 items-center gap-1 rounded-md px-1.5 py-1 text-[11.5px] font-medium transition-colors hover:bg-nb-tile-2 ${tone}`}>
      <Icon className="size-3.5 shrink-0" aria-hidden="true" />
      <span className="shrink-0">{t(label)}</span>
      {explain && (
        <span aria-live="polite" className="truncate font-normal text-nb-muted">
          · {t(desc)}
        </span>
      )}
    </button>
  );
}
