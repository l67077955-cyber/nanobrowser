/**
 * Tell the user on Telegram when a remote task waits for them, and pass their reply back to the task.
 *
 * The question goes out with a screenshot of the page (a QR code to scan, a form, a captcha), and buttons
 * where a tap is enough: Approve / Decline for an approval, Done for something done on the page. A text
 * reply answers the question it replies to, or the latest one. Updates are only fetched while a task waits,
 * so the bot can be shared with another program that reads its messages the rest of the time.
 */

const CAPTION_LIMIT = 1024;
const POLL_SECONDS = 25;

const clip = (text, limit) => (text.length > limit ? `${text.slice(0, limit - 1)}…` : text);

/**
 * @param {{ token: string, chatId: string, answerTask: (taskId: string, answer: string, approve?: boolean) =>
 *   Promise<unknown>, log?: (...args: unknown[]) => void, fetch?: typeof fetch, api?: string }} options
 */
export function createTelegram({ token, chatId, answerTask, log = () => {}, fetch: fetchImpl = fetch, api }) {
  const base = `${api ?? 'https://api.telegram.org'}/bot${token}`;
  /** task id -> { messageId, approval } for every task waiting now, oldest first */
  const waiting = new Map();
  let offset = null;
  let polling = false;
  let stopped = false;

  async function call(method, body) {
    const isForm = body instanceof FormData;
    const response = await fetchImpl(`${base}/${method}`, {
      method: 'POST',
      ...(isForm ? { body } : { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }),
    });
    const reply = await response.json();
    if (!reply.ok) throw new Error(`${method}: ${reply.description ?? response.status}`);
    return reply.result;
  }

  function messageFor(task) {
    const { question, fields } = task.waiting;
    const approval = task.status === 'waiting_confirmation';
    const how = approval
      ? 'Tap Approve or Decline.'
      : fields.length > 0
        ? `Reply to this message with: ${fields.join(', ')}.`
        : 'Reply to this message, or tap Done once you have done it.';
    const head = approval ? '🔔 Nanobrowser asks before it acts' : '🔔 Nanobrowser needs you';
    const text = `${head}\n\n${question}\n\n${how}\n\nTask: ${clip(task.text, 200)}`;
    const keyboard = approval
      ? [
          [
            { text: 'Approve', callback_data: `ok:${task.id}` },
            { text: 'Decline', callback_data: `no:${task.id}` },
          ],
        ]
      : [[{ text: 'Done ✅', callback_data: `done:${task.id}` }]];
    return { text, approval, reply_markup: { inline_keyboard: keyboard } };
  }

  async function onWaiting(task) {
    const { text, approval, reply_markup } = messageFor(task);
    try {
      let sent;
      if (task.waiting.screenshot) {
        const form = new FormData();
        form.append('chat_id', chatId);
        form.append('caption', clip(text, CAPTION_LIMIT));
        form.append('reply_markup', JSON.stringify(reply_markup));
        form.append(
          'photo',
          new Blob([Buffer.from(task.waiting.screenshot, 'base64')], { type: 'image/jpeg' }),
          'page.jpg',
        );
        sent = await call('sendPhoto', form);
      } else {
        sent = await call('sendMessage', { chat_id: chatId, text, reply_markup });
      }
      waiting.delete(task.id);
      waiting.set(task.id, { messageId: sent.message_id, approval });
      void poll();
    } catch (error) {
      log('telegram: could not tell the user', error.message);
    }
  }

  /** The task stopped waiting: answered here or elsewhere, given up on, or ended. Its buttons go. */
  function onWaitingOver(task) {
    const entry = waiting.get(task.id);
    if (!entry) return;
    waiting.delete(task.id);
    call('editMessageReplyMarkup', {
      chat_id: chatId,
      message_id: entry.messageId,
      reply_markup: { inline_keyboard: [] },
    }).catch(() => {});
  }

  async function pass(taskId, answer, approve, replyTo) {
    try {
      await answerTask(taskId, answer, approve);
      const said = approve === undefined ? 'Got it, carrying on.' : approve ? 'Approved.' : 'Declined.';
      await call('sendMessage', { chat_id: chatId, text: `✓ ${said}`, reply_parameters: { message_id: replyTo } });
    } catch (error) {
      await call('sendMessage', { chat_id: chatId, text: `Could not pass that on: ${error.message}` }).catch(() => {});
    }
  }

  async function handle(update) {
    const query = update.callback_query;
    if (query) {
      if (String(query.from?.id) !== String(chatId) && String(query.message?.chat?.id) !== String(chatId)) return;
      await call('answerCallbackQuery', { callback_query_id: query.id }).catch(() => {});
      const [kind, ...rest] = String(query.data ?? '').split(':');
      const taskId = rest.join(':');
      if (!waiting.has(taskId)) return;
      if (kind === 'ok' || kind === 'no')
        await pass(taskId, kind === 'ok' ? 'yes' : 'no', kind === 'ok', query.message?.message_id);
      else if (kind === 'done') await pass(taskId, 'Done', undefined, query.message?.message_id);
      return;
    }
    const message = update.message;
    if (!message || String(message.chat?.id) !== String(chatId) || typeof message.text !== 'string') return;
    // the question replied to, or the latest one
    const repliedTo = message.reply_to_message?.message_id;
    const entries = [...waiting.entries()];
    const target = entries.find(([, entry]) => entry.messageId === repliedTo) ?? entries.at(-1);
    if (!target) return;
    const [taskId, entry] = target;
    const approve = entry.approval ? /^(y|yes|ok|approve|是|好|确认|同意)/i.test(message.text.trim()) : undefined;
    await pass(taskId, message.text, approve, message.message_id);
  }

  async function poll() {
    if (polling || stopped) return;
    polling = true;
    try {
      // what was sent to the bot before this wait is not an answer to it
      if (offset === null) {
        const last = await call('getUpdates', { offset: -1, timeout: 0 });
        offset = last.length > 0 ? last[0].update_id + 1 : 0;
      }
      while (waiting.size > 0 && !stopped) {
        let updates;
        try {
          updates = await call('getUpdates', {
            offset,
            timeout: POLL_SECONDS,
            allowed_updates: ['message', 'callback_query'],
          });
        } catch (error) {
          // another program reading the bot at the same time, or the network: try again shortly
          log('telegram: cannot fetch replies', error.message);
          await new Promise(resolve => setTimeout(resolve, 5000));
          continue;
        }
        for (const update of updates) {
          offset = update.update_id + 1;
          await handle(update);
        }
      }
    } catch (error) {
      log('telegram: cannot fetch replies', error.message);
      // the replies read here are not handed again to whoever reads the bot next
      if (offset) await call('getUpdates', { offset, timeout: 0 }).catch(() => {});
    } finally {
      polling = false;
      // the next wait starts from what is new then
      offset = null;
    }
  }

  return {
    onWaiting,
    onWaitingOver,
    stop() {
      stopped = true;
    },
  };
}
