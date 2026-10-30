import { closeSync, mkdirSync, openSync, readdirSync, rmSync, writeSync } from 'node:fs';
import path from 'node:path';
import { safeLine } from '../terminal-text.ts';

/** How much a logger records, from `error` only to everything with `debug`. */
export type LogLevel = 'error' | 'warn' | 'info' | 'debug';

const RANK: Readonly<Record<LogLevel, number>> = { error: 0, warn: 1, info: 2, debug: 3 };

/** One log entry, already redacted. File contents are never logged. */
export interface LogRecord {
  /** When it was recorded, as an ISO 8601 time in UTC. */
  readonly time: string;
  readonly level: LogLevel;
  readonly message: string;
  /** Structured details, such as `siteId` or `code`. */
  readonly fields?: Readonly<Record<string, unknown>>;
}

/** Where log records go: memory, a stream, or a run log file. */
export interface LogSink {
  /** Takes one redacted record. */
  write(record: LogRecord): void;
  /** Releases the sink's file or stream. */
  close?(): void;
}

/** Records messages at four levels, redacting every secret first. */
export interface Logger {
  /** A failure the run reports. */
  error(message: string, fields?: Record<string, unknown>): void;
  /** Something the person should know, such as an insecure protocol in use. */
  warn(message: string, fields?: Record<string, unknown>): void;
  /** What the run did. */
  info(message: string, fields?: Record<string, unknown>): void;
  /** Protocol traces and details for troubleshooting. */
  debug(message: string, fields?: Record<string, unknown>): void;
  /** Scrubs every record; register secrets with it as soon as they are known. */
  readonly redactor: Redactor;
  /** Closes every sink. */
  close(): void;
}

/** What a secret is replaced with in logs and messages. */
export const REDACTED = '[redacted]';

/** Field names whose string values are always replaced. */
const SENSITIVE_KEY = /pass(?:word|phrase)?$|secret|token|credential|private_?key|authorization/i;

/**
 * Removes secrets from log text and fields: every registered secret value,
 * the argument of an FTP `PASS` command, the password in URL user info, and
 * password-like query parameters.
 */
export class Redactor {
  readonly #secrets = new Set<string>();

  /** Registers a secret, such as a password just read, so no later text shows it. */
  addSecret(value: string): void {
    if (value !== '') {
      this.#secrets.add(value);
    }
  }

  /** Forgets a secret that is no longer in use. */
  removeSecret(value: string): void {
    this.#secrets.delete(value);
  }

  /** `text` with every registered secret and every recognized password form replaced. */
  redact(text: string): string {
    let result = text;
    // Longest first, so a secret that contains another is replaced whole.
    for (const secret of [...this.#secrets].sort((a, b) => b.length - a.length)) {
      result = result.replaceAll(secret, REDACTED);
    }
    return result
      .replace(/\bPASS +\S+/g, `PASS ${REDACTED}`)
      .replace(/\b([a-z][a-z0-9+.-]*:\/\/[^\s/:@]*):[^\s/@]*@/gi, `$1:${REDACTED}@`)
      .replace(/([?&](?:password|passwd|pass|pwd|token|secret)=)[^&\s#]+/gi, `$1${REDACTED}`);
  }

  /** A copy of `value` with strings redacted and fields named like secrets replaced, up to eight levels deep. */
  redactValue(value: unknown, depth = 0): unknown {
    if (typeof value === 'string') {
      return this.redact(value);
    }
    if (depth > 8 || value === null || typeof value !== 'object') {
      return value;
    }
    if (value instanceof Error) {
      const code = (value as { code?: unknown }).code;
      return { name: value.name, message: this.redact(value.message), ...(typeof code === 'string' ? { code } : {}) };
    }
    if (Array.isArray(value)) {
      return value.map((item) => this.redactValue(item, depth + 1));
    }
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [
        key,
        typeof item === 'string' && SENSITIVE_KEY.test(key) ? REDACTED : this.redactValue(item, depth + 1),
      ]),
    );
  }
}

/** Options of {@link createLogger}. */
export interface LoggerOptions {
  /** The most detailed level recorded. Default `info`. */
  readonly level?: LogLevel;
  /** Where records go. With none, nothing is recorded. */
  readonly sinks?: readonly LogSink[];
  /** A redactor to share with other loggers, so a secret registered once is removed everywhere. */
  readonly redactor?: Redactor;
}

/** A logger that redacts each record and passes it to its sinks. */
export function createLogger(options: LoggerOptions = {}): Logger {
  const threshold = RANK[options.level ?? 'info'];
  const sinks = options.sinks ?? [];
  const redactor = options.redactor ?? new Redactor();

  const log = (level: LogLevel, message: string, fields?: Record<string, unknown>): void => {
    if (RANK[level] > threshold || sinks.length === 0) {
      return;
    }
    const record: LogRecord = {
      time: new Date().toISOString(),
      level,
      message: redactor.redact(message),
      ...(fields === undefined ? {} : { fields: redactor.redactValue(fields) as Record<string, unknown> }),
    };
    for (const sink of sinks) {
      sink.write(record);
    }
  };

  return {
    error: (message, fields) => {
      log('error', message, fields);
    },
    warn: (message, fields) => {
      log('warn', message, fields);
    },
    info: (message, fields) => {
      log('info', message, fields);
    },
    debug: (message, fields) => {
      log('debug', message, fields);
    },
    redactor,
    close: () => {
      for (const sink of sinks) {
        sink.close?.();
      }
    },
  };
}

/** A logger that records nothing. */
export const silentLogger: Logger = createLogger();

/** Keeps records in memory; for tests and for showing recent records. */
export function memorySink(): LogSink & { readonly records: LogRecord[] } {
  const records: LogRecord[] = [];
  return {
    records,
    write: (record) => {
      records.push(record);
    },
  };
}

/**
 * Writes records as text lines, such as `warn: message {"key":"value"}`, to a
 * stream like stderr. Control characters are escaped, since protocol traces
 * carry a server's own text.
 */
export function textSink(stream: { write(text: string): unknown }): LogSink {
  return {
    write: (record) => {
      const fields = record.fields === undefined ? '' : ` ${JSON.stringify(record.fields)}`;
      stream.write(`${safeLine(`${record.level}: ${record.message}${fields}`)}\n`);
    },
  };
}

function timestamp(date: Date): string {
  return date.toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15);
}

/**
 * Writes one JSONL file per run into `logDir`, created on the first record,
 * private to the user (`0600`), keeping the newest `keep` run files.
 */
export function runLogSink(logDir: string, options: { keep?: number; now?: Date } = {}): LogSink & { readonly file: string } {
  const keep = options.keep ?? 30;
  const file = path.join(logDir, `run-${timestamp(options.now ?? new Date())}-${String(process.pid)}.jsonl`);
  let fd: number | undefined;

  const openFile = (): number => {
    mkdirSync(logDir, { recursive: true, mode: 0o700 });
    const runs = readdirSync(logDir)
      .filter((name) => /^run-.*\.jsonl$/.test(name))
      .sort();
    for (const old of runs.slice(0, Math.max(0, runs.length - keep + 1))) {
      rmSync(path.join(logDir, old), { force: true });
    }
    return openSync(file, 'a', 0o600);
  };

  return {
    file,
    write: (record) => {
      fd ??= openFile();
      writeSync(fd, `${JSON.stringify(record)}\n`);
    },
    close: () => {
      if (fd !== undefined) {
        closeSync(fd);
        fd = undefined;
      }
    },
  };
}
