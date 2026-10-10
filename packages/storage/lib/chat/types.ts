export enum Actors {
  SYSTEM = 'system',
  USER = 'user',
  PLANNER = 'planner',
  NAVIGATOR = 'navigator',
  VALIDATOR = 'validator',
}

/** One scored alternative of a Jev decision head */
export interface DecisionAlternative {
  label: string;
  p: number;
}

/** Jev's pick for a navigator step, whether it was executed or deferred */
export interface JevTrace {
  model: string;
  latencyMs: number;
  operation: string;
  target?: string; // "[83] More · post: …"
  confidence: number;
  targetConfidence?: number;
  operationFloor?: number; // the floors the step was held to; the target floor eases on pages with many elements
  targetFloor?: number;
  margin?: number; // top-1 minus top-2 target probability
  alternatives: DecisionAlternative[];
  operations?: DecisionAlternative[]; // the operations Jev weighed, most likely first
  path?: string[]; // groups narrowed through when the page had too many targets for one question, e.g. ["[6-10]"]
  deferred?: string; // why the step went to the LLM
  noPick?: string; // set when Jev picked nothing at all: what went wrong, in full
}

export interface StepAction {
  name: string; // action name, e.g. click_element
  target?: string; // "[83]"
  label?: string; // what the page calls the element acted on; never what a field holds
  value?: string; // the address, search, key or option the action was given; never typed text
  detail?: string; // the action's intent; never the typed text, which may be a secret
  ok: boolean;
  error?: string;
}

/** What the model was given about the page when it decided a step */
export interface PageView {
  url: string;
  title: string;
  elements: number; // interactive elements listed for the model
  seen?: [number, number]; // the part of the page in view, as shares of its height from the top
  screenshot: boolean; // whether a picture of the page went with the text
  tabs: number; // other tabs the model was told about
  unreadable?: boolean; // the page could not be read
  tokens?: number; // size of everything the model was sent, by the message manager's estimate
  maxTokens?: number;
  text?: string; // the page as it was listed for the model; shown while the chat is open, not saved with it
}

/** Structured record of one planner or navigator step, rendered as a row in the side panel */
export type StepMeta =
  | {
      kind: 'planner';
      model: string;
      latencyMs: number;
      done: boolean;
      /** once done: what the user would likely ask for next, each a task of its own */
      followUps?: string[];
    }
  | {
      kind: 'navigator';
      engine: 'jev' | 'llm';
      model: string; // model that made the executed decision
      latencyMs: number; // decision time, including a deferred Jev call
      observeMs?: number; // reading the page before the decision
      actMs?: number; // running the actions
      actions: StepAction[];
      notes?: string[]; // what the step told the model besides the action results, e.g. that it is going round in circles
      goal?: string;
      jev?: JevTrace;
      view?: PageView;
    }
  | {
      // the navigator has read the page and is about to decide; shown live, never saved
      kind: 'observe';
      view: PageView;
    }
  | {
      // the agent asked the user something and waits for the reply before it goes on
      kind: 'question';
      /** values asked for in a small form beside the input box, so they are not typed in a reply */
      fields?: AskField[];
      /** the user is to do something on the page (sign in, a slider) and say when it is done */
      onPage?: boolean;
    };

/** One value the agent asks the user for */
export interface AskField {
  label: string; // what to enter, in the user's language
  kind: AskFieldKind;
}

export type AskFieldKind = 'text' | 'phone' | 'email' | 'code' | 'captcha';

export interface Message {
  actor: Actors;
  content: string;
  timestamp: number; // Unix timestamp in milliseconds
  meta?: StepMeta;
  failed?: boolean; // reports a failed action, step or task
}

export interface ChatMessage extends Message {
  id: string; // Unique ID for each message
}

export interface ChatSessionMetadata {
  id: string;
  title: string;
  createdAt: number; // Unix timestamp in milliseconds
  updatedAt: number; // Unix timestamp in milliseconds
  messageCount: number;
}

// ChatSession is the full conversation history displayed in the Sidepanel
export interface ChatSession extends ChatSessionMetadata {
  messages: ChatMessage[];
}

// ChatAgentStepHistory is the history of the every step of the agent
export interface ChatAgentStepHistory {
  task: string;
  history: string;
  timestamp: number; // Unix timestamp in milliseconds
}

// ChatAgentContext is what the agents knew when the session's last task ended, kept so the session can go on later
export interface ChatAgentContext {
  context: string;
  timestamp: number; // Unix timestamp in milliseconds
}

export interface ChatHistoryStorage {
  // Get all chat sessions (with empty message arrays for listing)
  getAllSessions: () => Promise<ChatSession[]>;

  // Clear all chat sessions and messages
  clearAllSessions: () => Promise<void>;

  // Get only session metadata (for efficient listing)
  getSessionsMetadata: () => Promise<ChatSessionMetadata[]>;

  // Get a specific chat session with its messages
  getSession: (sessionId: string) => Promise<ChatSession | null>;

  // Create a new chat session
  createSession: (title: string) => Promise<ChatSession>;

  // Update an existing chat session
  updateTitle: (sessionId: string, title: string) => Promise<ChatSessionMetadata>;

  // Delete a chat session
  deleteSession: (sessionId: string) => Promise<void>;

  // Add a message to a chat session
  addMessage: (sessionId: string, message: Message) => Promise<ChatMessage>;

  // Delete a message from a chat session
  deleteMessage: (sessionId: string, messageId: string) => Promise<void>;

  // Store the history of the agent's state
  storeAgentStepHistory: (sessionId: string, task: string, history: string) => Promise<void>;

  // Load the history of the agent's state
  loadAgentStepHistory: (sessionId: string) => Promise<ChatAgentStepHistory | null>;

  // Store what the agents know at the end of a task
  storeAgentContext: (sessionId: string, context: string) => Promise<void>;

  // Load what the agents knew at the end of the session's last task
  loadAgentContext: (sessionId: string) => Promise<string | null>;
}
