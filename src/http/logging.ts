export interface LogEntry {
  level: "info" | "error";
  requestId: string;
  operation: string;
  durationMs: number;
  statusCode: number;
  errorCategory?: string;
  errorName?: string;
  cancellationCodes?: string[];
}

export function writeLog(entry: LogEntry): void {
  const line = JSON.stringify(entry);
  if (entry.level === "error") {
    console.error(line);
    return;
  }
  console.log(line);
}
