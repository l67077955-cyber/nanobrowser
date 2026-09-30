import { useState, useEffect, useCallback } from 'react';
import { generalSettingsStore, memoryStore, MAX_MEMORIES, type MemoryEntry } from '@extension/storage';
import { Button } from '@extension/ui';
import { t } from '@extension/i18n';

const TOGGLE_LABEL = `peer h-6 w-11 rounded-full bg-nb-track after:absolute after:left-[2px] after:top-[2px] after:size-5 after:rounded-full after:border after:border-nb-line after:bg-nb-tile after:transition-all after:content-[''] peer-checked:bg-nb-llm peer-checked:after:translate-x-full peer-checked:after:border-nb-llm peer-focus:outline-none peer-focus-visible:ring-2 peer-focus-visible:ring-nb-llm`;
const INPUT = `flex-1 rounded-md border border-nb-line bg-nb-tile-2 px-3 py-2 text-sm text-nb-ink focus:border-nb-llm focus:outline-none`;
const QUIET_BUTTON = `border border-nb-line bg-nb-tile-2 px-2 py-1 text-xs text-nb-ink-2 shadow-none hover:bg-nb-tile hover:text-nb-ink`;

export const MemorySettings = () => {
  const [enabled, setEnabled] = useState(true);
  const [autoExtract, setAutoExtract] = useState(true);
  const [memories, setMemories] = useState<MemoryEntry[]>([]);
  const [draft, setDraft] = useState('');
  const [editing, setEditing] = useState<{ id: string; text: string } | null>(null);
  const [notice, setNotice] = useState('');

  const load = useCallback(async () => {
    const settings = await generalSettingsStore.getSettings();
    setEnabled(settings.memoryEnabled);
    setAutoExtract(settings.memoryAutoExtract);
    const entries = await memoryStore.getAll();
    setMemories([...entries].sort((a, b) => b.updatedAt - a.updatedAt));
  }, []);

  useEffect(() => {
    load();
    // the background adds memories while this page is open
    return memoryStore.subscribe(load);
  }, [load]);

  const full = memories.length >= MAX_MEMORIES;

  const toggle = async (key: 'memoryEnabled' | 'memoryAutoExtract', value: boolean) => {
    await generalSettingsStore.updateSettings({ [key]: value });
    await load();
  };

  const handleAdd = async () => {
    const text = draft.trim();
    if (!text) return;
    if (full) return setNotice(t('options_memory_full'));
    const stored = await memoryStore.add(text);
    setNotice(stored ? '' : t('options_memory_secretRejected'));
    if (stored) setDraft('');
    await load();
  };

  const handleSave = async () => {
    if (!editing) return;
    const text = editing.text.trim();
    if (!text) return;
    const stored = await memoryStore.update(editing.id, text);
    setNotice(stored ? '' : t('options_memory_secretRejected'));
    if (stored) setEditing(null);
    await load();
  };

  const handleClear = async () => {
    if (!window.confirm(t('options_memory_confirmClearAll'))) return;
    await memoryStore.clear();
    await load();
  };

  return (
    <section className="space-y-6">
      <div className={`rounded-xl border border-nb-line bg-nb-tile p-6 text-left shadow-nb`}>
        <h2 className={`mb-4 text-base font-semibold tracking-tight text-nb-ink`}>{t('options_memory_header')}</h2>

        <div className="space-y-4">
          {(
            [
              ['memoryEnabled', enabled, 'options_memory_enable', 'options_memory_enable_desc'],
              ['memoryAutoExtract', autoExtract, 'options_memory_autoExtract', 'options_memory_autoExtract_desc'],
            ] as const
          ).map(([key, value, title, desc]) => (
            <div key={key} className="flex items-center justify-between">
              <div>
                <h3 className={`text-base font-medium text-nb-ink-2`}>{t(title)}</h3>
                <p className={`text-sm font-normal text-nb-muted`}>{t(desc)}</p>
              </div>
              <div className="relative inline-flex cursor-pointer items-center">
                <input
                  id={key}
                  type="checkbox"
                  checked={value}
                  disabled={key === 'memoryAutoExtract' && !enabled}
                  onChange={e => toggle(key, e.target.checked)}
                  className="peer sr-only"
                />
                <label htmlFor={key} className={TOGGLE_LABEL}>
                  <span className="sr-only">{t(title)}</span>
                </label>
              </div>
            </div>
          ))}
        </div>
      </div>

      <div className={`rounded-xl border border-nb-line bg-nb-tile p-6 text-left shadow-nb`}>
        <div className="mb-4 flex items-center justify-between">
          <h2 className={`text-base font-semibold tracking-tight text-nb-ink`}>
            {t('options_memory_list_header')}{' '}
            <span className="ml-1 text-sm font-normal text-nb-muted">
              {t('options_memory_count', [String(memories.length), String(MAX_MEMORIES)])}
            </span>
          </h2>
          {memories.length > 0 && (
            <Button onClick={handleClear} variant="danger" className="px-2 py-1 text-xs">
              {t('options_memory_btnClearAll')}
            </Button>
          )}
        </div>

        <div className="mb-4 flex space-x-2">
          <input
            id="memory-input"
            type="text"
            value={draft}
            onChange={e => setDraft(e.target.value)}
            onKeyDown={e => {
              if (e.key === 'Enter') handleAdd();
            }}
            placeholder={t('options_memory_placeholder')}
            aria-label={t('options_memory_placeholder')}
            className={INPUT}
          />
          <Button onClick={handleAdd} className="px-4 py-2 text-sm">
            {t('options_firewall_btnAdd')}
          </Button>
        </div>
        {notice && (
          <p role="status" className="-mt-2 mb-4 text-sm text-nb-ink-2">
            {notice}
          </p>
        )}

        {memories.length > 0 ? (
          <ul className="space-y-2">
            {memories.map(memory => (
              <li
                key={memory.id}
                className={`flex items-center justify-between gap-2 rounded-md border border-nb-hair bg-nb-tile-2 p-2`}>
                {editing?.id === memory.id ? (
                  <>
                    <input
                      type="text"
                      value={editing.text}
                      onChange={e => setEditing({ id: memory.id, text: e.target.value })}
                      onKeyDown={e => {
                        if (e.key === 'Enter') handleSave();
                        if (e.key === 'Escape') setEditing(null);
                      }}
                      aria-label={t('options_memory_btnEdit')}
                      className={INPUT}
                    />
                    <Button onClick={handleSave} className="px-2 py-1 text-xs">
                      {t('options_models_providers_btnSave')}
                    </Button>
                    <Button onClick={() => setEditing(null)} className={QUIET_BUTTON}>
                      {t('options_models_providers_btnCancel')}
                    </Button>
                  </>
                ) : (
                  <>
                    <span className={`flex-1 text-sm text-nb-ink`}>{memory.content}</span>
                    <Button
                      onClick={() => setEditing({ id: memory.id, text: memory.content })}
                      className={QUIET_BUTTON}>
                      {t('options_memory_btnEdit')}
                    </Button>
                    <Button
                      onClick={() => memoryStore.remove(memory.id).then(load)}
                      variant="danger"
                      className="px-2 py-1 text-xs">
                      {t('options_models_providers_btnDelete')}
                    </Button>
                  </>
                )}
              </li>
            ))}
          </ul>
        ) : (
          <p className={`text-center text-sm text-nb-muted`}>{t('options_memory_empty')}</p>
        )}
      </div>

      <div className={`rounded-xl border border-nb-line bg-nb-tile p-6 text-left shadow-nb`}>
        <h2 className={`mb-4 text-base font-semibold tracking-tight text-nb-ink`}>
          {t('options_memory_howItWorks_header')}
        </h2>
        <ul className={`list-disc space-y-2 pl-5 text-left text-sm text-nb-ink-2`}>
          {t('options_memory_howItWorks')
            .split('\n')
            .map((rule, index) => (
              <li key={index}>{rule}</li>
            ))}
        </ul>
      </div>
    </section>
  );
};
