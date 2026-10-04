/// <reference types="vite/client" />

type LogLevel = 'debug' | 'info' | 'warning' | 'error';

interface Logger {
  debug: (...args: unknown[]) => void;
  info: (...args: unknown[]) => void;
  warning: (...args: unknown[]) => void;
  error: (...args: unknown[]) => void;
  group: (label: string) => void;
  groupEnd: () => void;
}

const MAX_LOGGED_OBJECT = 3000;

/**
 * Objects as JSON text: Chrome shows an object as a collapsed "Object", and a log copied out of the console
 * then loses what was in it. Errors and strings stay as they are.
 */
const flatten = (arg: unknown): unknown => {
  if (arg === null || typeof arg !== 'object' || arg instanceof Error) return arg;
  try {
    const text = JSON.stringify(arg);
    if (text === undefined) return arg;
    return text.length > MAX_LOGGED_OBJECT ? `${text.slice(0, MAX_LOGGED_OBJECT)}…` : text;
  } catch {
    return arg;
  }
};

/** A mainland China mobile number on its own, not inside a longer run of digits (a timestamp, an id) */
const PHONE_NUMBER = /(?<!\d)(1[3-9]\d)\d{4}(\d{4})(?!\d)/g;

/**
 * The user's phone number shown as 135****0144: logs get copied out and pasted into chats and issues.
 * An image data URL is left whole, so that it still opens.
 */
const maskPhoneNumbers = (arg: unknown): unknown =>
  typeof arg === 'string' && !arg.startsWith('data:') ? arg.replace(PHONE_NUMBER, '$1****$2') : arg;

const createLogger = (namespace: string): Logger => {
  const prefix = `[${namespace}]`;
  const write =
    (method: (...args: unknown[]) => void) =>
    (...args: unknown[]) =>
      method(prefix, ...args.map(arg => maskPhoneNumbers(flatten(arg))));

  return {
    debug: import.meta.env.DEV ? write(console.debug) : () => {},
    info: write(console.info),
    warning: write(console.warn),
    error: write(console.error),
    group: (label: string) => console.group(`${prefix} ${label}`),
    groupEnd: () => console.groupEnd(),
  };
};

/**
 * One line for an error with what usually tells its cause: the type, an HTTP status or error code, the message,
 * the provider's own message and what caused it
 */
const describeError = (error: unknown): string => {
  if (!(error instanceof Error)) return String(error).slice(0, 600);
  const detail = error as Error & {
    status?: number;
    code?: string;
    lc_error_code?: string;
    error?: { message?: string; code?: string | number; metadata?: unknown };
    cause?: unknown;
  };
  const parts = [detail.name];
  if (detail.status) parts.push(`HTTP ${detail.status}`);
  if (detail.code || detail.lc_error_code) parts.push(`code ${detail.code ?? detail.lc_error_code}`);
  parts.push(detail.message);
  const providerMessage = detail.error?.message;
  if (providerMessage && !detail.message.includes(providerMessage)) parts.push(`provider: ${providerMessage}`);
  if (detail.error?.metadata) parts.push(`metadata: ${JSON.stringify(detail.error.metadata).slice(0, 300)}`);
  if (detail.cause) parts.push(`cause: ${detail.cause instanceof Error ? detail.cause.message : String(detail.cause)}`);
  return parts.join(' · ').slice(0, 1000);
};

// Create default logger
const logger = createLogger('Agent');

export type { Logger, LogLevel };
export { createLogger, describeError, logger, maskPhoneNumbers };
