/** Minimal prefixed logger; optionally mirrors lines to a file. */

import { appendFileSync } from "node:fs";

const PREFIX = "[token-guard]";

export interface Logger {
  info(message: string, data?: unknown): void;
  warn(message: string, data?: unknown): void;
  debug(message: string, data?: unknown): void;
}

function stringify(data: unknown): string {
  if (typeof data === "string") return data;
  try {
    return JSON.stringify(data) ?? String(data);
  } catch {
    return String(data);
  }
}

export function createLogger(enabled: boolean, logFile?: string): Logger {
  const emit = (level: string, message: string, data?: unknown) => {
    const line = data === undefined ? `${PREFIX} ${level} ${message}` : `${PREFIX} ${level} ${message} ${stringify(data)}`;
    console.log(line);
    if (logFile !== undefined) {
      try {
        appendFileSync(logFile, `${new Date().toISOString()} ${line}\n`);
      } catch {
        /* file unavailable — do not disrupt the plugin */
      }
    }
  };
  return {
    info: (m, d) => emit("INFO", m, d),
    warn: (m, d) => emit("WARN", m, d),
    debug: (m, d) => {
      if (enabled) emit("DEBUG", m, d);
    },
  };
}
