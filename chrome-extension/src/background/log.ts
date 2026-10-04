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

const createLogger = (namespace: string): Logger => {
  const prefix = `[${namespace}]`;

  // Bind console methods directly to preserve call stack and show correct line numbers
  const boundDebug = console.debug.bind(console, prefix);
  const boundInfo = console.info.bind(console, prefix);
  const boundWarn = console.warn.bind(console, prefix);
  const boundError = console.error.bind(console, prefix);
  const boundGroup = console.group.bind(console);
  const boundGroupEnd = console.groupEnd.bind(console);

  return {
    debug: import.meta.env.DEV ? boundDebug : () => {},
    info: boundInfo,
    warning: boundWarn,
    error: boundError,
    group: (label: string) => boundGroup(`${prefix} ${label}`),
    groupEnd: boundGroupEnd,
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
export { createLogger, describeError, logger };
