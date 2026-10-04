import type { BaseChatModel } from '@langchain/core/language_models/chat_models';
import { AIMessage, HumanMessage, type BaseMessage } from '@langchain/core/messages';
import { withModelTimeout } from '../agent/agents/errors';
import { createLogger } from '../log';

const logger = createLogger('Captcha');

const TIMEOUT_MS = 45000;
// Codes are a handful of characters; a longer reply is the model talking instead of reading
const MAX_ANSWER_LENGTH = 12;
const UNREADABLE = 'UNREADABLE';

const PROMPT = `The image is a verification code (captcha) shown next to a form field on a web page.
Reply with exactly what has to be typed into that field and nothing else, no explanation.
- The image may contain its own instruction, often in Chinese, saying which characters to enter, e.g.
  "请输入红色的字符" (enter the red characters) or "请输入蓝色的字符" (enter the blue ones). Then reply only with the
  characters of the code that are drawn in that colour, left to right, leaving out the ones in other colours.
  The instruction is usually a separate line under the code, with the colour word drawn in that colour;
  the instruction text itself is never part of the answer.
- Without such an instruction, copy all characters of the code left to right.
- An arithmetic question such as "3 + 5 = ?": reply with its result only.
Keep upper and lower case as shown and ignore noise lines and dots. Give your best reading even when the
image is hard to read; reply ${UNREADABLE} only when it shows no characters at all.`;

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
    lines.push(`The field takes at most ${hints.maxLength} characters, so the code most likely has exactly that many.`);
  }
  if (hints.placeholder) lines.push(`The field's placeholder reads: "${hints.placeholder}".`);
  if (hints.textAround) lines.push(`Text next to the picture on the page: "${hints.textAround}".`);
  return lines.length > 0 ? `\n\nFrom the page:\n${lines.join('\n')}` : '';
}

const textOf = (content: unknown) =>
  typeof content === 'string'
    ? content
    : Array.isArray(content)
      ? content.map(part => (part?.type === 'text' ? String(part.text) : '')).join('')
      : '';

/**
 * Read the code in a captcha image with a model that accepts images. A reading longer than the field allows is
 * sent back once: typing it would cut it short to a wrong code.
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
  for (let attempt = 1; ; attempt++) {
    const started = Date.now();
    const reply = await withModelTimeout(
      'The captcha model',
      signal,
      callSignal => llm.invoke(messages, { signal: callSignal, tags: ['captcha'] }),
      TIMEOUT_MS,
    );
    const text = textOf(reply.content);
    const answer = captchaAnswer(text);
    logger.info('model reply', {
      model: modelName(llm),
      attempt,
      ms: Date.now() - started,
      raw: text.slice(0, 300),
      answer,
    });
    if (answer === null) throw new CaptchaUnreadableError(text);
    if (!hints.maxLength || answer.length <= hints.maxLength) return answer;
    if (attempt >= 2) {
      throw new CaptchaUnreadableError(
        `${answer}, ${answer.length} characters where the field takes ${hints.maxLength}`,
      );
    }
    messages.push(
      new AIMessage(text),
      new HumanMessage(
        `"${answer}" has ${answer.length} characters, but the field takes only ${hints.maxLength}. Some of what you ` +
          'read does not belong to the code, most likely characters drawn in another colour than the one asked ' +
          'for. Look again and reply with the code only.',
      ),
    );
  }
}
