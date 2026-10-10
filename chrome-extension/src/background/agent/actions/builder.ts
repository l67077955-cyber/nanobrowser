import { ActionResult, type AgentContext } from '@src/background/agent/types';
import { t } from '@extension/i18n';
import {
  clickElementActionSchema,
  doneActionSchema,
  askUserActionSchema,
  goBackActionSchema,
  goToUrlActionSchema,
  inputTextActionSchema,
  solveCaptchaActionSchema,
  openTabActionSchema,
  searchGoogleActionSchema,
  switchTabActionSchema,
  type ActionSchema,
  sendKeysActionSchema,
  scrollToTextActionSchema,
  readPageActionSchema,
  cacheContentActionSchema,
  selectDropdownOptionActionSchema,
  getDropdownOptionsActionSchema,
  closeTabActionSchema,
  waitActionSchema,
  previousPageActionSchema,
  scrollToPercentActionSchema,
  nextPageActionSchema,
  scrollToTopActionSchema,
  scrollToBottomActionSchema,
} from './schemas';
import { z } from 'zod';
import { createLogger } from '@src/background/log';
import { ExecutionState, Actors } from '../event/types';
import type { BaseChatModel } from '@langchain/core/language_models/chat_models';
import { wrapUntrustedContent } from '../messages/utils';
import type { DOMElementNode } from '@src/background/browser/dom/views';
import { ElementChangedError, ElementNotFoundError } from '@src/background/browser/views';
import { pageShowed } from '@src/background/browser/notices';
import { CaptchaUnreadableError, readCaptcha } from '@src/background/services/captcha';
import { isAbortedError } from '../agents/errors';
import type { AskFieldKind } from '@extension/storage';

/** How much page text one read_page hands the model; a longer page is read in parts */
const READ_PAGE_CHARS = 15000;

const logger = createLogger('Action');

export class InvalidInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidInputError';
  }
}

/** Values one question asks for at most: more is a form, not a question */
const MAX_ASK_FIELDS = 3;

/** A value ask_user asks for, as the model gives it */
interface AskedField {
  label: string;
  kind: AskFieldKind;
  index?: number | null;
}

/** The kinds of value ask_user types into their fields itself, and what such a value looks like */
const TYPED_KINDS: Partial<Record<AskFieldKind, RegExp>> = {
  captcha: /^\S{1,12}$/,
  code: /^[A-Za-z0-9-]{3,12}$/,
  phone: /^\+?[\d\s()-]{5,20}$/,
  email: /^\S+@\S+\.\S+$/,
};

/** The value given for a field in a reply from the side panel's form, which sends one "label: value" line each */
export function askedValue(reply: string, label: string): string | null {
  for (const line of reply.split('\n')) {
    const match = line.match(/^([^:：]*)[:：](.*)$/);
    if (match && match[1].trim() === label) {
      const value = match[2].trim();
      return value && value !== '(left empty)' ? value : null;
    }
  }
  return null;
}

/** Readings of the captchas on one page before the user is asked to type it */
const MAX_CAPTCHA_TRIES = 2;

/** The call to the captcha model failed, as opposed to a captcha it could not read */
class CaptchaModelError extends Error {}

/**
 * Added to the result of input_text when the field ends up holding something other than the text: a format
 * mask, a length limit or text the page kept. The model reads it instead of taking the text for typed.
 * @param content what the field contains after typing, null when it is no longer on the page
 */
export function inputMismatchNote(text: string, content: string | null): string {
  if (content === null) return '';
  const flat = (s: string) => s.replace(/\s+/g, ' ').trim();
  const held = flat(content);
  if (held === flat(text)) return '';
  const shown = held.length > 200 ? `${held.slice(0, 199)}…` : held;
  return `. The field now reads "${shown}", which is not the text given: check it before going on`;
}

/**
 * The field lost part of the text: its spaces, or its end (dropped keys, a trimming controlled input). A field
 * that reformats the text into something else is not counted here.
 */
export function lostCharacters(text: string, content: string): boolean {
  const squash = (s: string) => s.replace(/\s+/g, '');
  const held = squash(content);
  const wanted = squash(text);
  // the same characters: lost only when it holds fewer gaps between words than it was given
  const gaps = (s: string) => s.trim().split(/\s+/).length;
  if (held === wanted) return gaps(content) < gaps(text);
  return held.length < wanted.length && wanted.startsWith(held);
}

/**
 * An action is a function that takes an input and returns an ActionResult
 */
export class Action {
  constructor(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    private readonly handler: (input: any) => Promise<ActionResult>,
    public readonly schema: ActionSchema,
    // Whether this action has an index argument
    public readonly hasIndex: boolean = false,
  ) {}

  async call(input: unknown): Promise<ActionResult> {
    // Validate input before calling the handler
    const schema = this.schema.schema;

    // check if the schema is schema: z.object({}), if so, ignore the input
    const isEmptySchema =
      schema instanceof z.ZodObject &&
      Object.keys((schema as z.ZodObject<Record<string, z.ZodTypeAny>>).shape || {}).length === 0;

    if (isEmptySchema) {
      return await this.handler({});
    }

    const parsedArgs = this.schema.schema.safeParse(input);
    if (!parsedArgs.success) {
      const errorMessage = parsedArgs.error.message;
      throw new InvalidInputError(errorMessage);
    }
    return await this.handler(parsedArgs.data);
  }

  name() {
    return this.schema.name;
  }

  /**
   * Returns the prompt for the action
   * @returns {string} The prompt for the action
   */
  prompt() {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const schemaShape = (this.schema.schema as z.ZodObject<any>).shape || {};
    const schemaProperties = Object.entries(schemaShape).map(([key, value]) => {
      const zodValue = value as z.ZodTypeAny;
      return `'${key}': {'type': '${zodValue.description}', ${zodValue.isOptional() ? "'optional': true" : "'required': true"}}`;
    });

    const schemaStr =
      schemaProperties.length > 0 ? `{${this.name()}: {${schemaProperties.join(', ')}}}` : `{${this.name()}: {}}`;

    return `${this.schema.description}:\n${schemaStr}`;
  }

