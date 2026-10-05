import { t } from '@extension/i18n';
import { Actors, type Message, type ScheduledTask, scheduleStore } from '@extension/storage';
import { useEffect, useMemo, useState } from 'react';
import { FiArrowUpRight, FiChevronDown, FiClock, FiCornerDownRight, FiPlay, FiX } from 'react-icons/fi';
import { type Activity, liveText } from './MessageList';
import { formatWhen } from './RoutineList';
import { formatDuration, hostOf, planLines } from './steps';

interface AgentDockProps {
  messages: Message[];
  running: boolean;
  activity: Activity | null;
  /** goals to take on, in turn, once the one under way is done */
  queue: string[];
  /** the queue waits: the last goal failed or was stopped */
  queueHeld: boolean;
  onUnqueue: (index: number) => void;
  onResumeQueue: () => void;
  /** a follow-up the planner offered was picked */
  onPick: (task: string) => void;
}

type Phase = Activity['phase'] | 'idle';

/** Where the latest request stands, read from the chat: its plan, its steps, what could follow */
function useLatestTurn(messages: Message[]) {
  return useMemo(() => {
    let start = -1;
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i].actor === Actors.USER) {
        start = i;
        break;
      }
    }
    let plan: string[] = [];
    let followUps: string[] = [];
    let steps = 0;
    for (const message of messages.slice(start + 1)) {
      const meta = message.meta;
      if (meta?.kind === 'navigator') steps++;
      if (message.actor !== Actors.PLANNER || meta?.kind !== 'planner') continue;
      if (meta.done) {
        plan = [];
        followUps = meta.followUps ?? [];
      } else {
        plan = planLines(message.content);
        followUps = [];
      }
    }
    return { startedAt: start >= 0 ? messages[start].timestamp : undefined, plan, followUps, steps };
  }, [messages]);
}

/** The routine that runs soonest, kept up to date */
function useNextRoutine(): ScheduledTask | null {
  const [next, setNext] = useState<ScheduledTask | null>(null);
  useEffect(() => {
    const load = () =>
      scheduleStore
        .getAll()
        .then(all => {
          const upcoming = all
            .filter(routine => routine.enabled && routine.nextRunAt)
            .sort((a, b) => (a.nextRunAt ?? 0) - (b.nextRunAt ?? 0));
          setNext(upcoming[0] ?? null);
        })
        .catch(error => console.error('Failed to load routines:', error));
    load();
    return scheduleStore.subscribe(load);
  }, []);
  return next;
}

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

/**
 * The agent itself, docked above the composer: what it does now and what comes next while it works,
 * and what could follow, or the next routine, while it waits. It stays in view however far the chat scrolls.
 */
export default function AgentDock({
  messages,
  running,
  activity,
  queue,
  queueHeld,
  onUnqueue,
  onResumeQueue,
  onPick,
}: AgentDockProps) {
  const [open, setOpen] = useState(true);
  const { startedAt, plan, followUps, steps } = useLatestTurn(messages);
  const nextRoutine = useNextRoutine();
  const now = useNow(running);

  const phase: Phase = running ? (activity?.phase ?? 'planning') : 'idle';
  const page = activity?.view && (activity.view.title || hostOf(activity.view.url));
  const meta = [
    running && startedAt ? formatDuration(now - startedAt) : '',
    running && steps > 0 ? t('dock_step', [String(steps)]) : '',
    running && activity?.view ? hostOf(activity.view.url) : '',
  ].filter(Boolean);

  let headline: string;
  if (running) headline = liveText(activity).replace(/[.…]+$/, '');
  else if (queue.length > 0 && queueHeld) headline = t('dock_queuePaused');
  else if (messages.length > 0) headline = t('dock_ready');
  else headline = t('dock_idle');

  const showPlan = running && plan.length > 0;
  const showFollowUps = !running && followUps.length > 0;
  const hasBody = showPlan || queue.length > 0 || showFollowUps;

  return (
    <section className={`nb-dock phase-${phase}${open ? ' open' : ''}`} aria-live="polite">
      <div className="nb-dock-head">
        <span className="nb-orb" aria-hidden>
          <i />
        </span>
        <span className="nb-dock-now">
          <span className={`nb-dock-headline${running ? ' nb-shimmer' : ''}`} title={page || undefined}>
            {headline}
            {running && '…'}
          </span>
          {meta.length > 0 && <span className="nb-dock-meta">{meta.join(' · ')}</span>}
          {!running && nextRoutine?.nextRunAt && (
            <span className="nb-dock-meta" title={nextRoutine.task}>
              <FiClock aria-hidden />
              {t('dock_nextRoutine')} · {formatWhen(nextRoutine.nextRunAt)} · {nextRoutine.task}
            </span>
          )}
        </span>
        {!running && queue.length > 0 && queueHeld && (
          <button type="button" className="nb-button nb-dock-resume" onClick={onResumeQueue}>
            <FiPlay aria-hidden />
            {t('dock_resume')}
          </button>
        )}
        {hasBody && (
          <button
            type="button"
            className="nb-dock-toggle"
            aria-expanded={open}
            aria-label={t('dock_toggle_a11y')}
            title={t('dock_toggle_a11y')}
            onClick={() => setOpen(!open)}>
            <FiChevronDown aria-hidden />
          </button>
        )}
      </div>
      {open && hasBody && (
        <div className="nb-dock-body">
          {showPlan && (
            <div className="nb-dock-group">
              <h4 className="nb-label">{t('dock_upNext')}</h4>
              <ol className="nb-dock-plan">
                {plan.map((line, i) => (
                  <li key={`${i}-${line}`} className={i === 0 ? 'now' : undefined}>
                    <span className="nb-dock-n">{i + 1}</span>
                    <span title={line}>{line}</span>
                  </li>
                ))}
              </ol>
            </div>
          )}
          {queue.length > 0 && (
            <div className="nb-dock-group">
              <h4 className="nb-label">{t('dock_queued')}</h4>
              <ul className="nb-dock-queue">
                {queue.map((goal, i) => (
                  <li key={`${i}-${goal}`}>
                    <FiCornerDownRight aria-hidden />
                    <span title={goal}>{goal}</span>
                    <button
                      type="button"
                      onClick={() => onUnqueue(i)}
                      aria-label={t('dock_unqueue')}
                      title={t('dock_unqueue')}>
                      <FiX aria-hidden />
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          )}
          {showFollowUps && (
            <div className="nb-dock-group">
              <h4 className="nb-label">{t('dock_suggested')}</h4>
              <div className="nb-dock-chips">
                {followUps.map(task => (
                  <button key={task} type="button" className="nb-dock-chip" onClick={() => onPick(task)} title={task}>
                    <span>{task}</span>
                    <FiArrowUpRight aria-hidden />
                  </button>
                ))}
              </div>
            </div>
          )}
        </div>
      )}
    </section>
  );
}
