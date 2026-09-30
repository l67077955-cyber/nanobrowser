import type { BaseChatModel } from '@langchain/core/language_models/chat_models';
import { HumanMessage } from '@langchain/core/messages';
import { withModelTimeout } from '../agent/agents/errors';

const TIMEOUT_MS = 45000;
// Codes are a handful of characters; a longer reply is the model talking instead of reading
const MAX_ANSWER_LENGTH = 12;
const UNREADABLE = 'UNREADABLE';

const PROMPT = `The image is a verification code shown next to a form field on a web page.
Reply with exactly what has to be typed into that field and nothing else:
- characters: copy them left to right, keeping upper and lower case, ignoring noise lines and dots
- an arithmetic question such as "3 + 5 = ?": reply with its result only
If it cannot be read, reply ${UNREADABLE}.`;

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

/**
 * Read the code in a captcha image with a model that accepts images.
 * @param image base64 PNG
 */
export async function readCaptcha(llm: BaseChatModel, image: string, signal: AbortSignal): Promise<string> {
  const reply = await withModelTimeout(
    'The captcha model',
    signal,
    callSignal =>
      llm.invoke(
        [
          new HumanMessage({
            content: [
              { type: 'text', text: PROMPT },
              { type: 'image_url', image_url: { url: `data:image/png;base64,${image}` } },
            ],
          }),
        ],
        { signal: callSignal },
      ),
    TIMEOUT_MS,
  );
  const text =
    typeof reply.content === 'string'
      ? reply.content
      : reply.content.map(part => (part.type === 'text' ? String(part.text) : '')).join('');
  const answer = captchaAnswer(text);
  if (answer === null) throw new CaptchaUnreadableError(text);
  return answer;
}