  /**
   * Get the index argument from the input if this action has an index
   * @param input The input to extract the index from
   * @returns The index value if found, null otherwise
   */
  getIndexArg(input: unknown): number | null {
    if (!this.hasIndex) {
      return null;
    }
    if (input && typeof input === 'object' && 'index' in input) {
      return (input as { index: number }).index;
    }
    return null;
  }

  /**
   * Set the index argument in the input if this action has an index
   * @param input The input to update the index in
   * @param newIndex The new index value to set
   * @returns Whether the index was set successfully
   */
  setIndexArg(input: unknown, newIndex: number): boolean {
    if (!this.hasIndex) {
      return false;
    }
    if (input && typeof input === 'object') {
      (input as { index: number }).index = newIndex;
      return true;
    }
    return false;
  }
}

// TODO: can not make every action optional, don't know why
export function buildDynamicActionSchema(actions: Action[]): z.ZodType {
  let schema = z.object({});
  for (const action of actions) {
    // create a schema for the action, it could be action.schema.schema or null
    // but don't use default: null as it causes issues with Google Generative AI
    const actionSchema = action.schema.schema;
    schema = schema.extend({
      [action.name()]: actionSchema.nullable().optional().describe(action.schema.description),
    });
  }
  // Every key is optional and unknown keys are stripped, so {} or {"action": [...]} would pass and only fail when run.
  // Each item must name exactly one registered action; the nulls some models fill the other keys with are dropped.
  return schema
    .superRefine((item, ctx) => {
      const named = Object.keys(item).filter(key => item[key as keyof typeof item] != null);
      if (named.length !== 1) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: named.length
            ? `one action per item, got ${named.join(', ')}`
            : `no known action in item; use one of ${actions.map(a => a.name()).join(', ')}`,
        });
      }
    })
    .transform(item => Object.fromEntries(Object.entries(item).filter(([, args]) => args != null)));
}

export class ActionBuilder {
  private readonly context: AgentContext;
  private readonly extractorLLM: BaseChatModel;
  /** reads image captchas; null when no model that accepts images is configured */
  private readonly captchaLLM: BaseChatModel | null;
  /** captchas read per page address: after a few the user is asked instead */
  private readonly captchaTries = new Map<string, number>();

  constructor(context: AgentContext, extractorLLM: BaseChatModel, captchaLLM: BaseChatModel | null = null) {
    this.context = context;
    this.extractorLLM = extractorLLM;
    this.captchaLLM = captchaLLM;
  }

  /**
   * The element behind an index as the deciding model saw it. Re-reading the DOM here would renumber
   * the elements, and a page that re-rendered in between would hand back a different element.
   */
  private async observedElement(index: number): Promise<DOMElementNode | undefined> {
    if (this.context.observedSelectorMap) return this.context.observedSelectorMap.get(index);
    const page = await this.context.browserContext.getCurrentPage();
    return page.getCachedState()?.selectorMap.get(index);
  }

  /** The result of scrolling the open dialog rather than the page behind it */
  private dialogScrolled(moved: boolean): ActionResult {
    const msg = moved
      ? 'Scrolled inside the open dialog'
      : 'The open dialog is already scrolled as far as it goes; close it (Escape or its close button) to reach the page behind';
    this.context.emitEvent(Actors.NAVIGATOR, ExecutionState.ACT_OK, msg);
    return new ActionResult({ extractedContent: msg, includeInMemory: true });
  }

