/**
 * Where a message goes. The editor supplies the windows, the tests supply a
 * recorder: the policy — what is a confirmation, what is a refusal, what is a
 * failure — is then readable in one place and can be checked without an
 * extension host.
 */
export interface MessageHost {
  /** Transient message in the status bar. */
  status(message: string, ttlMs: number): void;
  /** Notification that stays until it is dismissed or times out. */
  popup(message: string): void;
}

export interface Reporter {
  /** A confirmation or a hint: the status bar, four seconds, nothing else. */
  info(message: string): void;
  /** An action that did not happen although the request was understood. */
  refuse(message: string): void;
  /**
   * A failure: the log keeps the message and the stack, the status bar shows a
   * short error, and the popup stops the eye — a failure the user asked for
   * must not be a line that fades after twelve seconds.
   */
  fail(error: unknown, log: (line: string) => void, status: (message: string) => void): void;
}

const STATUS_TTL_MS = 4000;

export function createReporter(host: MessageHost, format: (error: unknown) => string): Reporter {
  return {
    info(message: string): void {
      host.status(message, STATUS_TTL_MS);
    },
    refuse(message: string): void {
      // The action was refused, so it is worth a window: the status bar alone is
      // easy to miss while the eye is on the buffer.
      host.status(message, STATUS_TTL_MS);
      host.popup(message);
    },
    fail(error: unknown, log: (line: string) => void, status: (message: string) => void): void {
      const message = format(error);
      log(`[error] ${message}`);
      if (error instanceof Error && error.stack) {
        log(error.stack);
      }
      status(message);
      host.popup(message);
    },
  };
}
