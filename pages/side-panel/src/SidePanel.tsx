/* eslint-disable @typescript-eslint/no-explicit-any */
import { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { FiSettings, FiPlus, FiClock, FiChevronLeft, FiMoreHorizontal, FiCheck, FiArrowDown } from 'react-icons/fi';
import {
  type Message,
  type StepMeta,
  Actors,
  chatHistoryStore,
  agentModelStore,
  generalSettingsStore,
} from '@extension/storage';
import favoritesStorage, { type FavoritePrompt } from '@extension/storage/lib/prompt/favorites';
import { t } from '@extension/i18n';
import MessageList, { type Activity } from './components/MessageList';
import ContextPeek from './components/ModelView';
import Welcome from './components/Welcome';
import { latestView, withoutPageText } from './components/steps';
import ChatInput from './components/ChatInput';
import AgentDock from './components/AgentDock';
import AskCard, { type Ask } from './components/AskCard';
import ChatHistoryList from './components/ChatHistoryList';
import BookmarkList from './components/BookmarkList';
import WindowToggleButton, { useHandedOffSession } from './components/WindowToggleButton';
import { getTargetTab } from './utils';
import { EventType, type AgentEvent, ExecutionState } from './types/event';
import './SidePanel.css';

// Declare chrome API types
declare global {
  interface Window {
    chrome: typeof chrome;
  }
}

// Rows for these are shown as failures whatever their wording
const FAILURE_STATES = [ExecutionState.TASK_FAIL, ExecutionState.STEP_FAIL, ExecutionState.ACT_FAIL];

// The choice between the plain view and the one with every step's model, confidence and timing
const DETAILED_VIEW_KEY = 'nb-detailed-view';
// The chat the panel had open, for it to show again when it is reopened
const LAST_SESSION_KEY = 'nb-last-session';

function readDetailedView(): boolean {
  try {
    return localStorage.getItem(DETAILED_VIEW_KEY) === '1';
  } catch {
    return false;
  }
}

const SidePanel = () => {
  const [messages, setMessages] = useState<Message[]>([]);
  // what the agent is doing between the steps it has finished
  const [activity, setActivity] = useState<Activity | null>(null);
  const [detailed, setDetailed] = useState(readDetailedView);
  const [sessionTitle, setSessionTitle] = useState<string | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  // the chat follows new steps only while the user is reading at its end
  const [awayFromEnd, setAwayFromEnd] = useState(false);
  const followRef = useRef(true);
  const scrollRef = useRef<HTMLDivElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const [inputEnabled, setInputEnabled] = useState(true);
  const [showStopButton, setShowStopButton] = useState(false);
  // action text awaiting the user's approval (manual action mode)
  const [pendingConfirmation, setPendingConfirmation] = useState<string | null>(null);
  // the agent asked something in the chat and waits for the reply
  const [awaitingReply, setAwaitingReply] = useState(false);
  /** the values the agent asked for, filled in beside the input box while it waits */
  const [ask, setAsk] = useState<Ask | null>(null);
  const [askCaptchas, setAskCaptchas] = useState<Record<number, string | null | undefined>>({});
  const [currentSessionId, setCurrentSessionId] = useState<string | null>(null);
  const [showHistory, setShowHistory] = useState(false);
  const [chatSessions, setChatSessions] = useState<Array<{ id: string; title: string; createdAt: number }>>([]);
  const [isFollowUpMode, setIsFollowUpMode] = useState(false);
  const [isHistoricalSession, setIsHistoricalSession] = useState(false);
  const [favoritePrompts, setFavoritePrompts] = useState<FavoritePrompt[]>([]);
  const [hasConfiguredModels, setHasConfiguredModels] = useState<boolean | null>(null); // null = loading, false = no models, true = has models
  const [isReplaying, setIsReplaying] = useState(false);
  /** goals the user lined up while a task ran: each starts on its own once the one before is done */
  const [queue, setQueue] = useState<{ text: string; display?: string }[]>([]);
  /** the queue waits for the user: the goal before it failed or was stopped */
  const [queueHeld, setQueueHeld] = useState(false);
  const [replayEnabled, setReplayEnabled] = useState(false);
  const sessionIdRef = useRef<string | null>(null);
  const isReplayingRef = useRef<boolean>(false);
  const portRef = useRef<chrome.runtime.Port | null>(null);
  const heartbeatIntervalRef = useRef<number | null>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const setInputTextRef = useRef<((text: string) => void) | null>(null);

  // Check if models are configured
  const checkModelConfiguration = useCallback(async () => {
    try {
      const configuredAgents = await agentModelStore.getConfiguredAgents();

      // Check if at least one agent (preferably Navigator) is configured
      const hasAtLeastOneModel = configuredAgents.length > 0;
      setHasConfiguredModels(hasAtLeastOneModel);
    } catch (error) {
      console.error('Error checking model configuration:', error);
      setHasConfiguredModels(false);
    }
  }, []);

  // Load general settings to check if replay is enabled
  const loadGeneralSettings = useCallback(async () => {
    try {
      const settings = await generalSettingsStore.getSettings();
      setReplayEnabled(settings.replayHistoricalTasks);
    } catch (error) {
      console.error('Error loading general settings:', error);
      setReplayEnabled(false);
    }
  }, []);

  // Check model configuration on mount, and again whenever the settings are saved: no reopening needed
  useEffect(() => {
    checkModelConfiguration();
    loadGeneralSettings();
    const unsubscribeModels = agentModelStore.subscribe(checkModelConfiguration);
    const unsubscribeSettings = generalSettingsStore.subscribe(loadGeneralSettings);
    return () => {
      unsubscribeModels();
      unsubscribeSettings();
    };
  }, [checkModelConfiguration, loadGeneralSettings]);

  // Re-check model configuration when the side panel becomes visible again
  useEffect(() => {
    const handleVisibilityChange = () => {
      if (!document.hidden) {
        // Panel became visible, re-check configuration and settings
        checkModelConfiguration();
        loadGeneralSettings();
      }
    };

    const handleFocus = () => {
      // Panel gained focus, re-check configuration and settings
      checkModelConfiguration();
      loadGeneralSettings();
    };

    document.addEventListener('visibilitychange', handleVisibilityChange);
    window.addEventListener('focus', handleFocus);

    return () => {
      document.removeEventListener('visibilitychange', handleVisibilityChange);
      window.removeEventListener('focus', handleFocus);
    };
  }, [checkModelConfiguration, loadGeneralSettings]);

  useEffect(() => {
    sessionIdRef.current = currentSessionId;
  }, [currentSessionId]);

  useEffect(() => {
    isReplayingRef.current = isReplaying;
  }, [isReplaying]);

  const appendMessage = useCallback((newMessage: Message, sessionId?: string | null) => {
    setMessages(prev => [...prev, newMessage]);

    // Use provided sessionId if available, otherwise fall back to sessionIdRef.current
    const effectiveSessionId = sessionId !== undefined ? sessionId : sessionIdRef.current;

    console.log('sessionId', effectiveSessionId);

    // Save message to storage if we have a session
    if (effectiveSessionId) {
      chatHistoryStore
        .addMessage(effectiveSessionId, withoutPageText(newMessage))
        .catch(err => console.error('Failed to save message to history:', err));
    }
  }, []);

  /** A question with values to fill in, or something to do on the page, gets a card beside the input box */
  const showAsk = useCallback((question: string, meta?: StepMeta) => {
    const fields = meta?.kind === 'question' ? (meta.fields ?? []) : [];
    const onPage = meta?.kind === 'question' && meta.onPage === true;
    setAskCaptchas({});
    setAsk(fields.length > 0 || onPage ? { question, fields, onPage } : null);
  }, []);

  const handleTaskState = useCallback(
    (event: AgentEvent) => {
      const { actor, state, timestamp, data } = event;
      const content = data?.details;
      let skip = true;

      switch (actor) {
        case Actors.SYSTEM:
          switch (state) {
            case ExecutionState.TASK_START:
              // Reset historical session flag when a new task starts
              setIsHistoricalSession(false);
              break;
            case ExecutionState.TASK_OK:
              setQueueHeld(false);
              setActivity(null);
              setPendingConfirmation(null);
              setAwaitingReply(false);
              setIsFollowUpMode(true);
              setInputEnabled(true);
              setShowStopButton(false);
              setIsReplaying(false);
              break;
            case ExecutionState.TASK_FAIL:
              setQueueHeld(true);
              setActivity(null);
              setPendingConfirmation(null);
              setAwaitingReply(false);
              setIsFollowUpMode(true);
              setInputEnabled(true);
              setShowStopButton(false);
              setIsReplaying(false);
              skip = false;
              break;
            case ExecutionState.TASK_CANCEL:
              setQueueHeld(true);
              setActivity(null);
              setPendingConfirmation(null);
              setAwaitingReply(false);
              setIsFollowUpMode(false);
              setInputEnabled(true);
              setShowStopButton(false);
              setIsReplaying(false);
              skip = false;
              break;
            case ExecutionState.TASK_PAUSE:
              break;
            case ExecutionState.TASK_RESUME:
              break;
            default:
              console.error('Invalid task state', state);
              return;
          }
          break;
        case Actors.USER:
          break;
        case Actors.PLANNER:
          switch (state) {
            case ExecutionState.STEP_START:
              setActivity({ phase: 'planning' });
              break;
            case ExecutionState.STEP_OK:
              skip = false;
              break;
            case ExecutionState.STEP_FAIL:
              skip = false;
              break;
            case ExecutionState.STEP_CANCEL:
              break;
            default:
              console.error('Invalid step state', state);
              return;
          }
          break;
        case Actors.NAVIGATOR:
          switch (state) {
            case ExecutionState.STEP_START:
              setActivity(prev => ({ phase: 'reading', view: prev?.view }));
              break;
            case ExecutionState.STEP_OBSERVE:
              // the page has been read: what the model is given about it is shown while it decides
              if (data?.meta?.kind === 'observe') setActivity({ phase: 'deciding', view: data.meta.view });
              break;
            case ExecutionState.STEP_DECIDED:
              // what the model is about to do, in its own words, stands for the step until it is done
              setActivity(prev => ({ phase: 'acting', text: content, goal: true, view: prev?.view }));
              break;
            case ExecutionState.STEP_OK:
              // one row per step, carrying who decided and what ran
              skip = !data?.meta;
              setActivity(prev => ({ phase: 'reading', view: prev?.view }));
              break;
            case ExecutionState.STEP_FAIL:
              skip = false;
              break;
            case ExecutionState.STEP_CANCEL:
              break;
            case ExecutionState.ACT_START:
              // the step row comes once the step finishes; until then the action is what is happening now,
              // unless the model has already said so in its own words
              setActivity(prev => (prev?.goal ? prev : { phase: 'acting', text: content, view: prev?.view }));
              break;
            case ExecutionState.ACT_OK:
              skip = !isReplayingRef.current;
              break;
            case ExecutionState.ACT_FAIL:
              skip = false;
              break;
            case ExecutionState.ACT_CONFIRM:
              setPendingConfirmation(content || '');
              setActivity(prev => ({ phase: 'waiting', view: prev?.view }));
              break;
            case ExecutionState.ACT_ASK:
              // the question is part of the conversation; the next message the user sends answers it
              skip = false;
              setAwaitingReply(true);
              showAsk(content || '', data?.meta);
              setActivity(prev => ({ phase: 'asking', view: prev?.view }));
              break;
            default:
              console.error('Invalid action', state);
              return;
          }
          break;
        case Actors.VALIDATOR:
          // Handle legacy validator events from historical messages
          switch (state) {
            case ExecutionState.STEP_START:
              break;
            case ExecutionState.STEP_OK:
              skip = false;
              break;
            case ExecutionState.STEP_FAIL:
              skip = false;
              break;
            default:
              console.error('Invalid validation', state);
              return;
          }
          break;
        default:
          console.error('Unknown actor', actor);
          return;
      }

      if (!skip) {
        appendMessage({
          actor,
          content: content || '',
          timestamp: timestamp,
          ...(data?.meta ? { meta: data.meta } : {}),
          ...(state === ExecutionState.ACT_ASK && data?.meta?.kind !== 'question'
            ? { meta: { kind: 'question' as const } }
            : {}),
          ...(FAILURE_STATES.includes(state) ? { failed: true } : {}),
        });
      }
    },
    [appendMessage, showAsk],
  );

  /** Steps of a running task this panel takes over, held until the chat saved so far is shown */
  const attachQueueRef = useRef<AgentEvent[] | null>(null);

  /**
   * A task asked for in a side panel runs on when the panel is closed. The panel opened next takes it over:
   * the chat as saved so far, then the steps as they come, and what the task waits for from the user.
   */
  const attachToTask = useCallback(
    async (taskId: string, waitingFor: { state: ExecutionState; details: string; meta?: StepMeta } | null) => {
      attachQueueRef.current = [];
      sessionIdRef.current = taskId;
      setCurrentSessionId(taskId);
      setIsHistoricalSession(false);
      setIsFollowUpMode(true);
      setInputEnabled(true);
      setShowStopButton(true);
      followRef.current = true;
      setAwayFromEnd(false);
      try {
        const session = await chatHistoryStore.getSession(taskId);
        if (session) {
          setSessionTitle(session.title);
          setMessages(session.messages);
        }
        const view = session ? latestView(session.messages) : undefined;
        if (waitingFor?.state === ExecutionState.ACT_CONFIRM) {
          setPendingConfirmation(waitingFor.details || '');
          setActivity({ phase: 'waiting', view });
        } else if (waitingFor?.state === ExecutionState.ACT_ASK) {
          setAwaitingReply(true);
          showAsk(waitingFor.details || '', waitingFor.meta);
          setActivity({ phase: 'asking', view });
        } else {
          setActivity({ phase: 'reading', view });
        }
      } catch (err) {
        console.error('Failed to load the chat of the running task:', err);
      }
      const queued = attachQueueRef.current ?? [];
      attachQueueRef.current = null;
      for (const event of queued) handleTaskState(event);
    },
    [handleTaskState, showAsk],
  );

  /** A task an agent started through the bridge: it gets a chat of its own, and the stop button ends it */
  const showRemoteTask = useCallback(
    async (task: string) => {
      // what the task reports before its chat exists is shown, and not saved into the chat that was open
      sessionIdRef.current = null;
      setCurrentSessionId(null);
      setMessages([]);
      setActivity(null);
      setIsFollowUpMode(false);
      setIsHistoricalSession(false);
      setInputEnabled(false);
      setShowStopButton(true);
      const userMessage = { actor: Actors.USER, content: t('chat_remote_task', [task]), timestamp: Date.now() };
      try {
        const title = userMessage.content;
        const session = await chatHistoryStore.createSession(title.substring(0, 50) + (title.length > 50 ? '...' : ''));
        setSessionTitle(session.title);
        setCurrentSessionId(session.id);
        sessionIdRef.current = session.id;
      } catch (err) {
        console.error('Failed to create a chat for the remote task:', err);
      }
      appendMessage(userMessage, sessionIdRef.current);
    },
    [appendMessage],
  );

  // Stop heartbeat and close connection
  const stopConnection = useCallback(() => {
    if (heartbeatIntervalRef.current) {
      clearInterval(heartbeatIntervalRef.current);
      heartbeatIntervalRef.current = null;
    }
    if (portRef.current) {
      portRef.current.disconnect();
      portRef.current = null;
    }
  }, []);

  // Setup connection management
  const setupConnection = useCallback(() => {
    // Only setup if no existing connection
    if (portRef.current) {
      return;
    }

    try {
      portRef.current = chrome.runtime.connect({ name: 'side-panel-connection' });

      // biome-ignore lint/suspicious/noExplicitAny: <explanation>
      portRef.current.onMessage.addListener((message: any) => {
        // Add type checking for message
        if (message && message.type === EventType.EXECUTION) {
          if (attachQueueRef.current) attachQueueRef.current.push(message);
          else handleTaskState(message);
        } else if (message && message.type === 'ask_captcha') {
          setAskCaptchas(prev => ({ ...prev, [Number(message.field)]: message.image ?? null }));
        } else if (message && message.type === 'task_attached') {
          void attachToTask(String(message.taskId), message.waitingFor ?? null);
        } else if (message && message.type === 'error') {
          // Handle error messages from service worker
          appendMessage({
            actor: Actors.SYSTEM,
            content: message.error || t('errors_unknown'),
            timestamp: Date.now(),
            failed: true,
          });
          setActivity(null);
          setInputEnabled(true);
          setShowStopButton(false);
        } else if (message && message.type === 'remote_task') {
          void showRemoteTask(String(message.task ?? ''));
        } else if (message && message.type === 'heartbeat_ack') {
          console.log('Heartbeat acknowledged');
        }
      });

      portRef.current.onDisconnect.addListener(() => {
        const error = chrome.runtime.lastError;
        console.log('Connection disconnected', error ? `Error: ${error.message}` : '');
        portRef.current = null;
        if (heartbeatIntervalRef.current) {
          clearInterval(heartbeatIntervalRef.current);
          heartbeatIntervalRef.current = null;
        }
        setActivity(null);
        setInputEnabled(true);
        setShowStopButton(false);
      });

      // Setup heartbeat interval
      if (heartbeatIntervalRef.current) {
        clearInterval(heartbeatIntervalRef.current);
      }

      heartbeatIntervalRef.current = window.setInterval(() => {
        if (portRef.current?.name === 'side-panel-connection') {
          try {
            portRef.current.postMessage({ type: 'heartbeat' });
          } catch (error) {
            console.error('Heartbeat failed:', error);
            stopConnection(); // Stop connection if heartbeat fails
          }
        } else {
          stopConnection(); // Stop if port is invalid
        }
      }, 25000);
    } catch (error) {
      console.error('Failed to establish connection:', error);
      appendMessage({
        actor: Actors.SYSTEM,
        content: t('errors_conn_serviceWorker'),
        timestamp: Date.now(),
      });
      // Clear any references since connection failed
      portRef.current = null;
    }
  }, [handleTaskState, appendMessage, stopConnection, showRemoteTask, attachToTask]);

  // Add safety check for message sending
  const sendMessage = useCallback(
    // biome-ignore lint/suspicious/noExplicitAny: <explanation>
    (message: any) => {
      if (portRef.current?.name !== 'side-panel-connection') {
        throw new Error('No valid connection available');
      }
      try {
        portRef.current.postMessage(message);
      } catch (error) {
        console.error('Failed to send message:', error);
        stopConnection(); // Stop connection when message sending fails
        throw error;
      }
    },
    [stopConnection],
  );

  // Handle replay command
  const handleReplay = async (historySessionId: string): Promise<void> => {
    try {
      // Check if replay is enabled in settings
      if (!replayEnabled) {
        appendMessage({
          actor: Actors.SYSTEM,
          content: t('chat_replay_disabled'),
          timestamp: Date.now(),
        });
        return;
      }

      // Check if history exists using loadAgentStepHistory
      const historyData = await chatHistoryStore.loadAgentStepHistory(historySessionId);
      if (!historyData) {
        appendMessage({
          actor: Actors.SYSTEM,
          content: t('chat_replay_noHistory', historySessionId.substring(0, 20)),
          timestamp: Date.now(),
        });
        return;
      }

      // Get current tab ID
      const tabId = (await getTargetTab())?.id;
      if (!tabId) {
        throw new Error('No active tab found');
      }

      // Clear messages if we're in a historical session
      if (isHistoricalSession) {
        setMessages([]);
      }

      // Create a new chat session for this replay task
      const newSession = await chatHistoryStore.createSession(`Replay of ${historySessionId.substring(0, 20)}...`);
      console.log('newSession for replay', newSession);

      // Store the new session ID in both state and ref
      const newTaskId = newSession.id;
      setSessionTitle(newSession.title);
      setCurrentSessionId(newTaskId);
      sessionIdRef.current = newTaskId;

      // Send replay command to background
      setInputEnabled(false);
      setShowStopButton(true);

      // Reset follow-up mode and historical session flags
      setIsFollowUpMode(false);
      setIsHistoricalSession(false);

      const userMessage = {
        actor: Actors.USER,
        content: `/replay ${historySessionId}`,
        timestamp: Date.now(),
      };

      // Add the user message to the new session
      appendMessage(userMessage, sessionIdRef.current);

      // Setup connection if not exists
      if (!portRef.current) {
        setupConnection();
      }

      // Send replay command to background with the task from history
      portRef.current?.postMessage({
        type: 'replay',
        taskId: newTaskId,
        tabId: tabId,
        historySessionId: historySessionId,
        task: historyData.task, // Add the task from history
      });

      appendMessage({
        actor: Actors.SYSTEM,
        content: t('chat_replay_starting', historyData.task),
        timestamp: Date.now(),
      });
      setIsReplaying(true);
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      appendMessage({
        actor: Actors.SYSTEM,
        content: t('chat_replay_failed', errorMessage),
        timestamp: Date.now(),
      });
    }
  };

  // Handle chat commands that start with /
  const handleCommand = async (command: string): Promise<boolean> => {
    try {
      // Setup connection if not exists
      if (!portRef.current) {
        setupConnection();
      }

      // Handle different commands
      if (command === '/state') {
        portRef.current?.postMessage({
          type: 'state',
        });
        return true;
      }

      if (command === '/nohighlight') {
        portRef.current?.postMessage({
          type: 'nohighlight',
        });
        return true;
      }

      if (command.startsWith('/replay ')) {
        // Parse replay command: /replay <historySessionId>
        // Handle multiple spaces by filtering out empty strings
        const parts = command.split(' ').filter(part => part.trim() !== '');
        if (parts.length !== 2) {
          appendMessage({
            actor: Actors.SYSTEM,
            content: t('chat_replay_invalidArgs'),
            timestamp: Date.now(),
          });
          return true;
        }

        const historySessionId = parts[1];
        await handleReplay(historySessionId);
        return true;
      }

      // Unsupported command
      appendMessage({
        actor: Actors.SYSTEM,
        content: t('errors_cmd_unknown', command),
        timestamp: Date.now(),
      });
      return true;
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      console.error('Command error', errorMessage);
      appendMessage({
        actor: Actors.SYSTEM,
        content: errorMessage,
        timestamp: Date.now(),
      });
      return true;
    }
  };

  const handleSendMessage = async (text: string, displayText?: string) => {
    console.log('handleSendMessage', text);

    // Trim the input text first
    const trimmedText = text.trim();

    if (!trimmedText) return;

    // Check if the input is a command (starts with /)
    if (trimmedText.startsWith('/')) {
      // Process command and return if it was handled
      const wasHandled = await handleCommand(trimmedText);
      if (wasHandled) return;
    }

    // While the agent works, a message is taken in by the task under way: a reply to its question, or
    // something to add or change. It does not wait for the task to end.
    if (showStopButton && !isReplaying && sessionIdRef.current) {
      const userMessage = { actor: Actors.USER, content: displayText || text, timestamp: Date.now() };
      appendMessage(userMessage, sessionIdRef.current);
      followRef.current = true;
      setAwayFromEnd(false);
      setAwaitingReply(false);
      // a message instead of a click: the action waiting for approval is not taken
      setPendingConfirmation(null);
      setActivity(prev => ({ phase: 'planning', view: prev?.view }));
      try {
        const tabId = (await getTargetTab())?.id;
        sendMessage({ type: 'steer', task: text, taskId: sessionIdRef.current, tabId, sentAt: userMessage.timestamp });
      } catch (err) {
        console.error('steer error', err);
      }
      return;
    }

    try {
      const tabId = (await getTargetTab())?.id;
      if (!tabId) {
        throw new Error('No active tab found');
      }

      setShowStopButton(true);
      // whoever sends a message wants to see what comes of it
      followRef.current = true;
      setAwayFromEnd(false);

      // Create a new chat session for this task if not in follow-up mode
      if (!isFollowUpMode) {
        // Use display text for session title if available, otherwise use full text
        const titleText = displayText || text;
        const newSession = await chatHistoryStore.createSession(
          titleText.substring(0, 50) + (titleText.length > 50 ? '...' : ''),
        );
        console.log('newSession', newSession);

        // Store the session ID in both state and ref
        const sessionId = newSession.id;
        setSessionTitle(newSession.title);
        setCurrentSessionId(sessionId);
        sessionIdRef.current = sessionId;
      }

      const userMessage = {
        actor: Actors.USER,
        content: displayText || text, // Use display text for chat UI, full text for background service
        timestamp: Date.now(),
      };

      // Pass the sessionId directly to appendMessage
      appendMessage(userMessage, sessionIdRef.current);

      // Setup connection if not exists
      if (!portRef.current) {
        setupConnection();
      }

      // Send message using the utility function
      if (isFollowUpMode) {
        // Send as follow-up task
        await sendMessage({
          type: 'follow_up_task',
          task: text,
          taskId: sessionIdRef.current,
          tabId,
          // when the background has to rebuild the session from the chat, this message is not part of it
          sentAt: userMessage.timestamp,
        });
        console.log('follow_up_task sent', text, tabId, sessionIdRef.current);
      } else {
        // Send as new task
        await sendMessage({
          type: 'new_task',
          task: text,
          taskId: sessionIdRef.current,
          tabId,
        });
        console.log('new_task sent', text, tabId, sessionIdRef.current);
      }
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      console.error('Task error', errorMessage);
      appendMessage({
        actor: Actors.SYSTEM,
        content: errorMessage,
        timestamp: Date.now(),
      });
      setActivity(null);
      setInputEnabled(true);
      setShowStopButton(false);
      stopConnection();
    }
  };

  // The loop: once a goal is done the next one in the queue starts, after a moment to show the answer
  const sendRef = useRef(handleSendMessage);
  sendRef.current = handleSendMessage;
  const advancingRef = useRef(false);
  useEffect(() => {
    if (showStopButton || queueHeld || !inputEnabled || queue.length === 0 || advancingRef.current) return;
    const timer = window.setTimeout(() => {
      const [next, ...rest] = queue;
      setQueue(rest);
      advancingRef.current = true;
      void sendRef.current(next.text, next.display).finally(() => {
        advancingRef.current = false;
      });
    }, 900);
    return () => window.clearTimeout(timer);
  }, [showStopButton, queueHeld, inputEnabled, queue]);

  const handleQueue = (text: string, display?: string) => {
    if (!text.trim()) return;
    setQueue(prev => [...prev, { text, display }]);
  };

  const handleConfirmAction = (approved: boolean) => {
    portRef.current?.postMessage({ type: 'confirm_action', approved });
    setPendingConfirmation(null);
  };

  const handleStopTask = async () => {
    // stopping one goal is not a go-ahead for the next
    setQueueHeld(true);
    try {
      portRef.current?.postMessage({
        type: 'cancel_task',
        taskId: sessionIdRef.current,
      });
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      console.error('cancel_task error', errorMessage);
      appendMessage({
        actor: Actors.SYSTEM,
        content: errorMessage,
        timestamp: Date.now(),
      });
    }
    setActivity(null);
    setAwaitingReply(false);
    setInputEnabled(true);
    setShowStopButton(false);
  };

  const handleNewChat = () => {
    // Clear messages and start a new chat
    setMessages([]);
    setActivity(null);
    setSessionTitle(null);
    setCurrentSessionId(null);
    sessionIdRef.current = null;
    setInputEnabled(true);
    setShowStopButton(false);
    setIsFollowUpMode(false);
    setIsHistoricalSession(false);
    setQueue([]);
    setQueueHeld(false);

    // Disconnect any existing connection
    stopConnection();
  };

  const loadChatSessions = useCallback(async () => {
    try {
      const sessions = await chatHistoryStore.getSessionsMetadata();
      setChatSessions(sessions.sort((a, b) => b.createdAt - a.createdAt));
    } catch (error) {
      console.error('Failed to load chat sessions:', error);
    }
  }, []);

  const handleLoadHistory = async () => {
    await loadChatSessions();
    setShowHistory(true);
  };

  const handleBackToChat = (reset = false) => {
    setShowHistory(false);
    if (reset) {
      setCurrentSessionId(null);
      setSessionTitle(null);
      setMessages([]);
      setIsFollowUpMode(false);
      setIsHistoricalSession(false);
    }
  };

  const handleSessionSelect = async (sessionId: string) => {
    try {
      const fullSession = await chatHistoryStore.getSession(sessionId);
      if (fullSession && fullSession.messages.length > 0) {
        setCurrentSessionId(fullSession.id);
        setSessionTitle(fullSession.title);
        setMessages(fullSession.messages);
        setActivity(null);
        setQueue([]);
        setQueueHeld(false);
        followRef.current = true;
        setAwayFromEnd(false);
        // A message sent from here continues the session: the background reloads its context
        setIsFollowUpMode(true);
        setIsHistoricalSession(true); // Mark this as a historical session
        console.log('history session selected', sessionId);
      }
      setShowHistory(false);
    } catch (error) {
      console.error('Failed to load session:', error);
    }
  };

  // the chat the side panel or window this one replaced had open; a running task here is not interrupted for it
  const showHandedOffRef = useRef(handleSessionSelect);
  showHandedOffRef.current = showStopButton ? () => Promise.resolve() : handleSessionSelect;
  useHandedOffSession(useCallback((sessionId: string) => void showHandedOffRef.current(sessionId), []));

  // Closed and opened again, the panel shows the chat it had open, unless a running task took its place meanwhile.
  // Kept for the browser session: a new chat stays new, and a restarted browser starts with one.
  const restoredRef = useRef(false);
  useEffect(() => {
    chrome.storage.session
      .get(LAST_SESSION_KEY)
      .then(stored => {
        const sessionId = stored[LAST_SESSION_KEY];
        if (typeof sessionId === 'string' && !sessionIdRef.current) void showHandedOffRef.current(sessionId);
      })
      .catch(err => console.error('Failed to reopen the last chat:', err))
      .finally(() => {
        restoredRef.current = true;
      });
  }, []);
  useEffect(() => {
    if (!restoredRef.current) return;
    const saved = currentSessionId
      ? chrome.storage.session.set({ [LAST_SESSION_KEY]: currentSessionId })
      : chrome.storage.session.remove(LAST_SESSION_KEY);
    saved.catch(err => console.error('Failed to remember the open chat:', err));
  }, [currentSessionId]);

  const handleSessionDelete = async (sessionId: string) => {
    try {
      await chatHistoryStore.deleteSession(sessionId);
      await loadChatSessions();
      if (sessionId === currentSessionId) {
        setMessages([]);
        setCurrentSessionId(null);
        setSessionTitle(null);
      }
    } catch (error) {
      console.error('Failed to delete session:', error);
    }
  };

  const handleSessionBookmark = async (sessionId: string) => {
    try {
      const fullSession = await chatHistoryStore.getSession(sessionId);

      if (fullSession && fullSession.messages.length > 0) {
        // Get the session title
        const sessionTitle = fullSession.title;
        // Get the first 8 words of the title
        const title = sessionTitle.split(' ').slice(0, 8).join(' ');

        // Get the first message content (the task)
        const taskContent = fullSession.messages[0]?.content || '';

        // Add to favorites storage
        await favoritesStorage.addPrompt(title, taskContent);

        // Update favorites in the UI
        const prompts = await favoritesStorage.getAllPrompts();
        setFavoritePrompts(prompts);

        // Return to chat view after pinning
        handleBackToChat(true);
      }
    } catch (error) {
      console.error('Failed to pin session to favorites:', error);
    }
  };

  const handleBookmarkSelect = (content: string) => {
    if (setInputTextRef.current) {
      setInputTextRef.current(content);
    }
  };

  const handleBookmarkUpdateTitle = async (id: number, title: string) => {
    try {
      await favoritesStorage.updatePromptTitle(id, title);

      // Update favorites in the UI
      const prompts = await favoritesStorage.getAllPrompts();
      setFavoritePrompts(prompts);
    } catch (error) {
      console.error('Failed to update favorite prompt title:', error);
    }
  };

  const handleBookmarkDelete = async (id: number) => {
    try {
      await favoritesStorage.removePrompt(id);

      // Update favorites in the UI
      const prompts = await favoritesStorage.getAllPrompts();
      setFavoritePrompts(prompts);
    } catch (error) {
      console.error('Failed to delete favorite prompt:', error);
    }
  };

  const handleBookmarkReorder = async (draggedId: number, targetId: number) => {
    try {
      // Directly pass IDs to storage function - it now handles the reordering logic
      await favoritesStorage.reorderPrompts(draggedId, targetId);

      // Fetch the updated list from storage to get the new IDs and reflect the authoritative order
      const updatedPromptsFromStorage = await favoritesStorage.getAllPrompts();
      setFavoritePrompts(updatedPromptsFromStorage);
    } catch (error) {
      console.error('Failed to reorder favorite prompts:', error);
    }
  };

  // Load favorite prompts from storage
  useEffect(() => {
    const loadFavorites = async () => {
      try {
        const prompts = await favoritesStorage.getAllPrompts();
        setFavoritePrompts(prompts);
      } catch (error) {
        console.error('Failed to load favorite prompts:', error);
      }
    };

    loadFavorites();
  }, []);

  // An open side panel listens from the start: a task still running from before it was closed shows up here,
  // and so does one an agent starts, whose sensitive actions can be approved
  useEffect(() => {
    setupConnection();
  }, [setupConnection]);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      stopConnection();
    };
  }, [stopConnection]);

  // New steps are followed while the user is at the end of the chat; someone reading further up is left alone
  // biome-ignore lint/correctness/useExhaustiveDependencies: <explanation>
  useEffect(() => {
    if (followRef.current) messagesEndRef.current?.scrollIntoView();
  }, [messages, activity]);

  // Steps that grow in place, a panel that gets shorter, or a composer that gets taller don't change
  // `messages`, so the end is also held on to whenever the stream or its viewport changes size
  useEffect(() => {
    const scroller = scrollRef.current;
    if (!scroller) return;
    const observer = new ResizeObserver(() => {
      if (followRef.current) scroller.scrollTop = scroller.scrollHeight;
      // a stream that shrank to fit fires no scroll, so whether it is at its end is asked again here
      else handleScroll();
    });
    observer.observe(scroller);
    if (scroller.firstElementChild) observer.observe(scroller.firstElementChild);
    return () => observer.disconnect();
  }, [hasConfiguredModels, showHistory]);

  const handleScroll = () => {
    const scroller = scrollRef.current;
    if (!scroller) return;
    const atEnd = scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 80;
    followRef.current = atEnd;
    setAwayFromEnd(!atEnd);
  };

  const jumpToEnd = () => {
    followRef.current = true;
    setAwayFromEnd(false);
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  };

  const chooseDetailed = (value: boolean) => {
    setDetailed(value);
    setMenuOpen(false);
    try {
      localStorage.setItem(DETAILED_VIEW_KEY, value ? '1' : '0');
    } catch {
      // the choice then lasts as long as the panel stays open
    }
  };

  // the menu closes on a click anywhere else, and on Escape
  useEffect(() => {
    if (!menuOpen) return;
    const close = (event: MouseEvent | KeyboardEvent) => {
      if (event instanceof KeyboardEvent ? event.key === 'Escape' : !menuRef.current?.contains(event.target as Node)) {
        setMenuOpen(false);
      }
    };
    document.addEventListener('mousedown', close);
    document.addEventListener('keydown', close);
    return () => {
      document.removeEventListener('mousedown', close);
      document.removeEventListener('keydown', close);
    };
  }, [menuOpen]);

  // what the model is looking at: the page it has just been shown, else the one its last step was decided on
  const modelView = useMemo(() => activity?.view ?? latestView(messages), [activity, messages]);

  let placeholder = t('chat_input_placeholder');
  if (pendingConfirmation !== null) placeholder = t('chat_input_placeholder_confirm');
  else if (awaitingReply) placeholder = t('chat_input_placeholder_reply');
  else if (showStopButton) placeholder = t('chat_input_placeholder_working');
  else if (messages.length > 0) placeholder = t('chat_input_placeholder_followUp');

  const chatInput = (
    <div className="nb-composer">
      {awayFromEnd && messages.length > 0 && (
        <button type="button" className="nb-jump" onClick={jumpToEnd}>
          <FiArrowDown aria-hidden />
          {t('chat_jumpToLatest')}
        </button>
      )}
      {(messages.length > 0 || showStopButton) && (
        <AgentDock
          messages={messages}
          running={showStopButton}
          activity={activity}
          queue={queue.map(goal => goal.display ?? goal.text)}
          queueHeld={queueHeld}
          onUnqueue={index => setQueue(prev => prev.filter((_, i) => i !== index))}
          onResumeQueue={() => setQueueHeld(false)}
          onPick={task => void handleSendMessage(task)}
        />
      )}
      {pendingConfirmation !== null && (
        <div role="alertdialog" aria-label={pendingConfirmation} className="nb-confirm">
          <p title={pendingConfirmation}>{pendingConfirmation}</p>
          <button type="button" onClick={() => handleConfirmAction(false)} className="nb-button">
            {t('chat_confirm_decline')}
          </button>
          <button type="button" onClick={() => handleConfirmAction(true)} className="nb-button primary">
            {t('chat_confirm_approve')}
          </button>
        </div>
      )}
      {awaitingReply && ask && (
        <AskCard
          ask={ask}
          captchas={askCaptchas}
          onReveal={field => portRef.current?.postMessage({ type: 'reveal_ask', field })}
          onCaptcha={(field, refresh) => {
            setAskCaptchas(prev => ({ ...prev, [field]: undefined }));
            portRef.current?.postMessage({ type: 'ask_captcha', field, refresh });
          }}
          onReply={(text, display) => void handleSendMessage(text, display)}
        />
      )}
      <ChatInput
        onSendMessage={handleSendMessage}
        onStopTask={handleStopTask}
        disabled={!inputEnabled}
        showStopButton={showStopButton}
        placeholder={placeholder}
        setContent={setter => {
          setInputTextRef.current = setter;
        }}
        historicalSessionId={isHistoricalSession && replayEnabled ? currentSessionId : null}
        onReplay={handleReplay}
        aside={modelView && messages.length > 0 && <ContextPeek view={modelView} live={showStopButton} />}
        onQueue={isReplaying ? undefined : handleQueue}
      />
    </div>
  );

  return (
    <div className="nb-panel relative flex h-screen flex-col overflow-hidden">
      {/* in a chat it floats over the stream's top edge, so the stream gets the panel's whole height */}
      <header className={`header${showHistory ? '' : ' floating'}`}>
        <div className="header-lead">
          {showHistory ? (
            <button
              type="button"
              onClick={() => handleBackToChat(false)}
              className="header-icon gap-1 text-[13px] font-medium"
              aria-label={t('nav_back_a11y')}>
              <FiChevronLeft size={16} />
              {t('chat_history_title')}
            </button>
          ) : (
            <>
              <img src="/icon-128.png" alt="" className="size-[18px] shrink-0" />
              <span className="header-title" title={sessionTitle ?? undefined}>
                {sessionTitle ?? 'Nanobrowser'}
              </span>
            </>
          )}
        </div>
        <div className="header-icons">
          {!showHistory && (
            <>
              <button
                type="button"
                onClick={handleNewChat}
                className="header-icon"
                aria-label={t('nav_newChat_a11y')}
                title={t('nav_newChat_a11y')}>
                <FiPlus size={16} />
              </button>
              <button
                type="button"
                onClick={handleLoadHistory}
                className="header-icon"
                aria-label={t('nav_loadHistory_a11y')}
                title={t('nav_loadHistory_a11y')}>
                <FiClock size={16} />
              </button>
            </>
          )}
          <WindowToggleButton sessionId={currentSessionId} />
          <div className="relative" ref={menuRef}>
            <button
              type="button"
              onClick={() => setMenuOpen(!menuOpen)}
              className="header-icon"
              aria-haspopup="menu"
              aria-expanded={menuOpen}
              aria-label={t('nav_more_a11y')}
              title={t('nav_more_a11y')}>
              <FiMoreHorizontal size={16} />
            </button>
            {menuOpen && (
              <div className="nb-menu" role="menu">
                <div className="nb-label px-2.5 pb-1 pt-1.5">{t('nav_view')}</div>
                <button
                  type="button"
                  role="menuitemradio"
                  aria-checked={!detailed}
                  onClick={() => chooseDetailed(false)}>
                  <span className="nb-menu-check">{!detailed && <FiCheck size={14} />}</span>
                  <span>
                    {t('nav_view_simple')}
                    <small>{t('nav_view_simple_hint')}</small>
                  </span>
                </button>
                <button type="button" role="menuitemradio" aria-checked={detailed} onClick={() => chooseDetailed(true)}>
                  <span className="nb-menu-check">{detailed && <FiCheck size={14} />}</span>
                  <span>
                    {t('nav_view_detailed')}
                    <small>{t('nav_view_detailed_hint')}</small>
                  </span>
                </button>
                <hr />
                <button
                  type="button"
                  role="menuitem"
                  onClick={() => {
                    setMenuOpen(false);
                    chrome.runtime.openOptionsPage();
                  }}>
                  <span className="nb-menu-check">
                    <FiSettings size={14} />
                  </span>
                  {t('nav_settings_a11y')}
                </button>
              </div>
            )}
          </div>
        </div>
      </header>
      {showHistory ? (
        <div className="flex-1 overflow-hidden">
          <div className="nb-col h-full">
            <ChatHistoryList
              sessions={chatSessions}
              onSessionSelect={handleSessionSelect}
              onSessionDelete={handleSessionDelete}
              onSessionBookmark={handleSessionBookmark}
              visible={true}
            />
          </div>
        </div>
      ) : (
        <>
          {/* Show loading state while checking model configuration */}
          {hasConfiguredModels === null && (
            <div className="flex flex-1 items-center justify-center gap-2 p-8 text-sm text-nb-muted">
              <div className="size-4 animate-spin rounded-full border-2 border-nb-track border-t-nb-llm" />
              <p>{t('status_checkingConfig')}</p>
            </div>
          )}

          {/* Show setup message when no models are configured */}
          {hasConfiguredModels === false && (
            <div className="nb-col flex flex-1 flex-col justify-center p-5">
              <div className="nb-welcome-hero">
                <img src="/icon-128.png" alt="" className="nb-welcome-logo" />
                <h1>{t('welcome_title')}</h1>
                <p>{t('welcome_instruction')}</p>
                <button
                  type="button"
                  onClick={() => chrome.runtime.openOptionsPage()}
                  className="nb-button primary mt-4">
                  <FiSettings aria-hidden />
                  {t('welcome_openSettings')}
                </button>
              </div>
              <div className="mt-6 flex gap-4 text-xs text-nb-muted">
                <a
                  href="https://github.com/nanobrowser/nanobrowser?tab=readme-ov-file#-quick-start"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="hover:text-nb-ink">
                  {t('welcome_quickStart')} ↗
                </a>
              </div>
            </div>
          )}

          {/* Show normal chat interface when models are configured */}
          {hasConfiguredModels === true && (
            <>
              <div
                ref={scrollRef}
                onScroll={handleScroll}
                className="scrollbar-gutter-stable flex-1 overflow-x-hidden overflow-y-scroll">
                <div className="nb-col flex min-h-full flex-col px-3 pb-3 pt-11">
                  {messages.length === 0 ? (
                    <Welcome onOpenSession={handleSessionSelect}>
                      {favoritePrompts.length > 0 && (
                        <BookmarkList
                          bookmarks={favoritePrompts}
                          onBookmarkSelect={handleBookmarkSelect}
                          onBookmarkUpdateTitle={handleBookmarkUpdateTitle}
                          onBookmarkDelete={handleBookmarkDelete}
                          onBookmarkReorder={handleBookmarkReorder}
                        />
                      )}
                    </Welcome>
                  ) : (
                    <>
                      <MessageList
                        messages={messages}
                        running={showStopButton}
                        activity={activity}
                        detailed={detailed}
                        onRetry={inputEnabled && !showStopButton ? handleSendMessage : undefined}
                      />
                      <div ref={messagesEndRef} />
                    </>
                  )}
                </div>
              </div>
              <div className="nb-col w-full">{chatInput}</div>
            </>
          )}
        </>
      )}
    </div>
  );
};

export default SidePanel;
