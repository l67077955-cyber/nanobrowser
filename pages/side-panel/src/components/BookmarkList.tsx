/* eslint-disable react/prop-types */
import { useState, useRef, useEffect } from 'react';
import { FiTrash2, FiEdit2, FiCheck, FiX } from 'react-icons/fi';
import { t } from '@extension/i18n';

interface Bookmark {
  id: number;
  title: string;
  content: string;
}

interface BookmarkListProps {
  bookmarks: Bookmark[];
  onBookmarkSelect: (content: string) => void;
  onBookmarkUpdateTitle?: (id: number, title: string) => void;
  onBookmarkDelete?: (id: number) => void;
  onBookmarkReorder?: (draggedId: number, targetId: number) => void;
}

const BookmarkList: React.FC<BookmarkListProps> = ({
  bookmarks,
  onBookmarkSelect,
  onBookmarkUpdateTitle,
  onBookmarkDelete,
  onBookmarkReorder,
}) => {
  const [editingId, setEditingId] = useState<number | null>(null);
  const [editTitle, setEditTitle] = useState<string>('');
  const [draggedId, setDraggedId] = useState<number | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const handleEditClick = (bookmark: Bookmark) => {
    setEditingId(bookmark.id);
    setEditTitle(bookmark.title);
  };

  const handleSaveEdit = (id: number) => {
    if (onBookmarkUpdateTitle && editTitle.trim()) {
      onBookmarkUpdateTitle(id, editTitle);
    }
    setEditingId(null);
  };

  const handleCancelEdit = () => {
    setEditingId(null);
  };

  // Drag handlers
  const handleDragStart = (e: React.DragEvent, id: number) => {
    setDraggedId(id);
    e.dataTransfer.setData('text/plain', id.toString());
    // Add more transparent effect
    e.currentTarget.classList.add('opacity-25');
  };

  const handleDragEnd = (e: React.DragEvent) => {
    e.currentTarget.classList.remove('opacity-25');
    setDraggedId(null);
  };

  const handleDragOver = (e: React.DragEvent) => {
    e.preventDefault();
  };

  const handleDrop = (e: React.DragEvent, targetId: number) => {
    e.preventDefault();
    if (draggedId === null || draggedId === targetId) return;

    if (onBookmarkReorder) {
      onBookmarkReorder(draggedId, targetId);
    }
  };

  // Focus the input field when entering edit mode
  useEffect(() => {
    if (editingId !== null && inputRef.current) {
      inputRef.current.focus();
    }
  }, [editingId]);

  const actionButton = 'rounded-md p-1.5 text-nb-muted transition hover:bg-nb-tile-2';

  return (
    <div className="p-2">
      <h3 className="nb-label px-2 pb-2 pt-1">{t('chat_bookmarks_header')}</h3>
      <ul className="flex flex-col gap-0.5">
        {bookmarks.map(bookmark => (
          <li
            key={bookmark.id}
            draggable={editingId !== bookmark.id}
            onDragStart={e => handleDragStart(e, bookmark.id)}
            onDragEnd={handleDragEnd}
            onDragOver={handleDragOver}
            onDrop={e => handleDrop(e, bookmark.id)}
            className="group flex items-center gap-1 rounded-lg hover:bg-nb-tile">
            {editingId === bookmark.id ? (
              <div className="flex flex-1 items-center gap-1 p-1">
                <input
                  ref={inputRef}
                  type="text"
                  value={editTitle}
                  onChange={e => setEditTitle(e.target.value)}
                  onKeyDown={e => {
                    if (e.key === 'Enter') handleSaveEdit(bookmark.id);
                    if (e.key === 'Escape') handleCancelEdit();
                  }}
                  className="min-w-0 grow rounded-md border border-nb-llm bg-nb-tile px-2 py-1 text-[13px] text-nb-ink focus:outline-none"
                />
                <button
                  onClick={() => handleSaveEdit(bookmark.id)}
                  className={`${actionButton} hover:text-nb-good`}
                  aria-label={t('chat_bookmarks_saveEdit')}
                  type="button">
                  <FiCheck size={14} />
                </button>
                <button
                  onClick={handleCancelEdit}
                  className={`${actionButton} hover:text-nb-ink`}
                  aria-label={t('chat_bookmarks_cancelEdit')}
                  type="button">
                  <FiX size={14} />
                </button>
              </div>
            ) : (
              <>
                <button
                  type="button"
                  onClick={() => onBookmarkSelect(bookmark.content)}
                  title={bookmark.content}
                  className="min-w-0 flex-1 truncate rounded-lg p-2 text-left text-[13px] text-nb-ink focus-visible:outline focus-visible:outline-2 focus-visible:outline-nb-llm">
                  {bookmark.title}
                </button>
                <button
                  onClick={e => {
                    e.stopPropagation();
                    handleEditClick(bookmark);
                  }}
                  className={`${actionButton} opacity-0 hover:text-nb-ink focus-visible:opacity-100 group-hover:opacity-100`}
                  aria-label={t('chat_bookmarks_edit')}
                  title={t('chat_bookmarks_edit')}
                  type="button">
                  <FiEdit2 size={13} />
                </button>
                <button
                  onClick={e => {
                    e.stopPropagation();
                    if (onBookmarkDelete) {
                      onBookmarkDelete(bookmark.id);
                    }
                  }}
                  className={`${actionButton} mr-1 opacity-0 hover:text-nb-critical focus-visible:opacity-100 group-hover:opacity-100`}
                  aria-label={t('chat_bookmarks_delete')}
                  title={t('chat_bookmarks_delete')}
                  type="button">
                  <FiTrash2 size={13} />
                </button>
              </>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
};

export default BookmarkList;
