/* eslint-disable react/prop-types */
import { FiTrash2, FiBookmark } from 'react-icons/fi';
import { t } from '@extension/i18n';

interface ChatSession {
  id: string;
  title: string;
  createdAt: number;
}

interface ChatHistoryListProps {
  sessions: ChatSession[];
  onSessionSelect: (sessionId: string) => void;
  onSessionDelete: (sessionId: string) => void;
  onSessionBookmark: (sessionId: string) => void;
  visible: boolean;
}

const ChatHistoryList: React.FC<ChatHistoryListProps> = ({
  sessions,
  onSessionSelect,
  onSessionDelete,
  onSessionBookmark,
  visible,
}) => {
  if (!visible) return null;

  const formatDate = (timestamp: number) => {
    const date = new Date(timestamp);
    return date.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
  };

  const actionButton =
    'rounded-md p-1.5 text-nb-muted opacity-0 transition focus-visible:opacity-100 group-hover:opacity-100 hover:bg-nb-tile-2';

  return (
    <div className="h-full overflow-y-auto p-2">
      <h2 className="nb-label px-2 pb-2 pt-1">{t('chat_history_title')}</h2>
      {sessions.length === 0 ? (
        <div className="rounded-xl border border-dashed border-nb-line p-4 text-center text-[12.5px] text-nb-muted">
          {t('chat_history_empty')}
        </div>
      ) : (
        <ul className="nb-history flex flex-col gap-0.5">
          {sessions.map(session => (
            <li key={session.id} className="group flex items-center gap-1 rounded-lg hover:bg-nb-tile">
              <button
                onClick={() => onSessionSelect(session.id)}
                className="flex min-w-0 flex-1 items-baseline gap-3 rounded-lg p-2 text-left focus-visible:outline focus-visible:outline-2 focus-visible:outline-nb-llm"
                type="button">
                <span className="min-w-0 flex-1 truncate text-[13px] text-nb-ink">{session.title}</span>
                <span className="shrink-0 text-[11px] tabular-nums text-nb-muted">{formatDate(session.createdAt)}</span>
              </button>
              {onSessionBookmark && (
                <button
                  onClick={e => {
                    e.stopPropagation();
                    onSessionBookmark(session.id);
                  }}
                  className={`${actionButton} hover:text-nb-llm`}
                  aria-label={t('chat_history_bookmark')}
                  title={t('chat_history_bookmark')}
                  type="button">
                  <FiBookmark size={14} />
                </button>
              )}
              <button
                onClick={e => {
                  e.stopPropagation();
                  onSessionDelete(session.id);
                }}
                className={`${actionButton} mr-1 hover:text-nb-critical`}
                aria-label={t('chat_history_delete')}
                title={t('chat_history_delete')}
                type="button">
                <FiTrash2 size={14} />
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
};

export default ChatHistoryList;
