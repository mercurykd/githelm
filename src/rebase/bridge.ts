import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import { createServer, IncomingMessage, Server, ServerResponse } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { ProcessResult, runProcess } from '../util/process';

export interface EditRequest {
  /** Path of the file git asked us to edit (`git-rebase-todo`, `COMMIT_EDITMSG`, …). */
  path: string;
  content: string;
}

export type EditHandler = (request: EditRequest) => Promise<string | undefined>;

export interface EditorBridgeOptions {
  onEdit: EditHandler;
  /** Directory containing `git-editor.sh` and `git-editor-main.js`. */
  shimsDir: string;
  /** Node (or Electron-as-node) binary that runs the shim. */
  nodePath?: string;
}

export interface BridgeSession {
  /** Environment variables git needs so its editor calls land in this bridge. */
  env: NodeJS.ProcessEnv;
  aborted(): boolean;
  dispose(): void;
}

export interface RebaseBridgeOptions extends EditorBridgeOptions {
  repoPath: string;
  base: string;
  /** Extra `git rebase` flags, e.g. `--autosquash`. */
  extraArgs?: string[];
  timeoutMs?: number;
}

export class RebaseAbortedError extends Error {
  constructor(message = 'Rebase отменён.') {
    super(message);
    this.name = 'RebaseAbortedError';
  }
}

function toPosixPath(value: string): string {
  return value.replace(/\\/g, '/');
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let body = '';
    req.setEncoding('utf8');
    req.on('data', (chunk: string) => (body += chunk));
    req.on('end', () => resolve(body));
    req.on('error', reject);
  });
}

/**
 * Starts a one-shot HTTP bridge plus a temp copy of the editor shim.
 *
 * git → `GIT_SEQUENCE_EDITOR` (shim) → node shim → HTTP POST here → `onEdit`
 * → response → shim rewrites the file → git continues. The same mechanism is
 * used by the built-in git extension (`git-editor.sh` / `git-editor-main.js`).
 */
export async function startEditorBridge(options: EditorBridgeOptions): Promise<BridgeSession> {
  const token = randomBytes(16).toString('hex');
  const state = { aborted: false };

  const server: Server = createServer((req, res) => {
    void handleRequest(req, res, token, options.onEdit, state).catch(() => {
      /* the response was already ended */
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });

  const address = server.address();
  if (typeof address !== 'object' || address === null) {
    server.close();
    throw new Error('Не удалось открыть локальный порт для моста редактора.');
  }

  const shimDir = fs.mkdtempSync(path.join(os.tmpdir(), 'githelm-rebase-'));
  const shimPath = path.join(shimDir, 'edit.sh');
  fs.writeFileSync(shimPath, fs.readFileSync(path.join(options.shimsDir, 'git-editor.sh'), 'utf8'), { mode: 0o755 });

  const env: NodeJS.ProcessEnv = {
    ...process.env,
    GIT_TERMINAL_PROMPT: '0',
    GIT_SEQUENCE_EDITOR: toPosixPath(shimPath),
    GIT_EDITOR: toPosixPath(shimPath),
    GITHELM_NODE: toPosixPath(options.nodePath ?? process.execPath),
    GITHELM_SHIM: toPosixPath(path.join(options.shimsDir, 'git-editor-main.js')),
    GITHELM_URL: `http://127.0.0.1:${address.port}`,
    GITHELM_TOKEN: token,
    ELECTRON_RUN_AS_NODE: '1',
  };

  return {
    env,
    aborted: () => state.aborted,
    dispose: () => {
      server.closeAllConnections?.();
      server.close();
      fs.rmSync(shimDir, { recursive: true, force: true });
    },
  };
}

/** Runs `git rebase -i` and lets the caller edit the todo list / commit messages. */
export async function runInteractiveRebase(options: RebaseBridgeOptions): Promise<ProcessResult> {
  const session = await startEditorBridge({
    onEdit: options.onEdit,
    shimsDir: options.shimsDir,
    ...(options.nodePath !== undefined ? { nodePath: options.nodePath } : {}),
  });

  try {
    const result = await runProcess('git', ['rebase', '-i', ...(options.extraArgs ?? []), options.base], {
      cwd: options.repoPath,
      env: session.env,
      timeoutMs: options.timeoutMs ?? 15 * 60_000,
    });

    if (session.aborted()) {
      await runProcess('git', ['rebase', '--abort'], { cwd: options.repoPath }).catch(() => undefined);
      throw new RebaseAbortedError();
    }
    return result;
  } finally {
    session.dispose();
  }
}

async function handleRequest(
  req: IncomingMessage,
  res: ServerResponse,
  token: string,
  onEdit: EditHandler,
  state: { aborted: boolean }
): Promise<void> {
  if (req.method !== 'POST' || req.url !== '/edit') {
    res.writeHead(404).end();
    return;
  }

  let payload: { token?: string; path?: string; content?: string };
  try {
    payload = JSON.parse(await readBody(req)) as typeof payload;
  } catch {
    res.writeHead(400).end();
    return;
  }
  if (payload.token !== token || typeof payload.path !== 'string' || typeof payload.content !== 'string') {
    res.writeHead(403).end();
    return;
  }

  let edited: string | undefined;
  try {
    edited = await onEdit({ path: payload.path, content: payload.content });
  } catch (error) {
    res.writeHead(500, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: String(error) }));
    return;
  }

  if (edited === undefined) {
    state.aborted = true;
    res.writeHead(409).end();
    return;
  }

  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ content: edited }));
}
