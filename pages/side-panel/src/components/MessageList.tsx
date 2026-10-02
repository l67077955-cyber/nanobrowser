import {
  type DecisionAlternative,
  type JevTrace,
  type Message,
  type PageView,
  DEFAULT_GENERAL_SETTINGS,
  generalSettingsStore,
} from '@extension/storage';
import { t } from '@extension/i18n';
import { createContext, memo, useContext, useEffect, useMemo, useState } from 'react';
import type { IconType } from 'react-icons';
import {
  FiAlertCircle,
  FiArrowLeft,
  FiCheck,
  FiChevronDown,
  FiChevronsDown,
  FiClock,
  FiCommand,
  FiCompass,
  FiCopy,
  FiEdit3,
  FiGlobe,
  FiInfo,
  FiLayers,
  FiList,
  FiMousePointer,
  FiRotateCcw,
  FiSearch,
  FiSettings,
  FiShield,
  FiType,
  FiZap,
} from 'react-icons/fi';
import Markdown from './Markdown';
import { ViewFacts } from './ModelView';
import {
  type Entry,
  type NavigatorMeta,
  type PlannerMeta,
  type Turn,
  type WorkStats,
  answerText,
  classifyFailure,
  describeAction,
  describeStep,
  formatDuration,
  formatMs,
  groupTurns,
  hostOf,
  humanizeIntent,
  humanizeNote,
  planLines,
  shortModel,
  stepReason,
  workStats,
} from './steps';
import './StepList.css';

/** What the agent is doing right now, between the steps it has finished */
export interface Activity {
  phase: 'planning' | 'reading' | 'deciding' | 'acting' | 'waiting' | 'asking';
  /** the action under way, in the words of whoever chose it */
  text?: string;
  /** text is the model's own account of the whole step, not one action's */
  goal?: boolean;
  /** the page the model has just been shown */
  view?: PageView;
}

interface MessageListProps {
  messages: Message[];
  /** a task is under way: the last turn shows what is happening now */
  running: boolean;
  activity: Activity | null;
  /** show who decided each step, how sure and how fast */
  detailed: boolean;
  onRetry?: (task: string) => void;
}

// Long chats hold hundreds of rows; render the latest turns and fold the rest
const VISIBLE_MESSAGES = 80;
// A long run keeps its latest steps in view and folds the ones before
const VISIBLE_STEPS = 60;

interface ConfidenceFloors {
  operation: number;
  target: number;
}

// The Jev engine's floors from the settings, so the bars show how close a pick was to being deferred
const DEFAULT_FLOORS: ConfidenceFloors = {
  operation: DEFAULT_GENERAL_SETTINGS.fastModeMinOperationConfidence,
  target: DEFAULT_GENERAL_SETTINGS.fastModeMinTargetConfidence,
};
const FloorsContext = createContext(DEFAULT_FLOORS);

function useConfidenceFloors(): ConfidenceFloors {
  const [floors, setFloors] = useState(DEFAULT_FLOORS);
  useEffect(() => {
    const load = async () => {
      const settings = await generalSettingsStore.getSettings();
      setFloors({
        operation: settings.fastModeMinOperationConfidence,
        target: settings.fastModeMinTargetConfidence,
      });
    };
    load().catch(error => console.error('Error loading confidence floors:', error));
    return generalSettingsStore.subscribe(() => {
      load().catch(error => console.error('Error loading confidence floors:', error));
    });
  }, []);
  return floors;
}

/** The time, ticking once a second while something is under way */
function useNow(ticking: boolean): number {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (!ticking) return;
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [ticking]);
  return now;
}

const ACTION_ICONS: Record<string, IconType> = {
  click_element: FiMousePointer,
  input_text: FiType,
  solve_captcha: FiShield,
  go_to_url: FiGlobe,
  open_tab: FiGlobe,
  search_google: FiSearch,
  go_back: FiArrowLeft,
  wait: FiClock,
  switch_tab: FiLayers,
  close_tab: FiLayers,
  cache_content: FiEdit3,
  scroll_to_percent: FiChevronsDown,
  scroll_to_top: FiChevronsDown,
  scroll_to_bottom: FiChevronsDown,
  previous_page: FiChevronsDown,
  next_page: FiChevronsDown,
  scroll_to_text: FiSearch,
  send_keys: FiCommand,
  get_dropdown_options: FiList,
  select_dropdown_option: FiList,
  done: FiCheck,
};

