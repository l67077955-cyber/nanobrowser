import { useEffect, useRef, useState } from 'react';
import { FiDownload, FiX } from 'react-icons/fi';
import { t } from '@extension/i18n';
import type { ExportedFile, ExportFormat } from '@extension/shared';

const FORMATS: { id: ExportFormat; label: string; hint: string }[] = [
  { id: 'debug', label: t('chat_export_debug'), hint: t('chat_export_debug_hint') },
  { id: 'log', label: t('chat_export_log'), hint: t('chat_export_log_hint') },
  { id: 'txt', label: t('chat_export_txt'), hint: t('chat_export_txt_hint') },
  { id: 'md', label: t('chat_export_md'), hint: t('chat_export_md_hint') },
  { id: 'html', label: t('chat_export_html'), hint: t('chat_export_html_hint') },
  { id: 'pdf', label: t('chat_export_pdf'), hint: t('chat_export_pdf_hint') },
];

const LAST_FORMAT_KEY = 'nb-export-format';

/** Files a chat is taken back in from */
export const IMPORT_ACCEPT = '.json,.txt,.md,.markdown,.html,.htm,.log,.pdf';

/** Saves a file the background made, the way a download link does */
function save(file: ExportedFile): void {
  const body = file.base64 ? Uint8Array.from(atob(file.data), ch => ch.charCodeAt(0)) : file.data;
  const url = URL.createObjectURL(new Blob([body], { type: file.mime }));
  const link = document.createElement('a');
  link.href = url;
  link.download = file.filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

function readLastFormat(): ExportFormat {
  try {
    const stored = localStorage.getItem(LAST_FORMAT_KEY);
    return FORMATS.some(format => format.id === stored) ? (stored as ExportFormat) : 'debug';
  } catch {
    return 'debug';
  }
}

/** Picks a format and saves the chat in it */
export function ExportDialog({ sessionId, onClose }: { sessionId: string; onClose: () => void }) {
  const [format, setFormat] = useState<ExportFormat>(readLastFormat);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  // the side panel passes a new onClose with each of its renders: focus is set only when the dialog opens
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  useEffect(() => {
    dialogRef.current?.querySelector<HTMLInputElement>('input:checked')?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onCloseRef.current();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const exportNow = async () => {
    setBusy(true);
    setError(null);
    try {
      localStorage.setItem(LAST_FORMAT_KEY, format);
    } catch {
      // only a convenience
    }
    try {
      const reply = (await chrome.runtime.sendMessage({ type: 'export_chat', sessionId, format })) as
        | { file?: ExportedFile; error?: string }
        | undefined;
      if (!reply?.file) throw new Error(reply?.error || t('chat_export_failed'));
      save(reply.file);
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-end justify-center bg-black/30 p-3 sm:items-center"
      onClick={e => {
        if (e.target === e.currentTarget) onClose();
      }}
      role="presentation">
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="nb-export-title"
        className="w-full max-w-[360px] rounded-2xl border border-nb-line bg-nb-tile p-3 text-nb-ink shadow-lg">
        <div className="mb-2 flex items-center justify-between px-1">
          <h2 id="nb-export-title" className="text-[14px] font-semibold">
            {t('chat_export_title')}
          </h2>
          <button type="button" className="header-icon" onClick={onClose} aria-label={t('chat_export_close')}>
            <FiX size={15} />
          </button>
        </div>
        <fieldset className="flex flex-col gap-0.5" disabled={busy}>
          <legend className="sr-only">{t('chat_export_format')}</legend>
          {FORMATS.map(option => (
            <div
              key={option.id}
              className={`flex items-start gap-2.5 rounded-lg px-2 py-1.5 hover:bg-nb-tile-2 ${
                format === option.id ? 'bg-nb-tile-2' : ''
              }`}>
              <input
                id={`nb-export-${option.id}`}
                type="radio"
                name="nb-export-format"
                value={option.id}
                checked={format === option.id}
                onChange={() => setFormat(option.id)}
                aria-describedby={`nb-export-${option.id}-hint`}
                className="mt-[3px] accent-[var(--nb-llm,#3b6fd8)]"
              />
              <div className="min-w-0">
                <label htmlFor={`nb-export-${option.id}`} className="block cursor-pointer text-[13px] font-medium">
                  {option.label}
                </label>
                <span id={`nb-export-${option.id}-hint`} className="block text-[11.5px] leading-snug text-nb-muted">
                  {option.hint}
                </span>
              </div>
            </div>
          ))}
        </fieldset>
        {error && (
          <p role="alert" className="mt-2 px-1 text-[12px] text-nb-critical">
            {error}
          </p>
        )}
        <button
          type="button"
          onClick={exportNow}
          disabled={busy}
          className="mt-3 flex w-full items-center justify-center gap-2 rounded-lg bg-nb-ink px-3 py-2 text-[13px] font-medium text-nb-tile disabled:opacity-60">
          <FiDownload size={14} aria-hidden="true" />
          {busy ? t('chat_export_working') : t('chat_export_save')}
        </button>
      </div>
    </div>
  );
}

/** Takes a chat in from a file and returns the id of the new chat */
export async function importChatFile(file: File): Promise<string> {
  const pdf = /\.pdf$/i.test(file.name) || file.type === 'application/pdf';
  // a PDF's text is read here; the background takes it like any text
  const text = pdf ? await (await import('../pdfText')).pdfText(file) : await file.text();
  if (!text.trim()) throw new Error(t('chat_import_empty'));
  const reply = (await chrome.runtime.sendMessage({ type: 'import_chat', name: file.name, text })) as
    | { sessionId?: string; error?: string }
    | undefined;
  if (!reply?.sessionId) throw new Error(reply?.error || t('chat_import_failed'));
  return reply.sessionId;
}
