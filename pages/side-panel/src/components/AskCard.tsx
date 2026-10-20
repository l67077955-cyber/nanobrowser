import { useEffect, useRef, useState } from 'react';
import { FiExternalLink, FiRefreshCw, FiX } from 'react-icons/fi';
import type { AskField } from '@extension/storage';
import { t } from '@extension/i18n';

/** What the agent waits for from the user: values to fill in, or something to do on the page */
export interface Ask {
  question: string;
  fields: AskField[];
  onPage: boolean;
}

interface AskCardProps {
  ask: Ask;
  /** pictures of the captchas asked for, by field: undefined while loading, null when there is none */
  captchas: Record<number, string | null | undefined>;
  onReveal: (field?: number) => void;
  onCaptcha: (field: number, refresh: boolean) => void;
  /** the reply as the agent reads it, and as the chat shows it */
  onReply: (text: string, display: string) => void;
  /** the user put the card away without answering */
  onDismiss: () => void;
}

const INPUT_PROPS: Record<AskField['kind'], React.InputHTMLAttributes<HTMLInputElement>> = {
  text: { type: 'text' },
  phone: { type: 'tel', inputMode: 'tel', autoComplete: 'tel' },
  email: { type: 'email', inputMode: 'email', autoComplete: 'email' },
  code: { type: 'text', inputMode: 'numeric', autoComplete: 'one-time-code' },
  captcha: { type: 'text', autoComplete: 'off', spellCheck: false },
};

// a code is good once and has no business staying readable in the chat
const masked = (field: AskField, value: string) =>
  field.kind === 'code' || field.kind === 'captcha' ? '•'.repeat(Math.min(value.length, 6)) : value;

/**
 * Sits above the input box while the agent waits: the values it asked for in one small form, the captcha
 * picture beside its field, and a way to the page the question is about. The user can answer in their own
 * words instead of filling the form, and can put the card away without answering at all.
 */
