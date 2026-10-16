export type LogLevel = "debug" | "info" | "warn" | "error";

export type LogFields = Record<string, unknown>;

export interface Logger {
  debug(message: string, fields?: LogFields): void;
  info(message: string, fields?: LogFields): void;
  warn(message: string, fields?: LogFields): void;
  error(message: string, fields?: LogFields): void;
}

function defaultSink(line: string): void {
  process.stdout.write(`${line}\n`);
}

export function createLogger(
  sink: (line: string) => void = defaultSink,
  base: LogFields = {},
): Logger {
  const emit = (level: LogLevel, message: string, fields: LogFields = {}): void => {
    sink(JSON.stringify({ ts: new Date().toISOString(), level, message, ...base, ...fields }));
  };
  return {
    debug: (message, fields) => emit("debug", message, fields),
    info: (message, fields) => emit("info", message, fields),
    warn: (message, fields) => emit("warn", message, fields),
    error: (message, fields) => emit("error", message, fields),
  };
}
