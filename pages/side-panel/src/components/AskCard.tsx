import { useEffect, useRef, useState } from 'react';
import { FiExternalLink, FiRefreshCw } from 'react-icons/fi';
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
 * picture beside its field, and a way to the page the question is about. Anything else is answered in the chat.
 */
export default function AskCard({ ask, captchas, onReveal, onCaptcha, onReply }: AskCardProps) {
  const [values, setValues] = useState<string[]>(() => ask.fields.map(() => ''));
  const inputs = useRef<(HTMLInputElement | null)[]>([]);

  useEffect(() => {
    setValues(ask.fields.map(() => ''));
    ask.fields.forEach((field, i) => field.kind === 'captcha' && onCaptcha(i, false));
    inputs.current[0]?.focus();
    // a new question, not a new render, asks for the pictures again
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ask]);

  const filled = values.some(value => value.trim());

  const submit = () => {
    if (ask.fields.length === 0) {
      onReply('Done.', t('chat_ask_done'));
      return;
    }
    if (!filled) return;
    const given = ask.fields.map((field, i) => ({ field, value: values[i].trim() }));
    onReply(
      given.map(({ field, value }) => `${field.label}: ${value || '(left empty)'}`).join('\n'),
      given
        .filter(({ value }) => value)
        .map(({ field, value }) => `${field.label}: ${masked(field, value)}`)
        .join(' · '),
    );
  };

  const onKeyDown = (event: React.KeyboardEvent<HTMLInputElement>, i: number) => {
    if (event.key !== 'Enter' || event.nativeEvent.isComposing) return;
    event.preventDefault();
    const next = inputs.current[i + 1];
    if (next && !values[i + 1]) next.focus();
    else submit();
  };

  return (
    <form
      className="nb-ask"
      aria-label={ask.question}
      onSubmit={event => {
        event.preventDefault();
        submit();
      }}>
      <div className="nb-ask-head">
        <p>{ask.question}</p>
        <button type="button" className="nb-button" onClick={() => onReveal()} title={t('chat_ask_reveal_title')}>
          <FiExternalLink aria-hidden />
          {t('chat_ask_reveal')}
        </button>
      </div>
      {ask.fields.map((field, i) => (
        <label key={`${i}-${field.label}`} className="nb-ask-row">
          <span title={field.label}>{field.label}</span>
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
            ref={element => {
              inputs.current[i] = element;
            }}
            {...INPUT_PROPS[field.kind]}
            value={values[i] ?? ''}
            onChange={event => setValues(prev => prev.map((value, j) => (j === i ? event.target.value : value)))}
            onKeyDown={event => onKeyDown(event, i)}
          />
        </label>
      ))}
      <div className="nb-ask-foot">
        <button type="submit" className="nb-button primary" disabled={ask.fields.length > 0 && !filled}>
          {ask.fields.length > 0 ? t('chat_ask_submit') : t('chat_ask_done')}
        </button>
      </div>
    </form>
  );
}
