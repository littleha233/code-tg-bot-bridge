type LogLevel = "INFO" | "WARN" | "ERROR" | "DEBUG";

const SECRET_KEY_PATTERN = /(token|secret|api.?key|authorization)/i;

function sanitizeValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => sanitizeValue(item));
  }

  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, nestedValue]) => [
        key,
        SECRET_KEY_PATTERN.test(key) ? "[REDACTED]" : sanitizeValue(nestedValue),
      ]),
    );
  }

  return value;
}

function writeLog(level: LogLevel, scope: string, message: string, meta?: unknown): void {
  const timestamp = new Date().toISOString();
  const payload = meta === undefined ? "" : ` ${JSON.stringify(sanitizeValue(meta))}`;
  console.log(`[${timestamp}] [${level}] [${scope}] ${message}${payload}`);
}

export function createLogger(scope: string) {
  return {
    info(message: string, meta?: unknown) {
      writeLog("INFO", scope, message, meta);
    },
    warn(message: string, meta?: unknown) {
      writeLog("WARN", scope, message, meta);
    },
    error(message: string, meta?: unknown) {
      writeLog("ERROR", scope, message, meta);
    },
    debug(message: string, meta?: unknown) {
      writeLog("DEBUG", scope, message, meta);
    },
  };
}