const pct = (p: number) => `${Math.round(p * 100)}`;

export default memo(function MessageList({ messages, running, activity, detailed, onRetry }: MessageListProps) {
  const [showAll, setShowAll] = useState(false);
  const floors = useConfidenceFloors();
  const turns = useMemo(() => groupTurns(messages), [messages]);

  // whole turns are folded, the latest one never
  let firstShown = 0;
  if (!showAll) {
    let shown = 0;
    firstShown = Math.max(0, turns.length - 1);
    for (let i = turns.length - 1; i >= 0; i--) {
      shown += turns[i].size;
      if (shown > VISIBLE_MESSAGES && i < turns.length - 1) break;
      firstShown = i;
    }
  }
  const hidden = turns.slice(0, firstShown).reduce((sum, turn) => sum + turn.size, 0);

  return (
    <div className={`nb-stream${detailed ? ' detailed' : ''}`}>
      {hidden > 0 && (
        <button type="button" className="nb-more" onClick={() => setShowAll(true)}>
          {t('chat_steps_showEarlier', [String(hidden)])}
        </button>
      )}
      <FloorsContext.Provider value={floors}>
        {turns.slice(firstShown).map((turn, i) => {
          const isLast = i + firstShown === turns.length - 1;
          return (
            <TurnView
              key={`${turn.index}-${turn.startedAt}`}
              turn={turn}
              running={running && isLast}
              activity={isLast ? activity : null}
              detailed={detailed}
              onRetry={isLast && !running ? onRetry : undefined}
            />
          );
        })}
      </FloorsContext.Provider>
    </div>
  );
});

interface TurnViewProps {
  turn: Turn;
  running: boolean;
  activity: Activity | null;
  detailed: boolean;
  onRetry?: (task: string) => void;
}

function TurnView({ turn, running, activity, detailed, onRetry }: TurnViewProps) {
  const segments = turn.segments;
  // what is happening now is shown as work, also before the first step has finished
  const pendingWork = running && segments[segments.length - 1]?.kind !== 'work';
  // a task with files attached, or one another agent sent, cannot be sent again from its text
  const task = turn.user && !turn.user.content.includes('📎') ? turn.user.content : undefined;

  return (
    <section className="nb-turn">
      {turn.user && (
        <div className="nb-user" title={formatTime(turn.user.timestamp)}>
          {turn.user.content}
        </div>
      )}
      {segments.map((segment, i) => {
        const key =
          segment.kind === 'work' ? `work-${segment.entries[0].index}` : `${segment.kind}-${segment.entry.index}`;
        switch (segment.kind) {
          case 'work':
            return (
              <Work
                key={key}
                entries={segment.entries}
                startedAt={turn.startedAt}
                running={running && i === segments.length - 1}
                activity={activity}
                detailed={detailed}
              />
            );
          case 'answer':
            return <Answer key={key} message={segment.entry.message} detailed={detailed} />;
          case 'question':
            return <Question key={key} message={segment.entry.message} />;
          case 'failure':
            return (
              <Failure
                key={key}
                message={segment.entry.message}
                onRetry={onRetry && task ? () => onRetry(task) : undefined}
                onContinue={onRetry ? () => onRetry(t('chat_fail_continue_message')) : undefined}
              />
            );
          default:
            return <Notice key={key} message={segment.entry.message} />;
        }
      })}
      {pendingWork && <Work entries={[]} startedAt={turn.startedAt} running activity={activity} detailed={detailed} />}
    </section>
  );
}

interface WorkProps {
  entries: Entry[];
  startedAt: number;
  running: boolean;
  activity: Activity | null;
  detailed: boolean;
}

