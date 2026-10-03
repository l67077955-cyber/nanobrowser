import { useState, useRef, useEffect, useCallback, useMemo } from 'react';
import { FiMic, FiPaperclip, FiX, FiFileText, FiLoader, FiSquare, FiRotateCcw, FiArrowUp } from 'react-icons/fi';
import { t } from '@extension/i18n';
import ActionModePicker, { cycleActionMode } from './ActionModePicker';

interface ChatInputProps {
  onSendMessage: (text: string, displayText?: string) => void;
  onStopTask: () => void;
  onMicClick?: () => void;
  isRecording?: boolean;
  isProcessingSpeech?: boolean;
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
  onMicClick,
  isRecording = false,
  isProcessingSpeech = false,
  disabled,
  showStopButton,
  placeholder,
  setContent,
  historicalSessionId,
  onReplay,
  aside,
}: ChatInputProps) {
  const [text, setText] = useState('');
  const [attachedFiles, setAttachedFiles] = useState<AttachedFile[]>([]);
  const isSendButtonDisabled = useMemo(
    () => disabled || (text.trim() === '' && attachedFiles.length === 0),
    [disabled, text, attachedFiles],
  );
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

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
    (e: React.FormEvent) => {
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

        onSendMessage(messageContent, displayContent);
        setText('');
        setAttachedFiles([]);
      }
    },
    [text, attachedFiles, onSendMessage],
  );

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
        e.preventDefault();
        handleSubmit(e);
      }
      // as in Claude Code: Shift+Tab steps through the action modes
      if (e.key === 'Tab' && e.shiftKey) {
        e.preventDefault();
        void cycleActionMode();
      }
    },
    [handleSubmit],
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

            {onMicClick && (
              <button
                type="button"
                onClick={onMicClick}
                disabled={disabled || isProcessingSpeech}
                aria-label={
                  isProcessingSpeech
                    ? t('chat_stt_processing')
                    : isRecording
                      ? t('chat_stt_recording_stop')
                      : t('chat_stt_input_start')
                }
                className={
                  isRecording
                    ? 'flex items-center gap-1.5 rounded-md bg-nb-tile-2 px-2 py-1 text-[11.5px] font-medium text-nb-critical'
                    : iconButton
                }>
                {isProcessingSpeech ? (
                  <FiLoader className="size-4 animate-spin" />
                ) : isRecording ? (
                  <>
                    <span className="size-2 animate-pulse rounded-full bg-nb-critical" />
                    {t('chat_stt_recording_stop')}
                  </>
                ) : (
                  <FiMic className="size-4" />
                )}
              </button>
            )}
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
  );
}
