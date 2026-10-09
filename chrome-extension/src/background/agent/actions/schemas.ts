import { z } from 'zod';

export interface ActionSchema {
  name: string;
  description: string;
  schema: z.ZodType;
}

export const doneActionSchema: ActionSchema = {
  name: 'done',
  description: 'Complete task',
  schema: z.object({
    text: z.string(),
    success: z.boolean(),
  }),
};

export const askUserActionSchema: ActionSchema = {
  name: 'ask_user',
  description:
    'Ask the user one short question and wait for the reply, then carry on with it. For what only the user can decide, know or do: a choice between options that matters to them, a detail that cannot be found, signing in, a code sent to their phone. Values to type (phone, email, a code, an image captcha) are asked for as fields, all in one go, and come back as "label: value" lines. Not for things you can reasonably decide yourself. Always the last action of a step.',
  schema: z.object({
    intent: z.string().default('').describe('purpose of this action'),
    question: z.string().describe('the question, written to the user in their language'),
    fields: z
      .array(
        z.object({
          label: z.string().describe('what to enter, a word or two in the user\'s language, e.g. "Phone", "SMS code"'),
          kind: z
            .enum(['text', 'phone', 'email', 'code', 'captcha'])
            .describe('code: one sent by SMS or email; captcha: an image captcha, whose picture the user is shown'),
          index: z
            .number()
            .int()
            .nullable()
            .optional()
            .describe('index of the input field on the page the value goes into, when there is one'),
        }),
      )
      .nullable()
      .optional()
      .describe(
        'values to collect at once in a small form, at most 3: everything the next steps need from the user. Leave out what the request or the memories already say',
      ),
    on_page: z
      .boolean()
      .nullable()
      .optional()
      .describe('true when the user has to do something on the page themselves (sign in, a slider or puzzle captcha)'),
  }),
};

// Basic Navigation Actions
export const searchGoogleActionSchema: ActionSchema = {
  name: 'search_google',
  description:
    'Search the query in Google in the current tab, the query should be a search query like humans search in Google, concrete and not vague or super long. More the single most important items.',
  schema: z.object({
    intent: z.string().default('').describe('purpose of this action'),
    query: z.string(),
  }),
};

export const goToUrlActionSchema: ActionSchema = {
  name: 'go_to_url',
  description: 'Navigate to URL in the current tab',
  schema: z.object({
    intent: z.string().default('').describe('purpose of this action'),
    url: z.string(),
  }),
};

export const goBackActionSchema: ActionSchema = {
  name: 'go_back',
  description: 'Go back to the previous page',
  schema: z.object({
    intent: z.string().default('').describe('purpose of this action'),
  }),
};

export const clickElementActionSchema: ActionSchema = {
  name: 'click_element',
  description: 'Click element by index',
  schema: z.object({
    intent: z.string().default('').describe('purpose of this action'),
    index: z.number().int().describe('index of the element'),
  }),
};

export const inputTextActionSchema: ActionSchema = {
  name: 'input_text',
  description:
    'Input text into an interactive input element. The text replaces what the element contains: no click, select-all or delete is needed before it',
  schema: z.object({
    intent: z.string().default('').describe('purpose of this action'),
    index: z.number().int().describe('index of the element'),
    text: z.string().describe('text to input'),
    xpath: z.string().nullable().optional().describe('xpath of the element'),
  }),
};

export const solveCaptchaActionSchema: ActionSchema = {
  name: 'solve_captcha',
  description:
    'Read an image captcha (distorted characters or a simple arithmetic question) and type the result into its input field. The image itself is not visible to you: use this instead of input_text for such a field. An instruction inside the picture, such as to enter only the characters of one colour, is followed by itself',
  schema: z.object({
    intent: z.string().default('').describe('purpose of this action'),
    index: z.number().int().describe('index of the input field the captcha text goes into'),
    image_index: z
      .number()
      .int()
      .nullable()
      .optional()
      .describe('index of the captcha image if it is an indexed element; when omitted it is found beside the field'),
    refresh: z
      .boolean()
      .nullable()
      .optional()
      .describe('true gets a new captcha first by clicking the picture: use it after a failed or rejected attempt'),
  }),
};

// Tab Management Actions
export const switchTabActionSchema: ActionSchema = {
  name: 'switch_tab',
  description: 'Switch to tab by tab id',
  schema: z.object({
    intent: z.string().default('').describe('purpose of this action'),
    tab_id: z.number().int().describe('id of the tab to switch to'),
  }),
};

export const openTabActionSchema: ActionSchema = {
  name: 'open_tab',
  description: 'Open URL in new tab',
  schema: z.object({
    intent: z.string().default('').describe('purpose of this action'),
    url: z.string().describe('url to open'),
  }),
};

export const closeTabActionSchema: ActionSchema = {
  name: 'close_tab',
  description: 'Close tab by tab id',
  schema: z.object({
    intent: z.string().default('').describe('purpose of this action'),
    tab_id: z.number().int().describe('id of the tab'),
  }),
};