/** The steps taken for a request: open while they happen, one line once they are done */
function Work({ entries, startedAt, running, activity, detailed }: WorkProps) {
  const [chosen, setChosen] = useState<boolean | null>(null);
  const [showAll, setShowAll] = useState(false);
  const open = chosen ?? (running || detailed);
  const stats = useMemo(() => workStats(entries), [entries]);
  const now = useNow(running);

  // steps on a page the model had not been shown the step before are introduced by that page
  const newPages = useMemo(() => {
    const indices = new Set<number>();
    let shown: string | undefined;
    for (const entry of entries) {
      const meta = entry.message.meta;
      if (meta?.kind !== 'navigator' || !meta.view) continue;
      const page = meta.view.url.split('#')[0];
      if (page !== shown) indices.add(entry.index);
      shown = page;
    }
    return indices;
  }, [entries]);

  const last = entries[entries.length - 1];
  const elapsed = formatDuration((running ? now : (last?.message.timestamp ?? startedAt)) - startedAt);
  let title: string;
  if (running) title = `${t('chat_work_running')} · ${elapsed}`;
  else title = stats.steps > 0 ? t('chat_work_done', [elapsed]) : t('chat_work_thought', [elapsed]);
  const steps =
    stats.steps === 0 ? '' : stats.steps === 1 ? t('chat_work_steps_one') : t('chat_work_steps', [String(stats.steps)]);

  const folded = showAll ? 0 : Math.max(0, entries.length - VISIBLE_STEPS);

  return (
    <div className={`nb-work${open ? ' open' : ''}${running ? ' running' : ''}`}>
      <div className="nb-work-top">
        <button type="button" className="nb-work-head" aria-expanded={open} onClick={() => setChosen(!open)}>
          <span className="nb-work-mark" aria-hidden>
            {running ? <i className="nb-pulse" /> : <FiCheck />}
          </span>
          <span className="nb-work-title">{title}</span>
          {steps && <span className="nb-work-steps">· {steps}</span>}
          <FiChevronDown className="nb-chevron" aria-hidden />
        </button>
        {detailed && stats.steps > 0 && <SummaryChip stats={stats} />}
      </div>
      {open && (
        <div className="nb-work-body">
          {folded > 0 && (
            <button type="button" className="nb-more" onClick={() => setShowAll(true)}>
              {t('chat_steps_showEarlier', [String(folded)])}
            </button>
          )}
          <ol className="nb-trail">
            {entries.slice(folded).map(entry => (
              <TrailEntry
                key={`${entry.message.actor}-${entry.message.timestamp}-${entry.index}`}
                entry={entry}
                detailed={detailed}
                newPage={newPages.has(entry.index)}
              />
            ))}
            {running && <LiveItem activity={activity} />}
          </ol>
        </div>
      )}
    </div>
  );
}

function liveText(activity: Activity | null): string {
  switch (activity?.phase) {
    case 'planning':
      return t('chat_live_planning');
    case 'reading':
      return t('chat_live_reading');
    case 'deciding': {
      const page = activity.view && (activity.view.title || hostOf(activity.view.url));
      return page ? t('chat_live_deciding', [page]) : t('chat_live_working');
    }
    case 'acting':
      return activity.text && activity.text !== 'done' ? humanizeIntent(activity.text) : t('chat_live_wrappingUp');
    case 'waiting':
      return t('chat_live_waiting');
    case 'asking':
      return t('chat_live_asking');
    default:
      return t('chat_live_working');
  }
}

function LiveItem({ activity }: { activity: Activity | null }) {
  return (
    <li className="nb-item live" aria-live="polite">
      <div className="nb-line">
        <span className="nb-dot">
          <i className="nb-pulse" />
        </span>
        <span className="nb-say">
          <span className="nb-what nb-shimmer">{liveText(activity).replace(/[.…]+$/, '')}…</span>
        </span>
      </div>
    </li>
  );
}

function TrailEntry({ entry, detailed, newPage }: { entry: Entry; detailed: boolean; newPage: boolean }) {
  const { message, step } = entry;
  if (message.meta?.kind === 'navigator') {
    return (
      <>
        {newPage && message.meta.view && <PageMark view={message.meta.view} />}
        <NavigatorItem meta={message.meta} step={step} detailed={detailed} />
      </>
    );
  }
  if (message.meta?.kind === 'planner') {
    return <PlanItem meta={message.meta} content={message.content} detailed={detailed} />;
  }
  // Rows without a record: failed actions, replayed ones, and history saved before step records existed
  const failed = message.failed ?? /fail|error/i.test(message.content);
  return (
    <li className={`nb-item plain${failed ? ' bad' : ''}`}>
      <div className="nb-line">
        <span className="nb-dot">{failed ? <FiAlertCircle /> : <FiInfo />}</span>
        <span className="nb-say">
          <span className="nb-what">{message.content}</span>
        </span>
      </div>
    </li>
  );
}

