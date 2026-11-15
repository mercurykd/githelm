export interface ProgressUpdate {
  text: string;
  percent?: number;
}

const NOISE = /^(remote: )?(enumerating objects|counting objects|compressing objects)/i;

/**
 * Turns a `git --progress` line into a short status-bar update.
 * Lines look like `Receiving objects:  45% (141/312), 1.2 MiB | 800 KiB/s`.
 */
export function parseProgressLine(raw: string): ProgressUpdate | undefined {
  const line = raw.replace(/\r/g, '').trim();
  if (!line) {
    return undefined;
  }
  // Server-side phases arrive as `remote: Counting objects: …`; they are noise
  // for a compact status bar and always precede the real object transfer.
  if (line.startsWith('remote:') || NOISE.test(line) || line.startsWith('From ')) {
    return undefined;
  }
  const match = /^(.+?):\s+(\d+)%/.exec(line);
  if (match) {
    return { text: match[1].trim(), percent: Number.parseInt(match[2], 10) };
  }
  return { text: line.slice(0, 60) };
}

/**
 * `git` separates progress updates with `\r`, not `\n`, so a chunk splitter is
 * needed before lines mean anything.
 */
export function createLineSplitter(onLine: (line: string) => void): (chunk: string) => void {
  let buffer = '';
  return (chunk: string): void => {
    buffer += chunk;
    let index = buffer.search(/[\r\n]/);
    while (index >= 0) {
      const line = buffer.slice(0, index);
      buffer = buffer.slice(index + 1);
      if (line.trim()) {
        onLine(line);
      }
      index = buffer.search(/[\r\n]/);
    }
  };
}