export default function AskCard({ ask, captchas, onReveal, onCaptcha, onReply, onDismiss }: AskCardProps) {
  const [values, setValues] = useState<string[]>(() => ask.fields.map(() => ''));
  /** the answer in the user's own words, for what the form does not cover */
  const [other, setOther] = useState('');
  const [showOther, setShowOther] = useState(false);
  const inputs = useRef<(HTMLInputElement | null)[]>([]);
  const otherRef = useRef<HTMLTextAreaElement>(null);
  const cardRef = useRef<HTMLFormElement>(null);

  useEffect(() => {
    setValues(ask.fields.map(() => ''));
    setOther('');
    setShowOther(false);
    ask.fields.forEach((field, i) => field.kind === 'captcha' && onCaptcha(i, false));
    inputs.current[0]?.focus();
    // a new question, not a new render, asks for the pictures again
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ask]);

  // Escape puts the card away: the agent is told that no answer came
  useEffect(() => {
    // the document the card is in: the panel can be moved into a pinned window, whose events are of its own realm
    const doc = cardRef.current?.ownerDocument ?? document;
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.defaultPrevented) return;
      event.preventDefault();
      onDismiss();
    };
    doc.addEventListener('keydown', onKey);
    return () => doc.removeEventListener('keydown', onKey);
  }, [onDismiss]);

  const filled = values.some(value => value.trim());
  const free = other.trim();

  const submit = () => {
    if (ask.fields.length === 0) {
      if (!free) {
        onReply('Done.', t('chat_ask_done'));
        return;
      }
      onReply(free, free);
      return;
    }
    const given = ask.fields.map((field, i) => ({ field, value: values[i].trim() }));
    const answered = given.filter(given => given.value);
    if (!free && answered.length === 0) return;
    // what the user typed in the form, and their own words for what they left out
    const lines = free
      ? [...answered.map(({ field, value }) => `${field.label}: ${value}`), free]
      : given.map(({ field, value }) => `${field.label}: ${value || '(left empty)'}`);
    const shown = [
      ...answered.map(({ field, value }) => `${field.label}: ${masked(field, value)}`),
      ...(free ? [free] : []),
    ].join(' · ');
    onReply(lines.join('\n'), shown);
  };

  const onKeyDown = (event: React.KeyboardEvent<HTMLInputElement>, i: number) => {
    if (event.key !== 'Enter' || event.nativeEvent.isComposing) return;
    event.preventDefault();
    const next = inputs.current[i + 1];
    if (next && !values[i + 1]) next.focus();
    else submit();
  };

  const onOtherKeyDown = (event: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key !== 'Enter' || event.shiftKey || event.nativeEvent.isComposing) return;
    event.preventDefault();
    submit();
  };

  return (
    <form
      ref={cardRef}
      className="nb-ask"
      aria-label={ask.question}
      onSubmit={event => {
        event.preventDefault();
        submit();
      }}>
      <div className="nb-ask-head">
        <p className="nb-ask-question">{ask.question}</p>
        <div className="nb-ask-tools">
          <button type="button" className="nb-button" onClick={() => onReveal()} title={t('chat_ask_reveal_title')}>
            <FiExternalLink aria-hidden />
            {t('chat_ask_reveal')}
          </button>
          <button
            type="button"
            className="nb-ask-close"
            onClick={onDismiss}
            aria-label={t('chat_ask_close')}
            title={t('chat_ask_close')}>
            <FiX aria-hidden />
          </button>
        </div>
      </div>
      {ask.fields.length > 0 && (
        <div className="nb-ask-fields">
          {ask.fields.map((field, i) => (
            <div key={`${i}-${field.label}`} className="nb-ask-field">
              <label className="nb-ask-label" htmlFor={`nb-ask-field-${i}`} title={field.label}>
                {field.label}
              </label>
              <div className="nb-ask-input">
                {field.kind === 'captcha' && (
                  <span className="nb-ask-captcha">
                    {captchas[i] ? (
                      <button type="button" onClick={() => onReveal(i)} title={t('chat_ask_reveal_title')}>
                        <img src={`data:image/png;base64,${captchas[i]}`} alt={field.label} />
                      </button>
                    ) : captchas[i] === undefined ? (
                      <em>{t('chat_ask_captcha_loading')}</em>
                    ) : (
                      <em>{t('chat_ask_captcha_onPage')}</em>
                    )}
                    <button
                      type="button"
                      className="nb-ask-icon"
                      onClick={() => onCaptcha(i, true)}
                      aria-label={t('chat_ask_captcha_refresh')}
                      title={t('chat_ask_captcha_refresh')}>
                      <FiRefreshCw aria-hidden />
                    </button>
                  </span>
                )}
                <input
                  id={`nb-ask-field-${i}`}
                  ref={element => {
                    inputs.current[i] = element;
                  }}
                  {...INPUT_PROPS[field.kind]}
                  value={values[i] ?? ''}
                  onChange={event => setValues(prev => prev.map((value, j) => (j === i ? event.target.value : value)))}
                  onKeyDown={event => onKeyDown(event, i)}
                />
              </div>
            </div>
          ))}
        </div>
      )}
      {showOther && (
        <textarea
          ref={otherRef}
          className="nb-ask-other"
          rows={2}
          value={other}
          placeholder={t('chat_ask_other_placeholder')}
          onChange={event => setOther(event.target.value)}
          onKeyDown={onOtherKeyDown}
        />
      )}
      <div className="nb-ask-foot">
        <button
          type="button"
          className="nb-ask-other-toggle"
          aria-expanded={showOther}
          onClick={() => {
            const next = !showOther;
            setShowOther(next);
            if (next) otherRef.current?.focus();
          }}>
          {t('chat_ask_other')}
        </button>
        <button type="submit" className="nb-button primary" disabled={ask.fields.length > 0 && !filled && !free}>
          {ask.fields.length > 0 ? t('chat_ask_submit') : t('chat_ask_done')}
        </button>
      </div>
    </form>
  );
}