// Content Actions, not used currently
// export const extractContentActionSchema: ActionSchema = {
//   name: 'extract_content',
//   description:
//     'Extract page content to retrieve specific information from the page, e.g. all company names, a specific description, all information about, links with companies in structured format or simply links',
//   schema: z.object({
//     goal: z.string(),
//   }),
// };

// Cache Actions
export const cacheContentActionSchema: ActionSchema = {
  name: 'cache_content',
  description: 'Cache what you have found so far from the current page for future use',
  schema: z.object({
    intent: z.string().default('').describe('purpose of this action'),
    content: z.string().default('').describe('content to cache'),
  }),
};

export const readPageActionSchema: ActionSchema = {
  name: 'read_page',
  description:
    'Read the text of the whole current page in one go, including what is scrolled out of view: for reading, summarizing or looking things up in articles, posts, docs and long lists. Long pages come in parts: call again with the offset it gives to read on',
  schema: z.object({
    intent: z.string().default('').describe('purpose of this action'),
    offset: z.number().int().min(0).default(0).describe('character to start from, 0 for the beginning'),
  }),
};

export const scrollToPercentActionSchema: ActionSchema = {
  name: 'scroll_to_percent',
  description:
    'Scrolls to a particular vertical percentage of the document or an element. If no index of element is specified, scroll the whole document.',
  schema: z.object({
    intent: z.string().default('').describe('purpose of this action'),
    yPercent: z.number().int().describe('percentage to scroll to - min 0, max 100; 0 is top, 100 is bottom'),
    index: z.number().int().nullable().optional().describe('index of the element'),
  }),
};

export const scrollToTopActionSchema: ActionSchema = {
  name: 'scroll_to_top',
  description: 'Scroll the document in the window or an element to the top',
  schema: z.object({
    intent: z.string().default('').describe('purpose of this action'),
    index: z.number().int().nullable().optional().describe('index of the element'),
  }),
};

export const scrollToBottomActionSchema: ActionSchema = {
  name: 'scroll_to_bottom',
  description: 'Scroll the document in the window or an element to the bottom',
  schema: z.object({
    intent: z.string().default('').describe('purpose of this action'),
    index: z.number().int().nullable().optional().describe('index of the element'),
  }),
};

export const previousPageActionSchema: ActionSchema = {
  name: 'previous_page',
  description:
    'Scroll the document in the window or an element to the previous page. If no index is specified, scroll the whole document.',
  schema: z.object({
    intent: z.string().default('').describe('purpose of this action'),
    index: z.number().int().nullable().optional().describe('index of the element'),
  }),
};

export const nextPageActionSchema: ActionSchema = {
  name: 'next_page',
  description:
    'Scroll the document in the window or an element to the next page. If no index is specified, scroll the whole document.',
  schema: z.object({
    intent: z.string().default('').describe('purpose of this action'),
    index: z.number().int().nullable().optional().describe('index of the element'),
  }),
};

export const scrollToTextActionSchema: ActionSchema = {
  name: 'scroll_to_text',
  description: 'If you dont find something which you want to interact with in current viewport, try to scroll to it',
  schema: z.object({
    intent: z.string().default('').describe('purpose of this action'),
    text: z.string().describe('text to scroll to'),
    nth: z
      .number()
      .int()
      .min(1)
      .default(1)
      .describe('which occurrence of the text to scroll to (1-indexed, default: 1)'),
  }),
};

export const sendKeysActionSchema: ActionSchema = {
  name: 'send_keys',
  description:
    'Send strings of special keys like Backspace, Insert, PageDown, Delete, Enter. Shortcuts such as `Control+o`, `Control+Shift+T` are supported as well. This gets used in keyboard press. Be aware of different operating systems and their shortcuts',
  schema: z.object({
    intent: z.string().default('').describe('purpose of this action'),
    keys: z.string().describe('keys to send'),
  }),
};

export const getDropdownOptionsActionSchema: ActionSchema = {
  name: 'get_dropdown_options',
  description: 'Get all options from a native dropdown',
  schema: z.object({
    intent: z.string().default('').describe('purpose of this action'),
    index: z.number().int().describe('index of the dropdown element'),
  }),
};

export const selectDropdownOptionActionSchema: ActionSchema = {
  name: 'select_dropdown_option',
  description: 'Select dropdown option for interactive element index by the text of the option you want to select',
  schema: z.object({
    intent: z.string().default('').describe('purpose of this action'),
    index: z.number().int().describe('index of the dropdown element'),
    text: z.string().describe('text of the option'),
  }),
};

export const waitActionSchema: ActionSchema = {
  name: 'wait',
  description: 'Wait for x seconds default 3, do NOT use this action unless user asks to wait explicitly',
  schema: z.object({
    intent: z.string().default('').describe('purpose of this action'),
    seconds: z.number().int().default(3).describe('amount of seconds'),
  }),
};
