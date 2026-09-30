import type { JevTrace, Message, StepMeta } from '@extension/storage';
import { t } from '@extension/i18n';
import { memo, useMemo, useState } from 'react';
import { ACTOR_PROFILES } from '../types/message';
import './StepList.css';

interface MessageListProps {
  messages: Message[];
}

type NavigatorMeta = Extract<StepMeta, { kind: 'navigator' }>;
type PlannerMeta = Extract<StepMeta, { kind: 'planner' }>;

const PROGRESS_MESSAGE = 'Showing progress...';
// Long runs produce hundreds of rows; render the tail and fold the rest
const VISIBLE_MESSAGES = 80;
// Mirrors the Jev engine's floors so the bars show how close a pick was to being deferred
const MIN_OPERATION_CONFIDENCE = 0.5;
const MIN_TARGET_CONFIDENCE = 0.6;

const OPERATION_NAMES: Record<string, string> = {
  click_element: 'CLICK',
  input_text: 'TYPE',
  select_dropdown_option: 'SELECT',
  get_dropdown_options: 'OPTIONS',
  go_to_url: 'OPEN',
  search_google: 'SEARCH',
  go_back: 'BACK',
  next_page: 'SCROLL',
  previous_page: 'SCROLL UP',
  scroll_to_percent: 'SCROLL',
  scroll_to_top: 'TOP',
  scroll_to_bottom: 'BOTTOM',
  scroll_to_text: 'FIND',
  send_keys: 'KEYS',
  switch_tab: 'TAB',
  open_tab: 'NEW TAB',
  close_tab: 'CLOSE TAB',
  cache_content: 'NOTE',
  wait: 'WAIT',
  done: 'DONE',
};

