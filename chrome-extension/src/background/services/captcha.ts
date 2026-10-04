import type { BaseChatModel } from '@langchain/core/language_models/chat_models';
import { AIMessage, HumanMessage, type BaseMessage } from '@langchain/core/messages';
import { withModelTimeout } from '../agent/agents/errors';
import { createLogger } from '../log';

const logger = createLogger('Captcha');

const TIMEOUT_MS = 45000;
// The second look at a reading too long for the field: on failure the first reading, cut to fit, is used
const RETRY_TIMEOUT_MS = 20000;
// Codes are a handful of characters; a longer reply is the model talking instead of reading
const MAX_ANSWER_LENGTH = 12;
const UNREADABLE = 'UNREADABLE';

const PROMPT = `The image is a verification code (captcha) shown next to a form field on a web page. Work out what
has to be typed into that field.
1. Look for a rule. Captchas often say which part of the code to type, in the picture itself (frequently a
   smaller line under or beside the code, often in Chinese) or in the page text given below. Rules differ from
   site to site, for example: only the characters of one colour ("请输入红色的字符", "请输入蓝色的字符"), only some
   positions ("请输入第2至第5位"), only digits or only letters, the characters in reverse order, or the result of
   a sum ("3 + 5 = ?"). The rule text itself is never part of the answer. No rule: the answer is the whole code.
2. Read every character of the code left to right, noting the colour of each.
3. Apply the rule to those characters.
Keep upper and lower case as shown and ignore noise lines and dots. Give your best reading even when the image
is hard to read.
Reply with JSON only, no other text:
{"rule": "the rule as shown, empty when there is none",
 "characters": "every character of the code with its colour, like: T red, 4 red, y black",
 "answer": "exactly what to type"}
When the image shows no characters at all, reply {"answer": "${UNREADABLE}"}.`;

const modelName = (llm: BaseChatModel) =>
  'modelName' in llm ? String(llm.modelName) : 'model' in llm ? String(llm.model) : 'unknown';

/** The model answered, but not with a code: the image is unclear or the model does not read images */
export class CaptchaUnreadableError extends Error {
  constructor(reply: string) {
    super(`The captcha could not be read (the model answered: "${reply.trim().slice(0, 80)}")`);
    this.name = 'CaptchaUnreadableError';
  }
}

