import type { ExportedFile } from '@extension/shared';
import { chatHistoryStore, traceStore } from '@extension/storage';
import { createLogger } from '../../log';
import {
  buildChatLog,
  buildDebugBundle,
  EXPORT_FORMATS,
  type ExportFormat,
  fileName,
  type ImportedChat,
  parseChatJson,
  parseConversationText,
  toHtml,
  toMarkdown,
  toText,
} from './formats';

const logger = createLogger('export');

function parsed(text: string | null | undefined): unknown {
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

/** Renders a page into a PDF in a window out of sight, through the debugger the agents use too */
async function printToPdf(html: string): Promise<string> {
  const window = await chrome.windows.create({ url: 'about:blank', focused: false, state: 'minimized' });
  const tabId = window?.tabs?.[0]?.id;
  if (!window?.id || !tabId) throw new Error('Could not open a window to print the PDF in');
  const target = { tabId };
  try {
    await chrome.debugger.attach(target, '1.3');
    const { frameTree } = (await chrome.debugger.sendCommand(target, 'Page.getFrameTree')) as {
      frameTree: { frame: { id: string } };
    };
    await chrome.debugger.sendCommand(target, 'Page.setDocumentContent', { frameId: frameTree.frame.id, html });
    const { data } = (await chrome.debugger.sendCommand(target, 'Page.printToPDF', {
      printBackground: true,
      marginTop: 0.4,
      marginBottom: 0.4,
      marginLeft: 0.4,
      marginRight: 0.4,
    })) as { data: string };
    return data;
  } finally {
    await chrome.debugger.detach(target).catch(() => {});
    await chrome.windows.remove(window.id).catch(() => {});
  }
}

/** A chat saved as a file in one of the formats */
export async function exportChat(sessionId: string, format: ExportFormat): Promise<ExportedFile> {
  if (!Object.prototype.hasOwnProperty.call(EXPORT_FORMATS, format))
    throw new Error(`Unknown export format: ${format}`);
  const session = await chatHistoryStore.getSession(sessionId);
  if (!session) throw new Error('That chat is gone');
  const now = new Date();
  const filename = fileName(session.title, format, now);
  const { mime } = EXPORT_FORMATS[format];

  switch (format) {
    case 'txt':
      return { filename, mime, data: toText(session, now) };
    case 'md':
      return { filename, mime, data: toMarkdown(session, now) };
    case 'html':
      return { filename, mime, data: toHtml(session, {}, now) };
    case 'pdf':
      return { filename, mime, data: await printToPdf(toHtml(session, { expanded: true }, now)), base64: true };
  }

  const [context, steps] = await Promise.all([
    chatHistoryStore.loadAgentContext(sessionId),
    chatHistoryStore.loadAgentStepHistory(sessionId),
  ]);
  const log = buildChatLog(
    session,
    parsed(context),
    steps ? { task: steps.task, history: parsed(steps.history), timestamp: steps.timestamp } : null,
    { version: chrome.runtime.getManifest().version, build: import.meta.env.VITE_BUILD_INFO || 'unknown' },
    now,
  );
  if (format === 'log') return { filename, mime, data: JSON.stringify(log, null, 2) };

  const [entries, blobs] = await Promise.all([
    traceStore.getEntries(sessionId).catch(error => {
      logger.warning('Failed to read the trace:', error);
      return [];
    }),
    traceStore.getBlobs(sessionId).catch(() => ({})),
  ]);
  return { filename, mime, data: JSON.stringify(buildDebugBundle(log, entries, blobs), null, 2) };
}

/** What a file holds, as a chat: one of ours (full log, debug bundle) or a conversation written out as text */
export function readChatFile(name: string, text: string): ImportedChat {
  const trimmed = text.trimStart();
  if (trimmed.startsWith('{')) {
    let value: unknown;
    try {
      value = JSON.parse(trimmed);
    } catch {
      value = undefined;
    }
    const chat = value === undefined ? null : parseChatJson(value);
    if (chat) return chat;
  }
  if (/^<!doctype html|^<html/i.test(trimmed)) {
    // a page: its text, read the way the conversation was written out
    const body = trimmed
      .replace(/<(script|style)[\s\S]*?<\/\1>/gi, '')
      .replace(/<\/(p|div|section|header|li|ol|ul|summary|details|h\d|br|tr)>|<br\s*\/?>/gi, '\n')
      .replace(/<[^>]+>/g, '')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'")
      .replace(/&amp;/g, '&');
    return parseConversationText(body, name);
  }
  return parseConversationText(text, name);
}

/** Saves a chat taken from a file as a new chat, and returns its id */
export async function importChat(chat: ImportedChat): Promise<string> {
  if (!chat.messages.length) throw new Error('The file has no conversation in it');
  const session = await chatHistoryStore.createSession(chat.title, chat.messages);
  try {
    if (chat.agentContext) {
      const context = typeof chat.agentContext === 'string' ? chat.agentContext : JSON.stringify(chat.agentContext);
      await chatHistoryStore.storeAgentContext(session.id, context);
    }
    if (chat.stepHistory) {
      const { task, history } = chat.stepHistory;
      await chatHistoryStore.storeAgentStepHistory(
        session.id,
        task,
        typeof history === 'string' ? history : JSON.stringify(history),
      );
    }
  } catch (error) {
    // no half-imported chat is left in the history
    await chatHistoryStore.deleteSession(session.id).catch(() => {});
    throw error;
  }
  if (chat.trace?.entries.length) {
    const entries = chat.trace.entries.map(entry => ({ ...entry, sessionId: session.id }));
    const blobs = Object.entries(chat.trace.blobs).map(([hash, value]) => ({ hash, value }));
    await traceStore
      .append(session.id, entries, blobs)
      .catch(error => logger.warning('Failed to keep the trace of the imported chat:', error));
  }
  logger.info('chat imported', session.id, chat.messages.length);
  return session.id;
}
