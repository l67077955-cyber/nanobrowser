import type { PageView } from '@extension/storage';
import { t } from '@extension/i18n';
import { useEffect, useRef, useState } from 'react';
import { FiChevronDown, FiCpu, FiEye, FiGlobe, FiImage, FiLayers, FiMaximize2, FiMousePointer } from 'react-icons/fi';
import { formatTokens, hostOf } from './steps';

const percent = (share: number) => String(Math.round(share * 100));

/** What the model was given about a page, as a short list a person can read */
export function ViewFacts({ view }: { view: PageView }) {
  const [showText, setShowText] = useState(false);
  const isWebPage = /^https?:/.test(view.url);
  const wholePage = view.seen && view.seen[0] <= 0 && view.seen[1] >= 1;

  let elements: string;
  if (view.unreadable) elements = t('chat_view_unreadable');
  else if (view.elements === 0) elements = t('chat_view_elements_none');
  else elements = t('chat_view_elements', [String(view.elements)]);

  return (
    <div className="nb-view">
      <ul className="nb-facts">
        <li>
          <FiGlobe aria-hidden />
          <span>
            {isWebPage ? (
              <a href={view.url} target="_blank" rel="noopener noreferrer" title={view.url}>
                {view.title || hostOf(view.url)}
              </a>
            ) : (
              view.title || view.url
            )}
            {view.title && isWebPage && <small> {hostOf(view.url)}</small>}
          </span>
        </li>
        <li className={view.unreadable ? 'warn' : ''}>
          <FiMousePointer aria-hidden />
          <span>{elements}</span>
        </li>
        {view.seen && !view.unreadable && (
          <li>
            <FiMaximize2 aria-hidden />
            <span>
              {wholePage
                ? t('chat_view_seen_all')
                : t('chat_view_seen_part', [percent(view.seen[0]), percent(view.seen[1])])}
            </span>
          </li>
        )}
        <li>
          <FiImage aria-hidden />
          <span>{view.screenshot ? t('chat_view_screenshot_yes') : t('chat_view_screenshot_no')}</span>
        </li>
        {view.tabs > 0 && (
          <li>
            <FiLayers aria-hidden />
            <span>{view.tabs === 1 ? t('chat_view_tabs_one') : t('chat_view_tabs', [String(view.tabs)])}</span>
          </li>
        )}
        {view.tokens !== undefined && view.maxTokens !== undefined && (
          <li>
            <FiCpu aria-hidden />
            <span>
              {t('chat_view_tokens', [formatTokens(view.tokens), formatTokens(view.maxTokens)])}
              <span className="nb-meter" aria-hidden>
                <span style={{ width: `${Math.min(100, (view.tokens / view.maxTokens) * 100)}%` }} />
              </span>
            </span>
          </li>
        )}
      </ul>
      {view.text === undefined ? (
        <p className="nb-view-gone">{t('chat_view_text_gone')}</p>
      ) : (
        view.text !== '' && (
          <>
            <button
              type="button"
              className={`nb-disclose${showText ? ' open' : ''}`}
              aria-expanded={showText}
              onClick={() => setShowText(!showText)}>
              <FiChevronDown aria-hidden />
              {t('chat_view_text_show')}
            </button>
            {showText && <pre className="nb-page-text">{view.text}</pre>}
          </>
        )
      )}
    </div>
  );
}

/** A line in the composer's toolbar that says what the model is looking at, and opens to show it above the composer */
export default function ContextPeek({ view, live }: { view: PageView; live: boolean }) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const share =
    view.tokens !== undefined && view.maxTokens ? Math.round((view.tokens / view.maxTokens) * 100) : undefined;

  // it floats over the stream, so a click elsewhere or Escape puts it away
  useEffect(() => {
    if (!open) return;
    const onPointer = (e: PointerEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    // the panel can be moved into a pinned window, which has a document of its own
    const doc = rootRef.current?.ownerDocument ?? document;
    doc.addEventListener('pointerdown', onPointer);
    doc.addEventListener('keydown', onKey);
    return () => {
      doc.removeEventListener('pointerdown', onPointer);
      doc.removeEventListener('keydown', onKey);
    };
  }, [open]);

  return (
    <div ref={rootRef} className={`nb-peek${open ? ' open' : ''}`}>
      <button type="button" aria-expanded={open} onClick={() => setOpen(!open)} title={view.title || hostOf(view.url)}>
        <span className={`nb-peek-eye${live ? ' live' : ''}`}>
          <FiEye aria-hidden />
        </span>
        <span className="nb-peek-title">
          <span className="nb-peek-verb">{live ? t('chat_view_seeing') : t('chat_view_saw')}</span>{' '}
          {view.title || hostOf(view.url)}
        </span>
        <span className="nb-peek-sum">
          {t('chat_view_summary', [String(view.elements)])}
          {share !== undefined && ` · ${share}%`}
        </span>
        <FiChevronDown className="nb-peek-chevron" aria-hidden />
      </button>
      {open && (
        <div className="nb-peek-body">
          <p className="nb-peek-intro">{t('chat_view_intro')}</p>
          <ViewFacts view={view} />
        </div>
      )}
    </div>
  );
}