/** @returns the code in a model reply, or null when the reply is not one */
export function captchaAnswer(reply: string): string | null {
  const answer = reply
    .replace(/<think>[\s\S]*?<\/think>/gi, '')
    .replace(/\s+/g, '')
    .replace(/^["'`“”‘’*]+|["'`“”‘’*.。]+$/g, '');
  if (answer === '' || answer.length > MAX_ANSWER_LENGTH || answer.toUpperCase().includes(UNREADABLE)) return null;
  return answer;
}

/** What the page says about the captcha besides the picture */
export interface CaptchaHints {
  /** the field's maxlength: a longer reading has characters in it that do not count */
  maxLength?: number;
  placeholder?: string;
  /** text near the picture, which may say which characters to enter */
  textAround?: string;
}

function hintText(hints: CaptchaHints): string {
  const lines: string[] = [];
  if (hints.maxLength) {
    lines.push(
      `The field takes at most ${hints.maxLength} characters: the answer is no longer, most likely exactly that long.`,
    );
  }
  if (hints.placeholder) lines.push(`The field's placeholder reads: "${hints.placeholder}".`);
  if (hints.textAround) lines.push(`Text next to the picture on the page: "${hints.textAround}".`);
  return lines.length > 0 ? `\n\nFrom the page:\n${lines.join('\n')}` : '';
}

interface CaptchaReading {
  rule?: string;
  characters?: string;
  answer: string | null;
}

/** The answer in a reply that should be JSON; a model that sends the bare code is read as before */
export function captchaReading(reply: string): CaptchaReading {
  const cleaned = reply.replace(/<think>[\s\S]*?<\/think>/gi, '');
  const json = cleaned.match(/\{[\s\S]*\}/)?.[0];
  if (json) {
    try {
      const parsed = JSON.parse(json) as Record<string, unknown>;
      if (typeof parsed.answer === 'string' || typeof parsed.answer === 'number') {
        return {
          rule: typeof parsed.rule === 'string' ? parsed.rule : undefined,
          characters: typeof parsed.characters === 'string' ? parsed.characters : undefined,
          answer: captchaAnswer(String(parsed.answer)),
        };
      }
    } catch {
      // not JSON after all: read as a bare code below
    }
  }
  return { answer: captchaAnswer(cleaned) };
}

const textOf = (content: unknown) =>
  typeof content === 'string'
    ? content
    : Array.isArray(content)
      ? content.map(part => (part?.type === 'text' ? String(part.text) : '')).join('')
      : '';

/**
 * Read the code in a captcha image with a model that accepts images. A reading longer than the field allows is
 * sent back once: typing it would cut it short to a wrong code. When that second look fails or is still too long,
 * the first reading cut to fit is the answer: it is what the field would keep anyway, and a guess beats asking.
 * @param image base64 PNG
 */
export async function readCaptcha(
  llm: BaseChatModel,
  image: string,
  signal: AbortSignal,
  hints: CaptchaHints = {},
): Promise<string> {
  const dataUrl = `data:image/png;base64,${image}`;
  // the picture the model gets, drawn in the console; the data URL can also be opened in a tab
  console.info(
    '%c[Captcha] sent to model (%d KB):%c ',
    'font-weight:bold',
    Math.round((image.length * 3) / 4 / 1024),
    `font-size:1px;padding:30px 120px;background:url(${dataUrl}) left center/contain no-repeat`,
  );
  logger.info('image data URL (paste into a tab to view):', dataUrl);
  logger.info('hints', hints);

  const messages: BaseMessage[] = [
    new HumanMessage({
      content: [
        { type: 'text', text: PROMPT + hintText(hints) },
        { type: 'image_url', image_url: { url: dataUrl } },
      ],
    }),
  ];
  const first = await askModel(llm, messages, signal, 1, TIMEOUT_MS);
  if (!hints.maxLength || first.answer.length <= hints.maxLength) return first.answer;

  const maxLength = hints.maxLength;
  const fallback = first.answer.slice(0, maxLength);
  messages.push(
    new AIMessage(first.text),
    new HumanMessage(
      `"${first.answer}" has ${first.answer.length} characters, but the field takes only ${maxLength}, so the rule ` +
        'leaves some of them out. Look at the picture again for the rule, apply it, and reply with the same JSON.',
    ),
  );
  try {
    const second = await askModel(llm, messages, signal, 2, RETRY_TIMEOUT_MS);
    if (second.answer.length <= maxLength) return second.answer;
    logger.warning(`second reading "${second.answer}" is still too long; using "${fallback}"`);
  } catch (error) {
    if (signal.aborted) throw error;
    logger.warning(`second reading failed; using "${fallback}"`, error instanceof Error ? error.message : error);
  }
  return fallback;
}

async function askModel(
  llm: BaseChatModel,
  messages: BaseMessage[],
  signal: AbortSignal,
  attempt: number,
  timeoutMs: number,
): Promise<{ text: string; answer: string }> {
  const started = Date.now();
  const reply = await withModelTimeout(
    'The captcha model',
    signal,
    callSignal => llm.invoke(messages, { signal: callSignal, tags: ['captcha'] }),
    timeoutMs,
  );
  const text = textOf(reply.content);
  const { rule, characters, answer } = captchaReading(text);
  logger.info('model reply', {
    model: modelName(llm),
    attempt,
    ms: Date.now() - started,
    rule,
    characters,
    answer,
    raw: text.slice(0, 300),
  });
  if (answer === null) throw new CaptchaUnreadableError(text);
  return { text, answer };
}
