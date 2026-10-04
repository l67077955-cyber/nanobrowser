import { t } from '@extension/i18n';
import { type ScheduledTask, describeRepeat, nextRun, scheduleStore } from '@extension/storage';
import { useEffect, useState } from 'react';
import { FiPause, FiPlay, FiTrash2 } from 'react-icons/fi';

/** "Today 09:00", "Tomorrow 09:00", "Fri 09:00", or a date further out */
export function formatWhen(time: number): string {
  const date = new Date(time);
  const clock = date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  const days = Math.round((new Date(time).setHours(0, 0, 0, 0) - new Date().setHours(0, 0, 0, 0)) / 86_400_000);
  if (days === 0) return `${t('chat_routines_today')} ${clock}`;
  if (days === 1) return `${t('chat_routines_tomorrow')} ${clock}`;
  if (days > 1 && days < 7) return `${date.toLocaleDateString([], { weekday: 'short' })} ${clock}`;
  return `${date.toLocaleDateString([], { month: 'short', day: 'numeric' })} ${clock}`;
}

/** What the user asked to have done later or on a schedule; set up by saying so in the chat */
export default function RoutineList({ onOpenSession }: { onOpenSession?: (sessionId: string) => void }) {
  const [routines, setRoutines] = useState<ScheduledTask[]>([]);

  useEffect(() => {
    const load = () =>
      scheduleStore
        .getAll()
        .then(setRoutines)
        .catch(error => console.error('Failed to load routines:', error));
    load();
    return scheduleStore.subscribe(load);
  }, []);

  if (routines.length === 0) return null;

  const toggle = (routine: ScheduledTask) =>
    scheduleStore.update(routine.id, {
      enabled: !routine.enabled,
      nextRunAt: routine.enabled ? routine.nextRunAt : nextRun(routine.repeat),
    });

  const actionButton =
    'rounded-md p-1.5 text-nb-muted opacity-0 transition hover:bg-nb-tile-2 focus-visible:opacity-100 group-hover:opacity-100';

  return (
    <div className="p-2">
      <h3 className="nb-label px-2 pb-2 pt-1">{t('chat_routines_header')}</h3>
      <ul className="flex flex-col gap-0.5">
        {routines.map(routine => {
          const when = routine.enabled
            ? routine.nextRunAt
              ? `${describeRepeat(routine.repeat)} · ${t('chat_routines_next', [formatWhen(routine.nextRunAt)])}`
              : t('chat_routines_done')
            : t('chat_routines_paused');
          const sessionId = routine.lastSessionId;
          return (
            <li key={routine.id} className="group flex items-center gap-1 rounded-lg hover:bg-nb-tile">
              <button
                type="button"
                disabled={!sessionId || !onOpenSession}
                onClick={() => sessionId && onOpenSession?.(sessionId)}
                title={sessionId ? t('chat_routines_openLast') : routine.task}
                className={`min-w-0 flex-1 rounded-lg p-2 text-left focus-visible:outline focus-visible:outline-2 focus-visible:outline-nb-llm ${
                  routine.enabled ? '' : 'opacity-60'
                }`}>
                <span className="block truncate text-[13px] text-nb-ink">{routine.task}</span>
                <span className="flex items-center gap-1.5 truncate text-[11.5px] text-nb-muted">
                  {routine.lastStatus && (
                    <i
                      aria-hidden
                      className={`inline-block size-1.5 shrink-0 rounded-full ${
                        routine.lastStatus === 'completed' ? 'bg-nb-good' : 'bg-nb-critical'
                      }`}
                    />
                  )}
                  {when}
                </span>
              </button>
              <button
                type="button"
                onClick={() => toggle(routine)}
                className={`${actionButton} hover:text-nb-ink`}
                aria-label={routine.enabled ? t('chat_routines_pause') : t('chat_routines_resume')}
                title={routine.enabled ? t('chat_routines_pause') : t('chat_routines_resume')}>
                {routine.enabled ? <FiPause size={13} /> : <FiPlay size={13} />}
              </button>
              <button
                type="button"
                onClick={() => scheduleStore.remove(routine.id)}
                className={`${actionButton} mr-1 hover:text-nb-critical`}
                aria-label={t('chat_routines_delete')}
                title={t('chat_routines_delete')}>
                <FiTrash2 size={13} />
              </button>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
