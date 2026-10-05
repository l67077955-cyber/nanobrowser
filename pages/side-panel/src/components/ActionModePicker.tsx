import { useEffect, useRef, useState } from 'react';
import { FiCheck, FiChevronUp, FiEye, FiUserCheck, FiZap } from 'react-icons/fi';
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

/** Moves to the next action mode, as Shift+Tab in the chat box does */
export async function cycleActionMode(): Promise<void> {
  const { actionMode } = await generalSettingsStore.getSettings();
  const next = ACTION_MODES[(ACTION_MODES.indexOf(actionMode) + 1) % ACTION_MODES.length];
  await generalSettingsStore.updateSettings({ actionMode: next });
}

/** How far the agent may act on pages: the button opens a panel with the three modes; Shift+Tab still cycles */
export default function ActionModePicker() {
  const [mode, setMode] = useState<ActionMode>('auto');
  const [open, setOpen] = useState(false);
  // the panel is fixed above the button, so the composer, which clips its content, does not cut it off
  const [anchor, setAnchor] = useState<{ left: number; bottom: number } | null>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const load = () => generalSettingsStore.getSettings().then(({ actionMode }) => setMode(actionMode));
    void load();
    return generalSettingsStore.subscribe(load);
  }, []);

  useEffect(() => {
    if (!open) return;
    // the document the button is in: the panel can be moved into a pinned window of its own
    const doc = buttonRef.current?.ownerDocument ?? document;
    const close = (event: MouseEvent | KeyboardEvent) => {
      if ('key' in event) {
        if (event.key !== 'Escape') return;
        setOpen(false);
        buttonRef.current?.focus();
        return;
      }
      const target = event.target as Node;
      if (!panelRef.current?.contains(target) && !buttonRef.current?.contains(target)) setOpen(false);
    };
    doc.addEventListener('mousedown', close);
    doc.addEventListener('keydown', close);
    panelRef.current?.querySelector<HTMLButtonElement>('[aria-checked="true"]')?.focus();
    return () => {
      doc.removeEventListener('mousedown', close);
      doc.removeEventListener('keydown', close);
    };
  }, [open]);

  const toggle = () => {
    const button = buttonRef.current;
    if (!button) return;
    const rect = button.getBoundingClientRect();
    const view = button.ownerDocument.defaultView ?? window;
    setAnchor({ left: rect.left, bottom: view.innerHeight - rect.top + 6 });
    setOpen(value => !value);
  };

  const choose = async (next: ActionMode) => {
    setOpen(false);
    setMode(next);
    buttonRef.current?.focus();
    await generalSettingsStore.updateSettings({ actionMode: next });
  };

  // up and down move between the modes, as in any menu
  const onPanelKey = (event: React.KeyboardEvent) => {
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
    event.preventDefault();
    const items = Array.from(panelRef.current?.querySelectorAll<HTMLButtonElement>('[role="menuitemradio"]') ?? []);
    const at = items.indexOf(event.target as HTMLButtonElement);
    const step = event.key === 'ArrowDown' ? 1 : -1;
    items[(at + step + items.length) % items.length]?.focus();
  };

  const { icon: Icon, label, tone } = MODES[mode];
  return (
    <>
      <button
        ref={buttonRef}
        type="button"
        onClick={toggle}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={`${t('chat_actionMode_label')}: ${t(label)}`}
        title={t('chat_actionMode_label')}
        className={`nb-mode-button flex min-w-0 items-center gap-1 rounded-md px-1.5 py-1 text-[11.5px] font-medium transition-colors hover:bg-nb-tile-2 ${tone}`}>
        <Icon className="size-3.5 shrink-0" aria-hidden="true" />
        <span className="shrink-0">{t(label)}</span>
        <FiChevronUp
          className={`size-3 shrink-0 text-nb-muted transition-transform ${open ? '' : 'rotate-180'}`}
          aria-hidden="true"
        />
      </button>
      {open && anchor && (
        <div
          ref={panelRef}
          role="menu"
          aria-label={t('chat_actionMode_label')}
          tabIndex={-1}
          onKeyDown={onPanelKey}
          className="nb-modes"
          style={{ left: anchor.left, bottom: anchor.bottom }}>
          <div className="nb-label px-2.5 pb-1 pt-1.5">{t('chat_actionMode_label')}</div>
          {ACTION_MODES.map(option => {
            const { icon: OptionIcon, label: optionLabel, desc, tone: optionTone } = MODES[option];
            const current = option === mode;
            return (
              <button
                key={option}
                type="button"
                role="menuitemradio"
                aria-checked={current}
                onClick={() => void choose(option)}>
                <OptionIcon className={`mt-0.5 size-3.5 shrink-0 ${optionTone}`} aria-hidden="true" />
                <span className="min-w-0 flex-1">
                  <b>{t(optionLabel)}</b>
                  <small>{t(desc)}</small>
                </span>
                <span className="nb-menu-check">{current && <FiCheck size={13} />}</span>
              </button>
            );
          })}
        </div>
      )}
    </>
  );
}