/** The page the following steps happened on */
function PageMark({ view }: { view: PageView }) {
  const host = hostOf(view.url);
  return (
    <li className="nb-pagemark">
      <span className="nb-dot">
        <FiGlobe />
      </span>
      <span className="nb-pagemark-text" title={view.url}>
        {t('chat_step_page')} <b>{view.title || host}</b>
        {view.title && /^https?:/.test(view.url) && <small> {host}</small>}
      </span>
    </li>
  );
}

function NavigatorItem({ meta, step, detailed }: { meta: NavigatorMeta; step: number; detailed: boolean }) {
  const [open, setOpen] = useState(false);
  const floors = useContext(FloorsContext);
  const byJev = meta.engine === 'jev';
  const jev = meta.jev;
  const failed = meta.actions.filter(a => !a.ok);
  const Icon = ACTION_ICONS[meta.actions[0]?.name ?? ''] ?? FiZap;
  const reason = stepReason(meta);
  const more = meta.actions.length - 1;
  const pick = byJev && jev ? (jev.targetConfidence ?? jev.confidence) : undefined;
  const pickFloor = jev?.targetConfidence !== undefined ? floors.target : floors.operation;

  return (
    <li className={`nb-item${open ? ' open' : ''}${failed.length > 0 ? ' bad' : ''}`}>
      <button type="button" className="nb-line" aria-expanded={open} onClick={() => setOpen(!open)}>
        <span className="nb-dot">
          <Icon />
        </span>
        <span className="nb-say">
          <span className="nb-what">
            {describeStep(meta)}
            {more > 0 && <small> {t('chat_work_more', [String(more)])}</small>}
          </span>
          {reason && <span className="nb-why">{reason}</span>}
        </span>
        {detailed && (
          <span className="nb-metrics">
            <span className={`nb-chip ${byJev ? 'jev' : 'llm'}`} title={meta.model}>
              <i />
              {shortModel(meta.model)}
            </span>
            {pick !== undefined && <span className={pick < pickFloor ? 'low' : ''}>{pct(pick)}%</span>}
            <span>{formatMs(meta.latencyMs)}</span>
            <span className="nb-step">#{step}</span>
          </span>
        )}
      </button>
      {detailed && !byJev && jev?.deferred && (
        <div className="nb-note warn">
          {t('chat_steps_deferred', [jev.deferred])}
          {jev.target ? ` · ${jev.operation} ${jev.target}` : ''}
        </div>
      )}
      {failed.map((action, i) => (
        <div key={i} className="nb-note bad">
          {action === meta.actions[0] ? action.error : `${describeAction(action)}: ${action.error}`}
        </div>
      ))}
      {meta.notes?.map((note, i) => (
        <div key={i} className="nb-note warn">
          {detailed ? note : humanizeNote(note)}
        </div>
      ))}
      {open && (
        <div className="nb-detail">
          {meta.view && (
            <section>
              <h4 className="nb-label">{t('chat_step_saw')}</h4>
              <ViewFacts view={meta.view} />
            </section>
          )}
          <section>
            <h4 className="nb-label">{t('chat_step_decided')}</h4>
            {jev && <JevDetail trace={jev} deferred={!byJev} />}
            <div className="nb-kv">
              <span>{t('chat_steps_detail_model')}</span>
              <span>{meta.model}</span>
              <span>{t('chat_steps_detail_time')}</span>
              <span className="nb-num">{formatMs(meta.latencyMs)}</span>
              {meta.observeMs !== undefined && (
                <>
                  <span>{t('chat_steps_detail_observe')}</span>
                  <span className="nb-num">{formatMs(meta.observeMs)}</span>
                </>
              )}
              {meta.actMs !== undefined && (
                <>
                  <span>{t('chat_steps_detail_act')}</span>
                  <span className="nb-num">{formatMs(meta.actMs)}</span>
                </>
              )}
              {meta.goal && (
                <>
                  <span>{t('chat_steps_detail_goal')}</span>
                  <span>{meta.goal}</span>
                </>
              )}
            </div>
            {(more > 0 || failed.length > 0) && (
              <ul className="nb-actions">
                {meta.actions.map((action, i) => (
                  <li key={i} className={action.ok ? '' : 'bad'}>
                    <i />
                    <span>{describeAction(action)}</span>
                    {action.error && <span className="err">{action.error}</span>}
                  </li>
                ))}
              </ul>
            )}
          </section>
        </div>
      )}
    </li>
  );
}

