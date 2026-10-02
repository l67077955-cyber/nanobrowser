/* eslint-disable @typescript-eslint/no-explicit-any */
import { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { RxDiscordLogo } from 'react-icons/rx';
import { FiSettings, FiPlus, FiClock, FiChevronLeft, FiMoreHorizontal, FiCheck, FiArrowDown } from 'react-icons/fi';
import {
  type Message,
  Actors,
  chatHistoryStore,
  agentModelStore,
  generalSettingsStore,
  remoteControlStore,
} from '@extension/storage';
import favoritesStorage, { type FavoritePrompt } from '@extension/storage/lib/prompt/favorites';
import { t } from '@extension/i18n';
import MessageList, { type Activity } from './components/MessageList';
import ContextPeek from './components/ModelView';
import Welcome from './components/Welcome';
import { latestView, withoutPageText } from './components/steps';
import ChatInput from './components/ChatInput';
import ChatHistoryList from './components/ChatHistoryList';
import BookmarkList from './components/BookmarkList';
import OpenInWindowButton from './components/OpenInWindowButton';
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
  // action text awaiting the user's approval (confirm sensitive clicks setting)
  const [pendingConfirmation, setPendingConfirmation] = useState<string | null>(null);
  // the agent asked something in the chat and waits for the reply
  const [awaitingReply, setAwaitingReply] = useState(false);
  const [currentSessionId, setCurrentSessionId] = useState<string | null>(null);
  const [showHistory, setShowHistory] = useState(false);
  const [chatSessions, setChatSessions] = useState<Array<{ id: string; title: string; createdAt: number }>>([]);
  const [isFollowUpMode, setIsFollowUpMode] = useState(false);
  const [isHistoricalSession, setIsHistoricalSession] = useState(false);
  const [favoritePrompts, setFavoritePrompts] = useState<FavoritePrompt[]>([]);
  const [hasConfiguredModels, setHasConfiguredModels] = useState<boolean | null>(null); // null = loading, false = no models, true = has models
  const [isRecording, setIsRecording] = useState(false);
  const [isProcessingSpeech, setIsProcessingSpeech] = useState(false);
  const [isReplaying, setIsReplaying] = useState(false);
  const [replayEnabled, setReplayEnabled] = useState(false);
  const sessionIdRef = useRef<string | null>(null);
  const isReplayingRef = useRef<boolean>(false);
  const portRef = useRef<chrome.runtime.Port | null>(null);
  const heartbeatIntervalRef = useRef<number | null>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const setInputTextRef = useRef<((text: string) => void) | null>(null);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const audioChunksRef = useRef<Blob[]>([]);
  const recordingTimerRef = useRef<number | null>(null);

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
              setActivity(null);
              setPendingConfirmation(null);
              setAwaitingReply(false);
              setIsFollowUpMode(true);
              setInputEnabled(true);
              setShowStopButton(false);
              setIsReplaying(false);
              break;
            case ExecutionState.TASK_FAIL:
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
          ...(state === ExecutionState.ACT_ASK ? { meta: { kind: 'question' as const } } : {}),
          ...(FAILURE_STATES.includes(state) ? { failed: true } : {}),
        });
      }
    },
    [appendMessage],
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
          handleTaskState(message);
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
        } else if (message && message.type === 'speech_to_text_result') {
          // Handle speech-to-text result
          if (message.text && setInputTextRef.current) {
            setInputTextRef.current(message.text);
          }
          setIsProcessingSpeech(false);
        } else if (message && message.type === 'speech_to_text_error') {
          // Handle speech-to-text error
          appendMessage({
            actor: Actors.SYSTEM,
            content: message.error || t('chat_stt_recognitionFailed'),
            timestamp: Date.now(),
          });
          setIsProcessingSpeech(false);
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
  }, [handleTaskState, appendMessage, stopConnection, showRemoteTask]);

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

  const handleConfirmAction = (approved: boolean) => {
    portRef.current?.postMessage({ type: 'confirm_action', approved });
    setPendingConfirmation(null);
  };

  const handleStopTask = async () => {
    try {
      portRef.current?.postMessage({
        type: 'cancel_task',
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

  // With remote control on, an open side panel listens from the start: a task an agent starts shows up here,
  // and its sensitive actions can be approved
  useEffect(() => {
    remoteControlStore
      .getConfig()
      .then(config => {
        if (config.enabled) setupConnection();
      })
      .catch(err => console.error('Failed to read the remote control settings:', err));
  }, [setupConnection]);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      // Stop recording if active
      if (mediaRecorderRef.current && mediaRecorderRef.current.state === 'recording') {
        mediaRecorderRef.current.stop();
      }
      // Clear recording timer
      if (recordingTimerRef.current) {
        clearTimeout(recordingTimerRef.current);
        recordingTimerRef.current = null;
      }
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

  const handleMicClick = async () => {
    if (isRecording) {
      // Stop recording
      if (mediaRecorderRef.current && mediaRecorderRef.current.state === 'recording') {
        mediaRecorderRef.current.stop();
      }
      // Clear the timer
      if (recordingTimerRef.current) {
        clearTimeout(recordingTimerRef.current);
        recordingTimerRef.current = null;
      }
      setIsRecording(false);
      return;
    }

    try {
      // First check if permission is already granted
      const permissionStatus = await navigator.permissions.query({ name: 'microphone' as PermissionName });

      if (permissionStatus.state === 'denied') {
        appendMessage({
          actor: Actors.SYSTEM,
          content: t('chat_stt_microphone_permissionDenied'),
          timestamp: Date.now(),
        });
        return;
      }

      // If permission is not granted, open permission page
      if (permissionStatus.state !== 'granted') {
        const permissionUrl = chrome.runtime.getURL('permission/index.html');

        // Open permission page in a new window
        chrome.windows.create(
          {
            url: permissionUrl,
            type: 'popup',
            width: 500,
            height: 600,
          },
          createdWindow => {
            if (createdWindow?.id) {
              // Listen for window close to check permission status
              chrome.windows.onRemoved.addListener(function onWindowClose(windowId) {
                if (windowId === createdWindow.id) {
                  chrome.windows.onRemoved.removeListener(onWindowClose);
                  // Check permission status after window closes
                  setTimeout(async () => {
                    try {
                      const newPermissionStatus = await navigator.permissions.query({
                        name: 'microphone' as PermissionName,
                      });
                      // Only retry if permission was granted
                      if (newPermissionStatus.state === 'granted') {
                        handleMicClick();
                      }
                      // If denied or prompt, do nothing - let user manually try again
                    } catch (error) {
                      console.error('Failed to check permission status:', error);
                    }
                  }, 500);
                }
              });
            }
          },
        );
        return;
      }

      // Permission granted - proceed with recording
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });

      // Clear previous audio chunks
      audioChunksRef.current = [];

      // Create MediaRecorder
      const mediaRecorder = new MediaRecorder(stream);
      mediaRecorderRef.current = mediaRecorder;

      // Handle data available event
      mediaRecorder.ondataavailable = event => {
        if (event.data.size > 0) {
          audioChunksRef.current.push(event.data);
        }
      };

      // Handle stop event
      mediaRecorder.onstop = async () => {
        // Stop all tracks to release microphone
        stream.getTracks().forEach(track => track.stop());

        if (audioChunksRef.current.length > 0) {
          // Create audio blob
          const audioBlob = new Blob(audioChunksRef.current, { type: 'audio/webm' });

          // Convert blob to base64
          const reader = new FileReader();
          reader.onloadend = () => {
            const base64Audio = reader.result as string;

            // Setup connection if not exists
            if (!portRef.current) {
              setupConnection();
            }

            // Send audio to backend for speech-to-text conversion
            try {
              setIsProcessingSpeech(true);
              portRef.current?.postMessage({
                type: 'speech_to_text',
                audio: base64Audio,
              });
            } catch (error) {
              console.error('Failed to send audio for speech-to-text:', error);
              appendMessage({
                actor: Actors.SYSTEM,
                content: t('chat_stt_processingFailed'),
                timestamp: Date.now(),
              });
              setIsRecording(false);
              setIsProcessingSpeech(false);
            }
          };
          reader.readAsDataURL(audioBlob);
        }
      };

      // Set up 2-minute duration limit
      const maxDuration = 2 * 60 * 1000;
      recordingTimerRef.current = window.setTimeout(() => {
        if (mediaRecorderRef.current && mediaRecorderRef.current.state === 'recording') {
          mediaRecorderRef.current.stop();
        }
        setIsRecording(false);
        setIsProcessingSpeech(true);
        recordingTimerRef.current = null;
      }, maxDuration);

      // Start recording
      mediaRecorder.start();
      setIsRecording(true);
    } catch (error) {
      console.error('Error accessing microphone:', error);

      let errorMessage = t('chat_stt_microphone_accessFailed');
      if (error instanceof Error) {
        if (error.name === 'NotAllowedError') {
          errorMessage += t('chat_stt_microphone_grantPermission');
        } else if (error.name === 'NotFoundError') {
          errorMessage += t('chat_stt_microphone_notFound');
        } else {
          errorMessage += error.message;
        }
      }

      appendMessage({
        actor: Actors.SYSTEM,
        content: errorMessage,
        timestamp: Date.now(),
      });
      setIsRecording(false);
    }
  };

  let placeholder = t('chat_input_placeholder');
  if (awaitingReply) placeholder = t('chat_input_placeholder_reply');
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
      {pendingConfirmation !== null && (
        <div role="alertdialog" aria-label={pendingConfirmation} className="nb-confirm">
          <div className="nb-confirm-title">{t('chat_confirm_title')}</div>
          <p>{pendingConfirmation}</p>
          <div className="nb-confirm-actions">
            <button type="button" onClick={() => handleConfirmAction(false)} className="nb-button">
              {t('chat_confirm_decline')}
            </button>
            <button type="button" onClick={() => handleConfirmAction(true)} className="nb-button primary warn">
              {t('chat_confirm_approve')}
            </button>
          </div>
        </div>
      )}
      <ChatInput
        onSendMessage={handleSendMessage}
        onStopTask={handleStopTask}
        onMicClick={handleMicClick}
        isRecording={isRecording}
        isProcessingSpeech={isProcessingSpeech}
        disabled={!inputEnabled}
        showStopButton={showStopButton}
        placeholder={placeholder}
        setContent={setter => {
          setInputTextRef.current = setter;
        }}
        historicalSessionId={isHistoricalSession && replayEnabled ? currentSessionId : null}
        onReplay={handleReplay}
        aside={modelView && messages.length > 0 && <ContextPeek view={modelView} live={showStopButton} />}
      />
    </div>
  );

  return (
    <div className="nb-panel flex h-screen flex-col overflow-hidden">
      <header className="header">
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
                {/* closing the side panel ends a running task, so not while one runs */}
                {!showStopButton && <OpenInWindowButton />}
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
                <a href="https://discord.gg/NN3ABHggMK" target="_blank" rel="noopener noreferrer" role="menuitem">
                  <span className="nb-menu-check">
                    <RxDiscordLogo size={14} />
                  </span>
                  Discord
                </a>
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
                <a
                  href="https://discord.gg/NN3ABHggMK"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="hover:text-nb-ink">
                  {t('welcome_joinCommunity')} ↗
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
                <div className="nb-col flex min-h-full flex-col px-3 py-3">
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