  buildDefaultActions() {
    const actions = [];

    const done = new Action(async (input: z.infer<typeof doneActionSchema.schema>) => {
      this.context.emitEvent(Actors.NAVIGATOR, ExecutionState.ACT_START, doneActionSchema.name);
      this.context.emitEvent(Actors.NAVIGATOR, ExecutionState.ACT_OK, input.text);
      return new ActionResult({
        isDone: true,
        extractedContent: input.text,
      });
    }, doneActionSchema);
    actions.push(done);

    // The question shows in the chat. Values to type are filled in a small form beside the input box and come
    // back as "label: value" lines; any other reply is whatever the user sends next.
    const askUser = new Action(async (input: z.infer<typeof askUserActionSchema.schema>) => {
      const question = input.question.trim();
      const asked = ((input.fields ?? []) as AskedField[]).filter(field => field.label.trim()).slice(0, MAX_ASK_FIELDS);
      const page = await this.context.browserContext.getCurrentPage();
      const nodes = await Promise.all(
        asked.map(field => (typeof field.index === 'number' ? this.observedElement(field.index) : undefined)),
      );
      const fields = asked.map(field => ({ label: field.label.trim(), kind: field.kind }));
      const meta = {
        kind: 'question' as const,
        ...(fields.length > 0 ? { fields } : {}),
        ...(input.on_page ? { onPage: true } : {}),
      };
      const answer = await this.context.askUser(Actors.NAVIGATOR, question, meta, { tabId: page.tabId, nodes });
      if (answer === null) {
        return new ActionResult({
          extractedContent: `You asked the user: "${question}". No reply came. Go on with the most reasonable choice and say which one you made, or finish with done and say what is left for them.`,
          includeInMemory: true,
        });
      }
      // The values given in the form go into their fields as they are: a model that types them itself may
      // swap in its own reading of a captcha, or refresh the picture the user just read
      const typed: string[] = [];
      const left: string[] = [];
      for (const [i, field] of asked.entries()) {
        const node = nodes[i];
        if (!node) continue;
        const label = field.label.trim();
        const value = askedValue(answer, label);
        if (!value || !TYPED_KINDS[field.kind]?.test(value)) {
          left.push(`${label} goes into [${field.index}]`);
          continue;
        }
        try {
          const content = await page.inputTextElementNode(this.context.options.useVision, node, value);
          typed.push(`${label} "${value}" into [${field.index}]${inputMismatchNote(value, content)}`);
        } catch (error) {
          logger.warning(`[ask_user] could not type ${label} into [${field.index}]`, error);
          left.push(`${label} goes into [${field.index}]`);
        }
      }
      const where = left.length > 0 ? ` (${left.join(', ')})` : '';
      this.context.messageManager.addUserNote(`You asked: "${question}"${where}. The user replied: """${answer}"""`);
      if (typed.length > 0) {
        return new ActionResult({
          extractedContent: `The user's values are typed in already: ${typed.join('; ')}. They are the user's own reading: do not type them again, change them or put your own reading in their place, and do not refresh a captcha the user read. Go on with the form and submit it; an error message still on the page from an earlier attempt says nothing about these values.`,
          includeInMemory: true,
        });
      }
      return new ActionResult({
        extractedContent: 'The user replied to your question; the reply is in the history. Carry on with it.',
        includeInMemory: true,
      });
    }, askUserActionSchema);
    actions.push(askUser);

    const searchGoogle = new Action(async (input: z.infer<typeof searchGoogleActionSchema.schema>) => {
      const context = this.context;
      const intent = input.intent || t('act_searchGoogle_start', [input.query]);
      context.emitEvent(Actors.NAVIGATOR, ExecutionState.ACT_START, intent);

      await context.browserContext.navigateTo(`https://www.google.com/search?q=${input.query}`);

      const msg2 = t('act_searchGoogle_ok', [input.query]);
      context.emitEvent(Actors.NAVIGATOR, ExecutionState.ACT_OK, msg2);
      return new ActionResult({
        extractedContent: msg2,
        includeInMemory: true,
      });
    }, searchGoogleActionSchema);
    actions.push(searchGoogle);

    const goToUrl = new Action(async (input: z.infer<typeof goToUrlActionSchema.schema>) => {
      const intent = input.intent || t('act_goToUrl_start', [input.url]);
      this.context.emitEvent(Actors.NAVIGATOR, ExecutionState.ACT_START, intent);

      await this.context.browserContext.navigateTo(input.url);
      const msg2 = t('act_goToUrl_ok', [input.url]);
      this.context.emitEvent(Actors.NAVIGATOR, ExecutionState.ACT_OK, msg2);
      return new ActionResult({
        extractedContent: msg2,
        includeInMemory: true,
      });
    }, goToUrlActionSchema);
    actions.push(goToUrl);

    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const goBack = new Action(async (input: z.infer<typeof goBackActionSchema.schema>) => {
      const intent = input.intent || t('act_goBack_start');
      this.context.emitEvent(Actors.NAVIGATOR, ExecutionState.ACT_START, intent);

      const page = await this.context.browserContext.getCurrentPage();
      await page.goBack();
      const msg2 = t('act_goBack_ok');
      this.context.emitEvent(Actors.NAVIGATOR, ExecutionState.ACT_OK, msg2);
      return new ActionResult({
        extractedContent: msg2,
        includeInMemory: true,
      });
    }, goBackActionSchema);
    actions.push(goBack);

    const wait = new Action(async (input: z.infer<typeof waitActionSchema.schema>) => {
      const seconds = input.seconds || 3;
      const intent = input.intent || t('act_wait_start', [seconds.toString()]);
      this.context.emitEvent(Actors.NAVIGATOR, ExecutionState.ACT_START, intent);
      await new Promise(resolve => setTimeout(resolve, seconds * 1000));
      const msg = t('act_wait_ok', [seconds.toString()]);
      this.context.emitEvent(Actors.NAVIGATOR, ExecutionState.ACT_OK, msg);
      return new ActionResult({ extractedContent: msg, includeInMemory: true });
    }, waitActionSchema);
    actions.push(wait);

    // Element Interaction Actions
    const clickElement = new Action(
      async (input: z.infer<typeof clickElementActionSchema.schema>) => {
        const intent = input.intent || t('act_click_start', [input.index.toString()]);
        this.context.emitEvent(Actors.NAVIGATOR, ExecutionState.ACT_START, intent);

        const page = await this.context.browserContext.getCurrentPage();
        const elementNode = await this.observedElement(input.index);
        if (!elementNode) {
          throw new Error(t('act_errors_elementNotExist', [input.index.toString()]));
        }

        // Check if element is a file uploader
        if (page.isFileUploader(elementNode)) {
          const msg = t('act_click_fileUploader', [input.index.toString()]);
          logger.info(msg);
          return new ActionResult({
            extractedContent: msg,
            includeInMemory: true,
          });
        }

        try {
          const initialTabIds = await this.context.browserContext.getAllTabIds();
          // the tab the user is looking at, which a link opening a new tab would take the front from
          const userTabId = await this.context.browserContext.frontTabId();
          let checked: boolean | undefined;
          try {
            checked = await page.clickElementNode(this.context.options.useVision, elementNode);
          } catch (error) {
            // The page re-rendered the element (e.g. a menu that animated in); retry once if it is unambiguous
            if (!(error instanceof ElementNotFoundError)) throw error;
            const relocated = await page.relocateElement(elementNode);
            if (!relocated) throw error;
            logger.info(
              `Element ${input.index} was re-rendered, clicking it at its new index ${relocated.highlightIndex}`,
            );
            checked = await page.clickElementNode(this.context.options.useVision, relocated);
          }
          let msg = t('act_click_ok', [
            input.index.toString(),
            elementNode.getAllTextTillNextClickableElement(2) || elementNode.attributes['aria-label'] || '',
          ]);
          // the box's real state, which a screenshot of a styled box does not reliably show
          if (checked !== undefined) msg += checked ? ' - it is now checked' : ' - it is now unchecked';
          logger.info(msg);

          // TODO: could be optimized by chrome extension tab api
          const currentTabIds = await this.context.browserContext.getAllTabIds();
          if (currentTabIds.size > initialTabIds.size) {
            const newTabMsg = t('act_click_newTabOpened');
            msg += ` - ${newTabMsg}`;
            logger.info(newTabMsg);
            // find the tab id that is not in the initial tab ids
            const newTabId = Array.from(currentTabIds).find(id => !initialTabIds.has(id));
            if (newTabId) {
              await this.context.browserContext.adoptOpenedTab(newTabId, userTabId);
              const newPage = await this.context.browserContext.switchTab(newTabId);
              // which page it is: often the very page the agent was on, opened again by a link
              const newUrl = (await chrome.tabs.get(newTabId).catch(() => null))?.url || newPage.url();
              if (newUrl) msg += ` (${newUrl})`;
            }
          } else if (page.clickHint) {
            msg += ` - ${page.clickHint}`;
          }
          const notices = await page.takeNotices();
          if (notices) msg += ` - ${pageShowed(notices)}`;
          this.context.emitEvent(Actors.NAVIGATOR, ExecutionState.ACT_OK, msg);
          return new ActionResult({ extractedContent: msg, includeInMemory: true });
        } catch (error) {
          const changed = error instanceof ElementChangedError;
          const msg = changed ? error.message : t('act_errors_elementNoLongerAvailable', [input.index.toString()]);
          this.context.emitEvent(Actors.NAVIGATOR, ExecutionState.ACT_FAIL, msg);
          return new ActionResult({
            error: error instanceof Error ? error.message : String(error),
            includeInMemory: changed,
          });
        }
      },
      clickElementActionSchema,
      true,
    );
    actions.push(clickElement);

    const inputText = new Action(
      async (input: z.infer<typeof inputTextActionSchema.schema>) => {
        const intent = input.intent || t('act_inputText_start', [input.index.toString()]);
        this.context.emitEvent(Actors.NAVIGATOR, ExecutionState.ACT_START, intent);

        const page = await this.context.browserContext.getCurrentPage();
        const elementNode = await this.observedElement(input.index);
        if (!elementNode) {
          throw new Error(t('act_errors_elementNotExist', [input.index.toString()]));
        }

        let content: string | null;
        try {
          content = await page.inputTextElementNode(this.context.options.useVision, elementNode, input.text);
        } catch (error) {
          // The page re-rendered the field (e.g. a chat box after a reply); type once more if it is unambiguous
          if (!(error instanceof ElementNotFoundError)) throw error;
          const relocated = await page.relocateElement(elementNode);
          if (!relocated) throw error;
          logger.info(
            `Element ${input.index} was re-rendered, typing into it at its new index ${relocated.highlightIndex}`,
          );
          content = await page.inputTextElementNode(this.context.options.useVision, relocated, input.text);
        }
        // the text was inserted again in one go when typing left something else (see page.inputTextElementNode)
        const note = inputMismatchNote(input.text, content);
        // a rich text box reads its line breaks back as nothing, so only plain fields are held to this
        const plainField = ['input', 'textarea'].includes(elementNode.tagName?.toLowerCase() ?? '');
        if (content !== null && note && plainField && lostCharacters(input.text, content)) {
          const secret = elementNode.attributes.type === 'password';
          const held = secret ? '' : ` but the field holds "${content.replace(/\s+/g, ' ').trim().slice(0, 200)}"`;
          const errorMsg = `input_text into [${input.index}] failed: the field dropped part of ${secret ? 'the text' : `"${input.text}"`}${held}. Try another way to fill it`;
          this.context.emitEvent(Actors.NAVIGATOR, ExecutionState.ACT_FAIL, errorMsg);
          return new ActionResult({ error: errorMsg, includeInMemory: true });
        }
        const msg = t('act_inputText_ok', [input.text, input.index.toString()]);
        this.context.emitEvent(Actors.NAVIGATOR, ExecutionState.ACT_OK, msg);
        // a hint the field brings up as it is typed in ("at least 8 characters")
        const notices = await page.takeNotices();
        return new ActionResult({
          // a field that reformats what it is given (a phone mask, a picked option) is told, not failed
          extractedContent: msg + note + (notices ? ` - ${pageShowed(notices)}` : ''),
          includeInMemory: true,
        });
      },
      inputTextActionSchema,
      true,
    );
    actions.push(inputText);

    const solveCaptcha = new Action(
      async (input: z.infer<typeof solveCaptchaActionSchema.schema>) => {
        const intent = input.intent || t('act_solveCaptcha_start', [input.index.toString()]);
        this.context.emitEvent(Actors.NAVIGATOR, ExecutionState.ACT_START, intent);

        if (!this.captchaLLM) throw new Error('solve_captcha is offered only with a captcha model');

        const page = await this.context.browserContext.getCurrentPage();
        const fieldNode = await this.observedElement(input.index);
        if (!fieldNode) {
          throw new Error(t('act_errors_elementNotExist', [input.index.toString()]));
        }
        // a reading the site keeps rejecting, or none at all, is left to the user rather than retried forever
        const tries = this.captchaTries.get(page.url()) ?? 0;
        if (tries >= MAX_CAPTCHA_TRIES) {
          const msg = t('act_solveCaptcha_askUser', [String(tries)]);
          logger.warning(`[captcha] ${tries} tries on ${page.url()}, leaving it to the user`);
          this.context.emitEvent(Actors.NAVIGATOR, ExecutionState.ACT_FAIL, msg);
          return new ActionResult({ error: msg, includeInMemory: true });
        }
        this.captchaTries.set(page.url(), tries + 1);
        const hasImageIndex = input.image_index !== null && input.image_index !== undefined;
        const imageNode = hasImageIndex ? await this.observedElement(input.image_index as number) : undefined;
        if (hasImageIndex && !imageNode) {
          throw new Error(t('act_errors_elementNotExist', [String(input.image_index)]));
        }

        try {
          const { image, textAround } = await page.captureCaptchaImage(fieldNode, imageNode, input.refresh === true);
          const maxLength = Number.parseInt(fieldNode.attributes?.maxlength ?? '', 10);
          const hints = {
            maxLength: maxLength > 0 ? maxLength : undefined,
            placeholder: fieldNode.attributes?.placeholder || undefined,
            textAround: textAround || undefined,
          };
          const code = await readCaptcha(this.captchaLLM, image, this.context.controller.signal, hints).catch(error => {
            if (isAbortedError(error) || error instanceof CaptchaUnreadableError) throw error;
            // the provider turned the request down: a wrong model name, or a model that takes no images
            throw new CaptchaModelError(error instanceof Error ? error.message : String(error));
          });
          const content = await page.inputTextElementNode(this.context.options.useVision, fieldNode, code);
          const msg = t('act_solveCaptcha_ok', [code, input.index.toString()]);
          this.context.emitEvent(Actors.NAVIGATOR, ExecutionState.ACT_OK, msg);
          return new ActionResult({
            extractedContent: msg + inputMismatchNote(code, content),
            includeInMemory: true,
          });
        } catch (error) {
          if (isAbortedError(error)) throw error;
          const reason = error instanceof Error ? error.message : String(error);
          const msg =
            error instanceof CaptchaModelError
              ? t('act_solveCaptcha_modelFailed', [reason])
              : t('act_solveCaptcha_failed', [reason]);
          this.context.emitEvent(Actors.NAVIGATOR, ExecutionState.ACT_FAIL, msg);
          return new ActionResult({ error: msg, includeInMemory: true });
        }
      },
      solveCaptchaActionSchema,
      true,
    );
    // without a captcha model the navigator has no such action and asks the user to type the captcha
    if (this.captchaLLM) actions.push(solveCaptcha);

    // Tab Management Actions
    const switchTab = new Action(async (input: z.infer<typeof switchTabActionSchema.schema>) => {
      const intent = input.intent || t('act_switchTab_start', [input.tab_id.toString()]);
      this.context.emitEvent(Actors.NAVIGATOR, ExecutionState.ACT_START, intent);
      await this.context.browserContext.switchTab(input.tab_id);
      const msg = t('act_switchTab_ok', [input.tab_id.toString()]);
      this.context.emitEvent(Actors.NAVIGATOR, ExecutionState.ACT_OK, msg);
      return new ActionResult({ extractedContent: msg, includeInMemory: true });
    }, switchTabActionSchema);
    actions.push(switchTab);

    const openTab = new Action(async (input: z.infer<typeof openTabActionSchema.schema>) => {
      const intent = input.intent || t('act_openTab_start', [input.url]);
      this.context.emitEvent(Actors.NAVIGATOR, ExecutionState.ACT_START, intent);
      await this.context.browserContext.openTab(input.url);
      const msg = t('act_openTab_ok', [input.url]);
      this.context.emitEvent(Actors.NAVIGATOR, ExecutionState.ACT_OK, msg);
      return new ActionResult({ extractedContent: msg, includeInMemory: true });
    }, openTabActionSchema);
    actions.push(openTab);

    const closeTab = new Action(async (input: z.infer<typeof closeTabActionSchema.schema>) => {
      const intent = input.intent || t('act_closeTab_start', [input.tab_id.toString()]);
      this.context.emitEvent(Actors.NAVIGATOR, ExecutionState.ACT_START, intent);
      await this.context.browserContext.closeTab(input.tab_id);
      const msg = t('act_closeTab_ok', [input.tab_id.toString()]);
      this.context.emitEvent(Actors.NAVIGATOR, ExecutionState.ACT_OK, msg);
      return new ActionResult({ extractedContent: msg, includeInMemory: true });
    }, closeTabActionSchema);
    actions.push(closeTab);

    // Content Actions
    // TODO: this is not used currently, need to improve on input size
    // const extractContent = new Action(async (input: z.infer<typeof extractContentActionSchema.schema>) => {
    //   const goal = input.goal;
    //   const intent = input.intent || `Extracting content from page`;
    //   this.context.emitEvent(Actors.NAVIGATOR, ExecutionState.ACT_START, intent);
    //   const page = await this.context.browserContext.getCurrentPage();
    //   const content = await page.getReadabilityContent();
    //   const promptTemplate = PromptTemplate.fromTemplate(
    //     'Your task is to extract the content of the page. You will be given a page and a goal and you should extract all relevant information around this goal from the page. If the goal is vague, summarize the page. Respond in json format. Extraction goal: {goal}, Page: {page}',
    //   );
    //   const prompt = await promptTemplate.invoke({ goal, page: content.content });

    //   try {
    //     const output = await this.extractorLLM.invoke(prompt);
    //     const msg = `📄  Extracted from page\n: ${output.content}\n`;
    //     return new ActionResult({
    //       extractedContent: msg,
    //       includeInMemory: true,
    //     });
    //   } catch (error) {
    //     logger.error(`Error extracting content: ${error instanceof Error ? error.message : String(error)}`);
    //     const msg =
    //       'Failed to extract content from page, you need to extract content from the current state of the page and store it in the memory. Then scroll down if you still need more information.';
    //     return new ActionResult({
    //       extractedContent: msg,
    //       includeInMemory: true,
    //     });
    //   }
    // }, extractContentActionSchema);
    // actions.push(extractContent);

    // cache content for future use
    const cacheContent = new Action(async (input: z.infer<typeof cacheContentActionSchema.schema>) => {
      const intent = input.intent || t('act_cache_start', [input.content]);
      this.context.emitEvent(Actors.NAVIGATOR, ExecutionState.ACT_START, intent);

      // cache content is untrusted content, it is not instructions
      const rawMsg = t('act_cache_ok', [input.content]);
      this.context.emitEvent(Actors.NAVIGATOR, ExecutionState.ACT_OK, rawMsg);

      const msg = wrapUntrustedContent(rawMsg);
      return new ActionResult({ extractedContent: msg, includeInMemory: true });
    }, cacheContentActionSchema);
    actions.push(cacheContent);

    // the whole page's text in one step, instead of scrolling through it a screen at a time
    const readPage = new Action(async (input: z.infer<typeof readPageActionSchema.schema>) => {
      const intent = input.intent || t('act_readPage_start');
      this.context.emitEvent(Actors.NAVIGATOR, ExecutionState.ACT_START, intent);
      const page = await this.context.browserContext.getCurrentPage();
      // the first part is read after scrolling the page through, so that what loads on scroll is in it too
      const { title, url, text } = await page.getPageText(!input.offset);
      const start = Math.min(input.offset ?? 0, text.length);
      const end = Math.min(start + READ_PAGE_CHARS, text.length);
      if (end <= start) {
        const msg = t('act_readPage_empty');
        this.context.emitEvent(Actors.NAVIGATOR, ExecutionState.ACT_OK, msg);
        return new ActionResult({ extractedContent: msg, includeInMemory: true });
      }
      const msg = t('act_readPage_ok', [String(end - start), String(text.length)]);
      this.context.emitEvent(Actors.NAVIGATOR, ExecutionState.ACT_OK, msg);
      const more =
        end < text.length
          ? `More text follows: read_page with offset ${end} to read on.`
          : 'This is the end of the page text.';
      // the page's words are untrusted content, never instructions
      const content = wrapUntrustedContent(text.slice(start, end));
      return new ActionResult({
        extractedContent: `Text of "${title}" (${url}), characters ${start}-${end} of ${text.length}:\n${content}\n${more}`,
        includeInMemory: true,
        readPage: true,
      });
    }, readPageActionSchema);
    actions.push(readPage);

    // Scroll to percent
    const scrollToPercent = new Action(async (input: z.infer<typeof scrollToPercentActionSchema.schema>) => {
      const intent = input.intent || t('act_scrollToPercent_start');
      this.context.emitEvent(Actors.NAVIGATOR, ExecutionState.ACT_START, intent);
      const page = await this.context.browserContext.getCurrentPage();

      if (input.index) {
        const elementNode = await this.observedElement(input.index);
        if (!elementNode) {
          const errorMsg = t('act_errors_elementNotExist', [input.index.toString()]);
          this.context.emitEvent(Actors.NAVIGATOR, ExecutionState.ACT_FAIL, errorMsg);
          return new ActionResult({ error: errorMsg, includeInMemory: true });
        }
        logger.info(`Scrolling to percent: ${input.yPercent} with elementNode: ${elementNode.xpath}`);
        await page.scrollToPercent(input.yPercent, elementNode);
      } else {
        const dialog = await page.scrollOpenDialog({ percent: input.yPercent }).catch(() => null);
        if (dialog) return this.dialogScrolled(dialog.moved);
        await page.scrollToPercent(input.yPercent);
      }
      const msg = t('act_scrollToPercent_ok', [input.yPercent.toString()]);
      this.context.emitEvent(Actors.NAVIGATOR, ExecutionState.ACT_OK, msg);
      return new ActionResult({ extractedContent: msg, includeInMemory: true });
    }, scrollToPercentActionSchema);
    actions.push(scrollToPercent);

    // Scroll to top
    const scrollToTop = new Action(async (input: z.infer<typeof scrollToTopActionSchema.schema>) => {
      const intent = input.intent || t('act_scrollToTop_start');
      this.context.emitEvent(Actors.NAVIGATOR, ExecutionState.ACT_START, intent);
      const page = await this.context.browserContext.getCurrentPage();
      if (input.index) {
        const elementNode = await this.observedElement(input.index);
        if (!elementNode) {
          const errorMsg = t('act_errors_elementNotExist', [input.index.toString()]);
          this.context.emitEvent(Actors.NAVIGATOR, ExecutionState.ACT_FAIL, errorMsg);
          return new ActionResult({ error: errorMsg, includeInMemory: true });
        }
        await page.scrollToPercent(0, elementNode);
      } else {
        const dialog = await page.scrollOpenDialog({ percent: 0 }).catch(() => null);
        if (dialog) return this.dialogScrolled(dialog.moved);
        await page.scrollToPercent(0);
      }
      const msg = t('act_scrollToTop_ok');
      this.context.emitEvent(Actors.NAVIGATOR, ExecutionState.ACT_OK, msg);
      return new ActionResult({ extractedContent: msg, includeInMemory: true });
    }, scrollToTopActionSchema);
    actions.push(scrollToTop);

    // Scroll to bottom
    const scrollToBottom = new Action(async (input: z.infer<typeof scrollToBottomActionSchema.schema>) => {
      const intent = input.intent || t('act_scrollToBottom_start');
      this.context.emitEvent(Actors.NAVIGATOR, ExecutionState.ACT_START, intent);
      const page = await this.context.browserContext.getCurrentPage();
      if (input.index) {
        const elementNode = await this.observedElement(input.index);
        if (!elementNode) {
          const errorMsg = t('act_errors_elementNotExist', [input.index.toString()]);
          this.context.emitEvent(Actors.NAVIGATOR, ExecutionState.ACT_FAIL, errorMsg);
          return new ActionResult({ error: errorMsg, includeInMemory: true });
        }
        await page.scrollToPercent(100, elementNode);
      } else {
        const dialog = await page.scrollOpenDialog({ percent: 100 }).catch(() => null);
        if (dialog) return this.dialogScrolled(dialog.moved);
        await page.scrollToPercent(100);
      }
      const msg = t('act_scrollToBottom_ok');
      this.context.emitEvent(Actors.NAVIGATOR, ExecutionState.ACT_OK, msg);
      return new ActionResult({ extractedContent: msg, includeInMemory: true });
    }, scrollToBottomActionSchema);
    actions.push(scrollToBottom);

    // Scroll to previous page
    const previousPage = new Action(async (input: z.infer<typeof previousPageActionSchema.schema>) => {
      const intent = input.intent || t('act_previousPage_start');
      this.context.emitEvent(Actors.NAVIGATOR, ExecutionState.ACT_START, intent);
      const page = await this.context.browserContext.getCurrentPage();

      if (input.index) {
        const elementNode = await this.observedElement(input.index);
        if (!elementNode) {
          const errorMsg = t('act_errors_elementNotExist', [input.index.toString()]);
          this.context.emitEvent(Actors.NAVIGATOR, ExecutionState.ACT_FAIL, errorMsg);
          return new ActionResult({ error: errorMsg, includeInMemory: true });
        }

        // Check if element is already at top of its scrollable area
        try {
          const [elementScrollTop] = await page.getElementScrollInfo(elementNode);
          if (elementScrollTop === 0) {
            const msg = t('act_errors_alreadyAtTop', [input.index.toString()]);
            this.context.emitEvent(Actors.NAVIGATOR, ExecutionState.ACT_OK, msg);
            return new ActionResult({ extractedContent: msg, includeInMemory: true });
          }
        } catch (error) {
          // If we can't get scroll info, let the scrollToPreviousPage method handle it
          logger.warning(
            `Could not get element scroll info: ${error instanceof Error ? error.message : String(error)}`,
          );
        }

        await page.scrollToPreviousPage(elementNode);
      } else {
        const dialog = await page.scrollOpenDialog({ pages: -1 }).catch(() => null);
        if (dialog) return this.dialogScrolled(dialog.moved);
        // Check if page is already at top
        const [initialScrollY] = await page.getScrollInfo();
        if (initialScrollY === 0) {
          const msg = t('act_errors_pageAlreadyAtTop');
          this.context.emitEvent(Actors.NAVIGATOR, ExecutionState.ACT_OK, msg);
          return new ActionResult({ extractedContent: msg, includeInMemory: true });
        }

        await page.scrollToPreviousPage();
      }
      const msg = t('act_previousPage_ok');
      this.context.emitEvent(Actors.NAVIGATOR, ExecutionState.ACT_OK, msg);
      return new ActionResult({ extractedContent: msg, includeInMemory: true });
    }, previousPageActionSchema);
    actions.push(previousPage);

    // Scroll to next page
    const nextPage = new Action(async (input: z.infer<typeof nextPageActionSchema.schema>) => {
      const intent = input.intent || t('act_nextPage_start');
      this.context.emitEvent(Actors.NAVIGATOR, ExecutionState.ACT_START, intent);
      const page = await this.context.browserContext.getCurrentPage();

      if (input.index) {
        const elementNode = await this.observedElement(input.index);
        if (!elementNode) {
          const errorMsg = t('act_errors_elementNotExist', [input.index.toString()]);
          this.context.emitEvent(Actors.NAVIGATOR, ExecutionState.ACT_FAIL, errorMsg);
          return new ActionResult({ error: errorMsg, includeInMemory: true });
        }

        // Check if element is already at bottom of its scrollable area
        try {
          const [elementScrollTop, elementClientHeight, elementScrollHeight] =
            await page.getElementScrollInfo(elementNode);
          if (elementScrollTop + elementClientHeight >= elementScrollHeight) {
            const msg = t('act_errors_alreadyAtBottom', [input.index.toString()]);
            this.context.emitEvent(Actors.NAVIGATOR, ExecutionState.ACT_OK, msg);
            return new ActionResult({ extractedContent: msg, includeInMemory: true });
          }
        } catch (error) {
          // If we can't get scroll info, let the scrollToNextPage method handle it
          logger.warning(
            `Could not get element scroll info: ${error instanceof Error ? error.message : String(error)}`,
          );
        }

        await page.scrollToNextPage(elementNode);
      } else {
        const dialog = await page.scrollOpenDialog({ pages: 1 }).catch(() => null);
        if (dialog) return this.dialogScrolled(dialog.moved);
        // Check if page is already at bottom
        const [initialScrollY, initialVisualViewportHeight, initialScrollHeight] = await page.getScrollInfo();
        if (initialScrollY + initialVisualViewportHeight >= initialScrollHeight) {
          const msg = t('act_errors_pageAlreadyAtBottom');
          this.context.emitEvent(Actors.NAVIGATOR, ExecutionState.ACT_OK, msg);
          return new ActionResult({ extractedContent: msg, includeInMemory: true });
        }

        await page.scrollToNextPage();
      }
      const msg = t('act_nextPage_ok');
      this.context.emitEvent(Actors.NAVIGATOR, ExecutionState.ACT_OK, msg);
      return new ActionResult({ extractedContent: msg, includeInMemory: true });
    }, nextPageActionSchema);
    actions.push(nextPage);

    // Scroll to text
    const scrollToText = new Action(async (input: z.infer<typeof scrollToTextActionSchema.schema>) => {
      const intent = input.intent || t('act_scrollToText_start', [input.text, input.nth.toString()]);
      this.context.emitEvent(Actors.NAVIGATOR, ExecutionState.ACT_START, intent);

      const page = await this.context.browserContext.getCurrentPage();
      try {
        const scrolled = await page.scrollToText(input.text, input.nth);
        const msg = scrolled
          ? t('act_scrollToText_ok', [input.text, input.nth.toString()])
          : t('act_scrollToText_notFound', [input.text, input.nth.toString()]);
        this.context.emitEvent(Actors.NAVIGATOR, ExecutionState.ACT_OK, msg);
        return new ActionResult({ extractedContent: msg, includeInMemory: true });
      } catch (error) {
        const msg = t('act_scrollToText_failed', [error instanceof Error ? error.message : String(error)]);
        this.context.emitEvent(Actors.NAVIGATOR, ExecutionState.ACT_FAIL, msg);
        return new ActionResult({ error: msg, includeInMemory: true });
      }
    }, scrollToTextActionSchema);
    actions.push(scrollToText);

    // Keyboard Actions
    const sendKeys = new Action(async (input: z.infer<typeof sendKeysActionSchema.schema>) => {
      const intent = input.intent || t('act_sendKeys_start', [input.keys]);
      this.context.emitEvent(Actors.NAVIGATOR, ExecutionState.ACT_START, intent);

      const page = await this.context.browserContext.getCurrentPage();
      await page.sendKeys(input.keys);
      const msg = t('act_sendKeys_ok', [input.keys]);
      this.context.emitEvent(Actors.NAVIGATOR, ExecutionState.ACT_OK, msg);
      const notices = await page.takeNotices();
      return new ActionResult({
        extractedContent: notices ? `${msg} - ${pageShowed(notices)}` : msg,
        includeInMemory: true,
      });
    }, sendKeysActionSchema);
    actions.push(sendKeys);

    // Get all options from a native dropdown
    const getDropdownOptions = new Action(
      async (input: z.infer<typeof getDropdownOptionsActionSchema.schema>) => {
        const intent = input.intent || t('act_getDropdownOptions_start', [input.index.toString()]);
        this.context.emitEvent(Actors.NAVIGATOR, ExecutionState.ACT_START, intent);

        const page = await this.context.browserContext.getCurrentPage();
        const elementNode = await this.observedElement(input.index);
        if (!elementNode) {
          const errorMsg = t('act_errors_elementNotExist', [input.index.toString()]);
          this.context.emitEvent(Actors.NAVIGATOR, ExecutionState.ACT_FAIL, errorMsg);
          return new ActionResult({
            error: errorMsg,
            includeInMemory: true,
          });
        }

        try {
          // Use the existing getDropdownOptions method
          const options = await page.getDropdownOptions(elementNode);

          if (options && options.length > 0) {
            // Format options for display
            const formattedOptions: string[] = options.map(opt => {
              // Encoding ensures AI uses the exact string in select_dropdown_option
              const encodedText = JSON.stringify(opt.text);
              return `${opt.index}: text=${encodedText}`;
            });

            let msg = formattedOptions.join('\n');
            msg += '\n' + t('act_getDropdownOptions_useExactText');
            this.context.emitEvent(
              Actors.NAVIGATOR,
              ExecutionState.ACT_OK,
              t('act_getDropdownOptions_ok', [options.length.toString()]),
            );
            return new ActionResult({
              extractedContent: msg,
              includeInMemory: true,
            });
          }

          // This code should not be reached as getDropdownOptions throws an error when no options found
          // But keeping as fallback
          const msg = t('act_getDropdownOptions_noOptions');
          this.context.emitEvent(Actors.NAVIGATOR, ExecutionState.ACT_OK, msg);
          return new ActionResult({
            extractedContent: msg,
            includeInMemory: true,
          });
        } catch (error) {
          const errorMsg = t('act_getDropdownOptions_failed', [error instanceof Error ? error.message : String(error)]);
          this.context.emitEvent(Actors.NAVIGATOR, ExecutionState.ACT_FAIL, errorMsg);
          return new ActionResult({
            error: errorMsg,
            includeInMemory: true,
          });
        }
      },
      getDropdownOptionsActionSchema,
      true,
    );
    actions.push(getDropdownOptions);

    // Select dropdown option for interactive element index by the text of the option you want to select'
    const selectDropdownOption = new Action(
      async (input: z.infer<typeof selectDropdownOptionActionSchema.schema>) => {
        const intent = input.intent || t('act_selectDropdownOption_start', [input.text, input.index.toString()]);
        this.context.emitEvent(Actors.NAVIGATOR, ExecutionState.ACT_START, intent);

        const page = await this.context.browserContext.getCurrentPage();
        const elementNode = await this.observedElement(input.index);
        if (!elementNode) {
          const errorMsg = t('act_errors_elementNotExist', [input.index.toString()]);
          this.context.emitEvent(Actors.NAVIGATOR, ExecutionState.ACT_FAIL, errorMsg);
          return new ActionResult({
            error: errorMsg,
            includeInMemory: true,
          });
        }

        // Validate that we're working with a select element
        if (!elementNode.tagName || elementNode.tagName.toLowerCase() !== 'select') {
          const errorMsg = t('act_selectDropdownOption_notSelect', [
            input.index.toString(),
            elementNode.tagName || 'unknown',
          ]);
          this.context.emitEvent(Actors.NAVIGATOR, ExecutionState.ACT_FAIL, errorMsg);
          return new ActionResult({
            error: errorMsg,
            includeInMemory: true,
          });
        }

        logger.debug(`Attempting to select '${input.text}' using xpath: ${elementNode.xpath}`);

        try {
          const result = await page.selectDropdownOption(elementNode, input.text);
          const msg = t('act_selectDropdownOption_ok', [input.text, input.index.toString()]);
          this.context.emitEvent(Actors.NAVIGATOR, ExecutionState.ACT_OK, msg);
          return new ActionResult({
            extractedContent: result,
            includeInMemory: true,
          });
        } catch (error) {
          const errorMsg = t('act_selectDropdownOption_failed', [
            error instanceof Error ? error.message : String(error),
          ]);
          this.context.emitEvent(Actors.NAVIGATOR, ExecutionState.ACT_FAIL, errorMsg);
          return new ActionResult({
            error: errorMsg,
            includeInMemory: true,
          });
        }
      },
      selectDropdownOptionActionSchema,
      true,
    );
    actions.push(selectDropdownOption);

    return actions;
  }
}
