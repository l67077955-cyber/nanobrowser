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
  margin?: number; // top-1 minus top-2 target probability
  alternatives: DecisionAlternative[];
  path?: string[]; // groups narrowed through when the page had too many targets for one question, e.g. ["[6-10]"]
  deferred?: string; // why the step went to the LLM
}

export interface StepAction {
  name: string; // action name, e.g. click_element
  target?: string; // "[83]"
  detail?: string; // the action's intent; never the typed text, which may be a secret
  ok: boolean;
  error?: string;
}

/** Structured record of one planner or navigator step, rendered as a row in the side panel */
export type StepMeta =
  | {
      kind: 'planner';
      model: string;
      latencyMs: number;
      done: boolean;
    }
  | {
      kind: 'navigator';
      engine: 'jev' | 'llm';
      model: string; // model that made the executed decision
      latencyMs: number; // decision time, including a deferred Jev call
      actions: StepAction[];
      goal?: string;
      jev?: JevTrace;
    };

export interface Message {
  actor: Actors;
  content: string;
  timestamp: number; // Unix timestamp in milliseconds
  meta?: StepMeta;
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
