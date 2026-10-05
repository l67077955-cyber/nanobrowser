import { useState, useRef, useEffect, useCallback, useMemo } from 'react';
import { FiPaperclip, FiX, FiFileText, FiSquare, FiRotateCcw, FiArrowUp, FiCornerDownRight } from 'react-icons/fi';
import { t } from '@extension/i18n';
import ActionModePicker, { cycleActionMode } from './ActionModePicker';
import CommandPalette, { matchCommands, type PaletteCommand } from './CommandPalette';

interface ChatInputProps {
  onSendMessage: (text: string, displayText?: string) => void;
  onStopTask: () => void;
  disabled: boolean;
  showStopButton: boolean;
  /** what the empty field says: it differs for a new chat, a follow-up and a task under way */
  placeholder?: string;
  setContent?: (setter: (text: string) => void) => void;
  // Historical session ID - if provided, shows a replay button next to the send button
  historicalSessionId?: string | null;
  onReplay?: (sessionId: string) => void;
  /** sits in the toolbar between the attach buttons and Send, so it costs no height of its own */
  aside?: React.ReactNode;
  /** while a task runs: keep the message as the next goal instead of telling it to the task (Alt+Enter) */
  onQueue?: (text: string, displayText?: string) => void;
  /** what a `/` at the start of the field lists: things to do, saved tasks, chats to open */
  commands?: PaletteCommand[];
  /** the palette has just opened: a chance to bring its lists up to date */
  onPaletteOpen?: () => void;
}

// File attachment interface
interface AttachedFile {
  name: string;
  content: string;
  type: string;
}

