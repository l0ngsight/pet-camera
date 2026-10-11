// Structured (JSON lines) logging. Never pass passwords, cookies or SDP bodies as fields.
export type Level = 'debug' | 'info' | 'warn' | 'error';
export type Logger = (level: Level, msg: string, fields?: Record<string, unknown>) => void;

export function createLogger(
  write: (line: string) => void = (line) => process.stdout.write(line + '\n'),
  clock: () => Date = () => new Date(),
): Logger {
  return (level, msg, fields) => {
    write(JSON.stringify({ ...fields, ts: clock().toISOString(), level, msg }));
  };
}