export const shortModel = (model: string) => (model.split('/').pop() ?? model).replace(/:latest$/, '');
export const formatMs = (ms: number) => (ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}s`);
const pct = (p: number) => `${Math.round(p * 100)}`;

interface StepStats {
  jev: number;
  llm: number;
  avgMs: number;
  fallbacks: number;
  errors: number;
}

export function stepStats(messages: Message[]): StepStats | null {
  const steps = messages.map(m => m.meta).filter((m): m is NavigatorMeta => m?.kind === 'navigator');
  if (steps.length === 0) return null;
  return {
    jev: steps.filter(s => s.engine === 'jev').length,
    llm: steps.filter(s => s.engine === 'llm').length,
    avgMs: Math.round(steps.reduce((sum, s) => sum + s.latencyMs, 0) / steps.length),
    fallbacks: steps.filter(s => s.engine === 'llm' && s.jev?.deferred).length,
    errors: steps.reduce((sum, s) => sum + s.actions.filter(a => !a.ok).length, 0),
  };
}

export default memo(function MessageList({ messages }: MessageListProps) {
  const [showAll, setShowAll] = useState(false);
  const stats = useMemo(() => stepStats(messages), [messages]);

  // Step numbers restart with every task the user sends
  const stepNumbers = useMemo(() => {
    let step = 0;
    return messages.map(m => {
      if (m.actor === 'user') step = 0;
      return m.meta?.kind === 'navigator' ? ++step : 0;
    });
  }, [messages]);

  const hidden = showAll ? 0 : Math.max(0, messages.length - VISIBLE_MESSAGES);

  return (
    <div className="nb-stream">
      {stats && <Summary stats={stats} />}
      {hidden > 0 && (
        <button type="button" className="nb-more" onClick={() => setShowAll(true)}>
          {t('chat_steps_showEarlier', [String(hidden)])}
        </button>
      )}
      {messages.slice(hidden).map((message, i) => {
        const index = i + hidden;
        return (
          <MessageRow
            key={`${message.actor}-${message.timestamp}-${index}`}
            message={message}
            step={stepNumbers[index]}
            isLast={index === messages.length - 1}
          />
        );
      })}
    </div>
  );
});

function Summary({ stats }: { stats: StepStats }) {
  const total = stats.jev + stats.llm;
  return (
    <div className="nb-summary" aria-label={t('chat_steps_summary_a11y')}>
      <SharePie jev={stats.jev} llm={stats.llm} />
      <div className="nb-stats">
        <div className="nb-stat">
          <span className="nb-label">{t('chat_steps_summary_steps')}</span>
          <b>{total}</b>
        </div>
        <div className="nb-stat">
          <span className="nb-label">Jev · LLM</span>
          <b>
            {stats.jev}
            <small> · {stats.llm}</small>
          </b>
        </div>
        <div className="nb-stat">
          <span className="nb-label">{t('chat_steps_summary_avg')}</span>
          <b>{formatMs(stats.avgMs)}</b>
        </div>
        {stats.fallbacks > 0 && (
          <div className="nb-stat warn">
            <span className="nb-label">{t('chat_steps_summary_fallbacks')}</span>
            <b>{stats.fallbacks}</b>
          </div>
        )}
        {stats.errors > 0 && (
          <div className="nb-stat warn">
            <span className="nb-label">{t('chat_steps_summary_errors')}</span>
            <b>{stats.errors}</b>
          </div>
        )}
      </div>
    </div>
  );
}

/** Full pie of steps decided by Jev vs the LLM */
function SharePie({ jev, llm }: { jev: number; llm: number }) {
  const total = jev + llm;
  const share = total ? jev / total : 0;
  const r = 15;
  let slice = null;
  if (share > 0 && share < 1) {
    const angle = share * 2 * Math.PI;
    const x = 15 + r * Math.sin(angle);
    const y = 15 - r * Math.cos(angle);
    slice = <path d={`M15 15 L15 0 A${r} ${r} 0 ${share > 0.5 ? 1 : 0} 1 ${x} ${y} Z`} fill="var(--nb-jev)" />;
  }
  return (
    <svg viewBox="0 0 30 30" role="img" aria-label={`Jev ${Math.round(share * 100)}%`}>
      <circle cx="15" cy="15" r={r} fill={share === 1 ? 'var(--nb-jev)' : 'var(--nb-llm)'} />
      {slice}
    </svg>
  );
}

function MessageRow({ message, step, isLast }: { message: Message; step: number; isLast: boolean }) {
  if (message.content === PROGRESS_MESSAGE) {
    return isLast ? (
      <div className="nb-progress">
        <div />
      </div>
    ) : null;
  }
  if (message.meta?.kind === 'navigator') return <NavigatorRow meta={message.meta} step={step} />;
  if (message.meta?.kind === 'planner') return <PlannerRow meta={message.meta} content={message.content} />;
  if (message.actor === 'user') {
    return (
      <div className="nb-user">
        <span className="nb-label">{t('chat_steps_you')}</span>
        {message.content}
      </div>
    );
  }
  // Messages without meta: system notices, failures, and history saved before step records existed
  const actor = ACTOR_PROFILES[message.actor as keyof typeof ACTOR_PROFILES];
  const failed = /fail|error/i.test(message.content);
  return (
    <div className={`nb-plain${failed ? ' bad' : ''}`}>
      <span className="nb-label">{actor?.name ?? message.actor}</span>
      <span>{message.content}</span>
      <span className="nb-time">{formatTime(message.timestamp)}</span>
    </div>
  );
}

function NavigatorRow({ meta, step }: { meta: NavigatorMeta; step: number }) {
  const [open, setOpen] = useState(false);
  const byJev = meta.engine === 'jev';
  const jev = meta.jev;
  const first = meta.actions[0];
  const failed = meta.actions.filter(a => !a.ok);

  let operation: string;
  let subject: string | undefined;
  if (byJev && jev) {
    operation = jev.operation;
    subject = jev.target;
  } else {
    operation = first ? (OPERATION_NAMES[first.name] ?? first.name) : '—';
    subject = [first?.target, first?.detail ?? meta.goal].filter(Boolean).join(' ');
  }
  const extra = meta.actions.length > 1 ? ` +${meta.actions.length - 1}` : '';
  const pick = byJev && jev ? (jev.targetConfidence ?? jev.confidence) : undefined;

  return (
    <div className={`nb-row${open ? ' open' : ''}`}>
      <button type="button" aria-expanded={open} onClick={() => setOpen(!open)}>
        <span className="nb-step">{step}</span>
        <span className={`nb-chip ${byJev ? 'jev' : 'llm'}`} title={meta.model}>
          <i />
          {shortModel(meta.model)}
        </span>
        <span className="nb-main">
          <span className="nb-op">{operation}</span>
          {subject && <span className="nb-sub"> {subject}</span>}
          {extra && <span className="nb-sub">{extra}</span>}
        </span>
        <span className="nb-metrics">
          {pick !== undefined && <span className={pick < MIN_TARGET_CONFIDENCE ? 'low' : ''}>{pct(pick)}%</span>}
          <span>{formatMs(meta.latencyMs)}</span>
        </span>
      </button>
      {!byJev && jev?.deferred && (
        <div className="nb-note warn">
          {t('chat_steps_deferred', [jev.deferred])}
          {jev.target ? ` · ${jev.operation} ${jev.target}` : ''}
        </div>
      )}
      {failed.map((action, i) => (
        <div key={i} className="nb-note bad">
          {OPERATION_NAMES[action.name] ?? action.name} {action.target}: {action.error}
        </div>
      ))}
      {open && (
        <div className="nb-detail">
          {jev && <JevDetail trace={jev} deferred={!byJev} />}
          <div className="nb-kv">
            <span>{t('chat_steps_detail_model')}</span>
            <span>{meta.model}</span>
            <span>{t('chat_steps_detail_time')}</span>
            <span className="nb-num">{formatMs(meta.latencyMs)}</span>
            {meta.goal && (
              <>
                <span>{t('chat_steps_detail_goal')}</span>
                <span>{meta.goal}</span>
              </>
            )}
          </div>
          {(!byJev || failed.length > 0) && (
            <ul className="nb-actions">
              {meta.actions.map((action, i) => (
                <li key={i} className={action.ok ? '' : 'bad'}>
                  <i />
                  <code>{action.name}</code>
                  <span>{action.detail ?? action.target}</span>
                  {action.error && <span className="err">{action.error}</span>}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}

function JevDetail({ trace, deferred }: { trace: JevTrace; deferred: boolean }) {
  const picked = trace.alternatives[0]?.label;
  return (
    <>
      <div className="nb-kv">
        <span>{t('chat_steps_detail_operation')}</span>
        <Bar value={trace.confidence} floor={MIN_OPERATION_CONFIDENCE} />
        {trace.targetConfidence !== undefined && (
          <>
            <span>{t('chat_steps_detail_target')}</span>
            <Bar value={trace.targetConfidence} floor={MIN_TARGET_CONFIDENCE} />
          </>
        )}
        {trace.margin !== undefined && (
          <>
            <span>{t('chat_steps_detail_margin')}</span>
            <span className="nb-num">{pct(trace.margin)} pts</span>
          </>
        )}
        {trace.path && (
          <>
            <span>{t('chat_steps_detail_narrowed')}</span>
            <span className="nb-num">{trace.path.join(' → ')}</span>
          </>
        )}
        {deferred && (
          <>
            <span>Jev</span>
            <span className="nb-num">
              {shortModel(trace.model)} · {formatMs(trace.latencyMs)}
            </span>
          </>
        )}
      </div>
      {trace.alternatives.length > 0 && (
        <div>
          <div className="nb-label" style={{ marginBottom: 4 }}>
            {t('chat_steps_detail_alternatives')}
          </div>
          <ul className="nb-alts">
            {trace.alternatives.map(alt => (
              <li key={alt.label} className={alt.label === picked ? 'picked' : ''}>
                <span title={alt.label}>{alt.label}</span>
                <span className="track">
                  <span className="fill" style={{ display: 'block', width: `${alt.p * 100}%` }} />
                </span>
                <b>{pct(alt.p)}%</b>
              </li>
            ))}
          </ul>
        </div>
      )}
    </>
  );
}

/** Confidence bar with a tick at the floor below which the step goes to the LLM */
function Bar({ value, floor }: { value: number; floor: number }) {
  return (
    <span className="nb-bar">
      <span className="track">
        <span className={`fill${value < floor ? ' low' : ''}`} style={{ width: `${value * 100}%` }} />
        <span className="mark" style={{ left: `${floor * 100}%` }} />
      </span>
      <b>{pct(value)}%</b>
    </span>
  );
}

/** Planner steps arrive as one string; models number them and sometimes double-escape newlines */
export function planLines(content: string): string[] {
  return content
    .split(/\\n|\n/)
    .map(line => line.replace(/^\s*\d+[.)]\s*/, '').trim())
    .filter(Boolean);
}

function PlannerRow({ meta, content }: { meta: PlannerMeta; content: string }) {
  const [open, setOpen] = useState(false);
  const lines = planLines(content);

  if (meta.done) {
    return (
      <div className="nb-answer">
        <div className="nb-label">
          {t('chat_steps_answer')}
          <span className="nb-num" style={{ textTransform: 'none', letterSpacing: 0, fontWeight: 500 }}>
            {shortModel(meta.model)} · {formatMs(meta.latencyMs)}
          </span>
        </div>
        {content}
      </div>
    );
  }

  return (
    <div className={`nb-row${open ? ' open' : ''}`}>
      <button type="button" aria-expanded={open} onClick={() => setOpen(!open)}>
        <span className="nb-step" />
        <span className="nb-chip plan" title={meta.model}>
          <i />
          {shortModel(meta.model)}
        </span>
        <span className="nb-main">
          <span className="nb-op">{t('chat_steps_plan')}</span>
          <span className="nb-sub"> {lines[0]}</span>
        </span>
        <span className="nb-metrics">
          <span>{formatMs(meta.latencyMs)}</span>
        </span>
      </button>
      {open && (
        <div className="nb-detail">
          <ol className="nb-plan-text">
            {lines.map((line, i) => (
              <li key={i}>{line}</li>
            ))}
          </ol>
        </div>
      )}
    </div>
  );
}

function formatTime(timestamp: number): string {
  const date = new Date(timestamp);
  const time = date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  return date.toDateString() === new Date().toDateString()
    ? time
    : `${date.toLocaleDateString([], { month: 'short', day: 'numeric' })}, ${time}`;
}