function PlanItem({ meta, content, detailed }: { meta: PlannerMeta; content: string; detailed: boolean }) {
  const [open, setOpen] = useState(false);
  const lines = planLines(content);

  return (
    <li className={`nb-item plan${open ? ' open' : ''}`}>
      <button type="button" className="nb-line" aria-expanded={open} onClick={() => setOpen(!open)}>
        <span className="nb-dot">
          <FiCompass />
        </span>
        <span className="nb-say">
          <span className="nb-what">{t('chat_step_plan')}</span>
          {!open && lines[0] && <span className="nb-why">{lines[0]}</span>}
        </span>
        {detailed && (
          <span className="nb-metrics">
            <span className="nb-chip plan" title={meta.model}>
              <i />
              {shortModel(meta.model)}
            </span>
            <span>{formatMs(meta.latencyMs)}</span>
          </span>
        )}
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
    </li>
  );
}

/** The run's numbers as a small mark beside its line; the full card shows on hover, or stays when clicked */
function SummaryChip({ stats }: { stats: WorkStats }) {
  const [pinned, setPinned] = useState(false);
  const warn = stats.fallbacks > 0 || stats.errors > 0;
  return (
    <div className={`nb-sum${pinned ? ' pinned' : ''}`}>
      <button
        type="button"
        className="nb-sum-chip"
        aria-expanded={pinned}
        aria-label={t('chat_steps_summary_a11y')}
        onClick={() => setPinned(!pinned)}>
        <SharePie jev={stats.jev} llm={stats.llm} />
        <span className="nb-num">
          {stats.jev}·{stats.llm}
        </span>
        {warn && <i className="nb-sum-warn" aria-hidden />}
      </button>
      <Summary stats={stats} />
    </div>
  );
}

