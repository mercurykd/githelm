import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export interface ProcessResult {
  code: number;
  stdout: string;
  stderr: string;
}

export interface ProcessOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  input?: string;
  timeoutMs?: number;
  /** Streamed stderr, pipe mode only (file mode has no live stream). */
  onStderr?: (chunk: string) => void;
}

const DEFAULT_TIMEOUT_MS = 120_000;

type Capture = 'pipe' | 'file';

/**
 * Runs a child process and captures stdout/stderr.
 *
 * If the platform refuses to create pipes between processes (hardened Windows
 * setups answer `spawn EPERM`), the same command is retried with file-backed
 * stdio so the extension keeps working instead of failing obscurely.
 */
export function runProcess(command: string, args: string[], opts: ProcessOptions = {}): Promise<ProcessResult> {
  return runOnce(command, args, opts, 'pipe').catch((error: unknown) => {
    if ((error as NodeJS.ErrnoException | undefined)?.code === 'EPERM') {
      return runOnce(command, args, opts, 'file');
    }
    throw error;
  });
}

function runOnce(command: string, args: string[], opts: ProcessOptions, capture: Capture): Promise<ProcessResult> {
  return new Promise((resolve, reject) => {
    let tmpDir: string | undefined;
    let outFd: number | undefined;
    let errFd: number | undefined;
    let inFd: number | undefined;

    if (capture === 'file') {
      tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'githelm-stdio-'));
      outFd = fs.openSync(path.join(tmpDir, 'stdout'), 'w');
      errFd = fs.openSync(path.join(tmpDir, 'stderr'), 'w');
      if (opts.input !== undefined) {
        const inputPath = path.join(tmpDir, 'stdin');
        fs.writeFileSync(inputPath, opts.input, 'utf8');
        inFd = fs.openSync(inputPath, 'r');
      }
    }

    const child = spawn(command, args, {
      ...(opts.cwd ? { cwd: opts.cwd } : {}),
      ...(opts.env ? { env: opts.env } : {}),
      windowsHide: true,
      ...(capture === 'file' ? { stdio: [inFd ?? 'ignore', outFd!, errFd!] as const } : {}),
    });

    let stdout = '';
    let stderr = '';
    let settled = false;

    const cleanup = (): ProcessResult => {
      if (capture === 'file' && tmpDir) {
        for (const fd of [outFd, errFd, inFd]) {
          if (fd !== undefined) {
            fs.closeSync(fd);
          }
        }
        const outPath = path.join(tmpDir, 'stdout');
        const errPath = path.join(tmpDir, 'stderr');
        const out = fs.existsSync(outPath) ? fs.readFileSync(outPath, 'utf8') : '';
        const err = fs.existsSync(errPath) ? fs.readFileSync(errPath, 'utf8') : '';
        fs.rmSync(tmpDir, { recursive: true, force: true });
        return { code: -1, stdout: out, stderr: err };
      }
      return { code: -1, stdout, stderr };
    };

    const finish = (fn: () => void): void => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      fn();
    };

    const timer = setTimeout(
      () => {
        child.kill();
        finish(() => {
          cleanup();
          reject(new Error(`${command} ${args.join(' ')} timed out after ${opts.timeoutMs ?? DEFAULT_TIMEOUT_MS}ms`));
        });
      },
      opts.timeoutMs ?? DEFAULT_TIMEOUT_MS
    );

    const stdinStream = child.stdin;
    const stdoutStream = child.stdout;
    const stderrStream = child.stderr;
    if (capture === 'pipe' && stdinStream !== null && stdoutStream !== null && stderrStream !== null) {
      stdoutStream.setEncoding('utf8');
      stderrStream.setEncoding('utf8');
      stdoutStream.on('data', (chunk: string) => (stdout += chunk));
      stderrStream.on('data', (chunk: string) => {
        stderr += chunk;
        opts.onStderr?.(chunk);
      });
      stdinStream.on('error', () => {
        /* the child may exit before consuming stdin; the exit code tells the story */
      });
      if (opts.input !== undefined) {
        stdinStream.end(opts.input, 'utf8');
      } else {
        stdinStream.end();
      }
    }

    child.on('error', (error) => {
      finish(() => {
        cleanup();
        reject(error);
      });
    });

    child.on('close', (code) => {
      finish(() => {
        const captured = cleanup();
        resolve({ code: code ?? -1, stdout: captured.stdout, stderr: captured.stderr });
      });
    });
  });
}