export default function ChatInput({
  onSendMessage,
  onStopTask,
  disabled,
  showStopButton,
  placeholder,
  setContent,
  historicalSessionId,
  onReplay,
  aside,
  onQueue,
  commands,
  onPaletteOpen,
}: ChatInputProps) {
  const [text, setText] = useState('');
  // the text the palette was closed on with Escape: it stays closed until the text changes
  const [paletteClosedOn, setPaletteClosedOn] = useState<string | null>(null);
  const [paletteIndex, setPaletteIndex] = useState(0);
  const [attachedFiles, setAttachedFiles] = useState<AttachedFile[]>([]);
  const isSendButtonDisabled = useMemo(
    () => disabled || (text.trim() === '' && attachedFiles.length === 0),
    [disabled, text, attachedFiles],
  );
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const paletteOpen = !!commands && /^\/[^\n]*$/.test(text) && paletteClosedOn !== text;
  const paletteMatches = useMemo(
    () => (paletteOpen && commands ? matchCommands(commands, text.slice(1)) : []),
    [paletteOpen, commands, text],
  );

  useEffect(() => setPaletteIndex(0), [text]);
  useEffect(() => {
    if (paletteOpen) onPaletteOpen?.();
  }, [paletteOpen, onPaletteOpen]);

  const runCommand = useCallback((command: PaletteCommand) => {
    // first: a command may put text of its own in the field, a saved task does
    setText('');
    setPaletteClosedOn(null);
    command.run();
    textareaRef.current?.focus();
  }, []);

  const handleTextChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    setText(e.target.value);
  };

  // Expose a method to set content from outside
  useEffect(() => {
    if (setContent) {
      setContent(setText);
    }
  }, [setContent]);

  // The field is one line until the text needs more, whether typed or set from outside
  useEffect(() => {
    const textarea = textareaRef.current;
    if (textarea) {
      textarea.style.height = 'auto';
      textarea.style.height = `${Math.min(textarea.scrollHeight, 160)}px`;
    }
  }, [text]);

  const handleSubmit = useCallback(
    (e: React.FormEvent, queue = false) => {
      e.preventDefault();
      const trimmedText = text.trim();

      if (trimmedText || attachedFiles.length > 0) {
        let messageContent = trimmedText;
        let displayContent = trimmedText;

        // Security: Clearly separate user input from file content
        // The background service will sanitize file content using guardrails
        if (attachedFiles.length > 0) {
          const fileContents = attachedFiles
            .map(file => {
              // Tag file content for background service to identify and sanitize
              return `\n\n<nano_file_content type="file" name="${file.name}">\n${file.content}\n</nano_file_content>`;
            })
            .join('\n');

          // Combine user message with tagged file content (for background service)
          messageContent = trimmedText
            ? `${trimmedText}\n\n<nano_attached_files>${fileContents}</nano_attached_files>`
            : `<nano_attached_files>${fileContents}</nano_attached_files>`;

          // Create display version with only filenames (for UI)
          const fileList = attachedFiles.map(file => `📎 ${file.name}`).join('\n');
          displayContent = trimmedText ? `${trimmedText}\n\n${fileList}` : fileList;
        }

        if (queue && onQueue) onQueue(messageContent, displayContent);
        else onSendMessage(messageContent, displayContent);
        setText('');
        setAttachedFiles([]);
      }
    },
    [text, attachedFiles, onSendMessage, onQueue],
  );

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (paletteOpen && !e.nativeEvent.isComposing) {
        const count = paletteMatches.length;
        if (e.key === 'Escape') {
          e.preventDefault();
          setPaletteClosedOn(text);
          return;
        }
        if (count > 0 && (e.key === 'ArrowDown' || e.key === 'ArrowUp')) {
          e.preventDefault();
          setPaletteIndex(index => (index + (e.key === 'ArrowDown' ? 1 : count - 1)) % count);
          return;
        }
        // with nothing matching, Enter sends the text as typed, e.g. `/replay <id>`
        if (count > 0 && ((e.key === 'Enter' && !e.shiftKey) || (e.key === 'Tab' && !e.shiftKey))) {
          e.preventDefault();
          runCommand(paletteMatches[Math.min(paletteIndex, count - 1)]);
          return;
        }
      }
      if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
        e.preventDefault();
        handleSubmit(e, e.altKey && showStopButton);
      }
      // as in Claude Code: Shift+Tab steps through the action modes
      if (e.key === 'Tab' && e.shiftKey) {
        e.preventDefault();
        void cycleActionMode();
      }
    },
    [handleSubmit, showStopButton, paletteOpen, paletteMatches, paletteIndex, runCommand, text],
  );

  const handleReplay = useCallback(() => {
    if (historicalSessionId && onReplay) {
      onReplay(historicalSessionId);
    }
  }, [historicalSessionId, onReplay]);

  const handleFileSelect = useCallback(() => {
    fileInputRef.current?.click();
  }, []);

  const handleFileChange = useCallback(async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files;
    if (!files || files.length === 0) return;

    const newFiles: AttachedFile[] = [];
    const allowedTypes = ['.txt', '.md', '.markdown', '.json', '.csv', '.log', '.xml', '.yaml', '.yml'];

    for (let i = 0; i < files.length; i++) {
      const file = files[i];
      const fileExt = '.' + file.name.split('.').pop()?.toLowerCase();

      // Check if file type is allowed
      if (!allowedTypes.includes(fileExt)) {
        console.warn(`File type ${fileExt} not supported. Only text-based files are allowed.`);
        continue;
      }

      // Check file size (limit to 1MB)
      if (file.size > 1024 * 1024) {
        console.warn(`File ${file.name} is too large. Maximum size is 1MB.`);
        continue;
      }

      try {
        const content = await file.text();
        newFiles.push({
          name: file.name,
          content,
          type: file.type || 'text/plain',
        });
      } catch (error) {
        console.error(`Error reading file ${file.name}:`, error);
      }
    }

    if (newFiles.length > 0) {
      setAttachedFiles(prev => [...prev, ...newFiles]);
    }

    // Reset file input
    if (fileInputRef.current) {
      fileInputRef.current.value = '';
    }
  }, []);

  const handleRemoveFile = useCallback((index: number) => {
    setAttachedFiles(prev => prev.filter((_, i) => i !== index));
  }, []);

  const iconButton =
    'rounded-md p-1.5 text-nb-muted transition-colors hover:bg-nb-tile-2 hover:text-nb-ink disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-transparent';

  return (
    <div className="relative">
      {paletteOpen && (
        <CommandPalette
          commands={paletteMatches}
          selected={Math.min(paletteIndex, Math.max(paletteMatches.length - 1, 0))}
          onPick={runCommand}
          onHover={setPaletteIndex}
        />
      )}
      <form
        onSubmit={handleSubmit}
        className={`nb-input overflow-hidden rounded-[18px] border bg-nb-tile transition-[border-color,box-shadow] ${
          disabled ? 'border-nb-hair' : 'border-nb-line focus-within:border-nb-muted'
        }`}
        aria-label={t('chat_input_form')}>
        <div className="flex flex-col">
          {/* File attachments display */}
          {attachedFiles.length > 0 && (
            <div className="flex flex-wrap gap-1.5 border-b border-nb-hair p-2">
              {attachedFiles.map((file, index) => (
                <div
                  key={index}
                  className="flex items-center gap-1.5 rounded-md border border-nb-hair bg-nb-tile-2 py-0.5 pl-2 pr-1 text-[11.5px] text-nb-ink-2">
                  <FiFileText className="size-3 shrink-0 text-nb-muted" />
                  <span className="max-w-[150px] truncate">{file.name}</span>
                  <button
                    type="button"
                    onClick={() => handleRemoveFile(index)}
                    className="rounded p-0.5 text-nb-muted transition-colors hover:bg-nb-track hover:text-nb-ink"
                    aria-label={`Remove ${file.name}`}>
                    <FiX className="size-3" />
                  </button>
                </div>
              ))}
            </div>
          )}

          <textarea
            ref={textareaRef}
            value={text}
            onChange={handleTextChange}
            onKeyDown={handleKeyDown}
            disabled={disabled}
            aria-disabled={disabled}
            rows={1}
            className={`w-full resize-none border-none bg-transparent px-3.5 pt-2.5 text-[13.5px] leading-relaxed focus:outline-none ${
              disabled ? 'cursor-not-allowed text-nb-muted' : 'text-nb-ink'
            }`}
            placeholder={
              attachedFiles.length > 0 ? 'Add a message (optional)...' : (placeholder ?? t('chat_input_placeholder'))
            }
            aria-label={t('chat_input_editor')}
          />

          <div className="flex items-center gap-1 px-2 pb-1.5">
            <div className="flex shrink-0 gap-0.5">
              {/* File attachment button */}
              <button
                type="button"
                onClick={handleFileSelect}
                disabled={disabled}
                aria-label="Attach files"
                title="Attach text files (txt, md, json, csv, etc.)"
                className={iconButton}>
                <FiPaperclip className="size-4" />
              </button>

              {/* Hidden file input */}
              <input
                ref={fileInputRef}
                type="file"
                multiple
                accept=".txt,.md,.markdown,.json,.csv,.log,.xml,.yaml,.yml"
                onChange={handleFileChange}
                className="hidden"
                aria-hidden="true"
              />
            </div>

            <ActionModePicker />

            <div className="min-w-0 flex-1">{aside}</div>

            <div className="flex shrink-0 items-center gap-1.5">
              {/* while a task runs, a message is taken in by it; Stop is there for when it should end */}
              {showStopButton && (
                <button
                  type="button"
                  onClick={onStopTask}
                  aria-label={t('chat_buttons_stop')}
                  title={t('chat_buttons_stop')}
                  className="flex size-7 items-center justify-center rounded-full border border-nb-line bg-nb-tile-2 text-nb-ink-2 transition-colors hover:border-nb-muted hover:text-nb-ink">
                  <FiSquare className="size-2.5 fill-current" />
                </button>
              )}
              {!showStopButton && historicalSessionId && (
                <button
                  type="button"
                  onClick={handleReplay}
                  className="flex items-center gap-1.5 rounded-full border border-nb-line bg-nb-tile-2 px-3 py-1 text-[12.5px] font-medium text-nb-ink transition-colors hover:border-nb-muted">
                  <FiRotateCcw className="size-3.5" />
                  {t('chat_buttons_replay')}
                </button>
              )}
              {showStopButton && onQueue && !isSendButtonDisabled && (
                <button
                  type="button"
                  onClick={e => handleSubmit(e, true)}
                  aria-label={t('chat_buttons_queue')}
                  title={t('chat_buttons_queue')}
                  className="flex size-7 items-center justify-center rounded-full border border-nb-line bg-nb-tile-2 text-nb-ink-2 transition-colors hover:border-nb-muted hover:text-nb-ink">
                  <FiCornerDownRight className="size-3.5" />
                </button>
              )}
              {!(showStopButton && isSendButtonDisabled) && (
                <button
                  type="submit"
                  disabled={isSendButtonDisabled}
                  aria-disabled={isSendButtonDisabled}
                  aria-label={t('chat_buttons_send')}
                  title={t('chat_buttons_send')}
                  className="flex size-7 items-center justify-center rounded-full bg-nb-ink text-nb-tile transition-opacity hover:enabled:opacity-85 disabled:cursor-not-allowed disabled:bg-nb-track disabled:text-nb-muted">
                  <FiArrowUp className="size-4" />
                </button>
              )}
            </div>
          </div>
        </div>
      </form>
    </div>
  );
}