function Summary({ stats }: { stats: WorkStats }) {
  return (
    <div className="nb-summary" aria-label={t('chat_steps_summary_a11y')}>
      <SharePie jev={stats.jev} llm={stats.llm} />
      <div className="nb-stats">
        <div className="nb-stat">
          <span className="nb-label">{t('chat_steps_summary_steps')}</span>
          <b>{stats.steps}</b>
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

function JevDetail({ trace, deferred }: { trace: JevTrace; deferred: boolean }) {
  const floors = useContext(FloorsContext);
  // Jev picked nothing: there are no scores to show, only what happened
  if (trace.noPick) {
    return (
      <div className="nb-kv">
        <span>Jev</span>
        <span className="nb-num">
          {shortModel(trace.model)} · {formatMs(trace.latencyMs)}
        </span>
        <span>{t('chat_steps_detail_noPick')}</span>
        <span>{trace.noPick}</span>
      </div>
    );
  }
  return (
    <>
      <div className="nb-kv">
        <span>{t('chat_steps_detail_operation')}</span>
        <Bar value={trace.confidence} floor={floors.operation} />
        {trace.targetConfidence !== undefined && (
          <>
            <span>{t('chat_steps_detail_target')}</span>
            <Bar value={trace.targetConfidence} floor={floors.target} />
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
      {/* a step Jev passed on shows how it weighed the operations as well */}
      {deferred && trace.operations && (
        <Alternatives label={t('chat_steps_detail_operations')} alternatives={trace.operations} />
      )}
      <Alternatives label={t('chat_steps_detail_alternatives')} alternatives={trace.alternatives} />
    </>
  );
}

/** Scored options of one Jev question, the pick first */
function Alternatives({ label, alternatives }: { label: string; alternatives: DecisionAlternative[] }) {
  if (alternatives.length === 0) return null;
  const picked = alternatives[0].label;
  return (
    <div>
      <div className="nb-label" style={{ marginBottom: 4 }}>
        {label}
      </div>
      <ul className="nb-alts">
        {alternatives.map(alt => (
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

/** What the task came to: the part of a turn the user is waiting for */
function Answer({ message, detailed }: { message: Message; detailed: boolean }) {
  const [copied, setCopied] = useState(false);
  const meta = message.meta?.kind === 'planner' ? message.meta : undefined;
  const text = answerText(message.content).trim() || t('chat_answer_done');

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1600);
    } catch (error) {
      console.error('Failed to copy the answer:', error);
    }
  };

  return (
    <div className="nb-answer">
      <Markdown>{text}</Markdown>
      <div className="nb-answer-foot">
        <button type="button" className="nb-ghost" onClick={copy}>
          {copied ? <FiCheck aria-hidden /> : <FiCopy aria-hidden />}
          {copied ? t('chat_answer_copied') : t('chat_answer_copy')}
        </button>
        <span className="nb-time">
          {formatTime(message.timestamp)}
          {detailed && meta && ` · ${shortModel(meta.model)} · ${formatMs(meta.latencyMs)}`}
        </span>
      </div>
    </div>
  );
}

/** Something the agent asked mid-task: it goes on once the user replies */
function Question({ message }: { message: Message }) {
  return (
    <div className="nb-answer nb-question" title={formatTime(message.timestamp)}>
      <Markdown>{message.content}</Markdown>
    </div>
  );
}

// these are fixed in the settings, not by trying again
const SETTINGS_KINDS = ['setup', 'auth', 'forbidden', 'blocked'];

/** A task that ended badly: what happened in plain words, what to do about it, and the error for those who want it */
function Failure({
  message,
  onRetry,
  onContinue,
}: {
  message: Message;
  onRetry?: () => void;
  onContinue?: () => void;
}) {
  const { kind, raw } = classifyFailure(message.content);
  const [showRaw, setShowRaw] = useState(false);
  const settingsFirst = SETTINGS_KINDS.includes(kind);
  // running out of steps is a pause in the work, not an error: the way on is to carry on
  const paused = kind === 'maxSteps';
  const offerSettings = settingsFirst || kind === 'timeout';

  return (
    <div className={`nb-failure${paused ? ' soft' : ''}`} role={paused ? 'status' : 'alert'}>
      <div className="nb-failure-title">
        {paused ? <FiClock aria-hidden /> : <FiAlertCircle aria-hidden />}
        {t(`chat_fail_${kind}_title`)}
      </div>
      <p>{t(`chat_fail_${kind}_hint`)}</p>
      <div className="nb-failure-actions">
        {paused && onContinue && (
          <button type="button" className="nb-button primary" onClick={onContinue}>
            <FiChevronsDown aria-hidden />
            {t('chat_fail_continue')}
          </button>
        )}
        {offerSettings && (
          <button
            type="button"
            className={`nb-button${settingsFirst ? ' primary' : ''}`}
            onClick={() => chrome.runtime.openOptionsPage()}>
            <FiSettings aria-hidden />
            {t('chat_fail_settings')}
          </button>
        )}
        {onRetry && !paused && (
          <button type="button" className={`nb-button${settingsFirst ? '' : ' primary'}`} onClick={onRetry}>
            <FiRotateCcw aria-hidden />
            {t('chat_fail_retry')}
          </button>
        )}
        {raw && (
          <button
            type="button"
            className={`nb-disclose${showRaw ? ' open' : ''}`}
            aria-expanded={showRaw}
            onClick={() => setShowRaw(!showRaw)}>
            <FiChevronDown aria-hidden />
            {t('chat_fail_details')}
          </button>
        )}
      </div>
      {showRaw && <pre className="nb-failure-raw">{raw}</pre>}
    </div>
  );
}

/** Something the user should know that is neither work nor an answer: a stop, a saved memory */
function Notice({ message }: { message: Message }) {
  const stopped = message.content === t('exec_task_cancel');
  return (
    <div className="nb-notice" title={formatTime(message.timestamp)}>
      {stopped ? t('chat_notice_stopped') : message.content}
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
