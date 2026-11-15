import { ProcessResult, runProcess } from '../util/process';
import { recordAction } from './actionLog';

export interface GitResult extends ProcessResult {
  args: string[];
}

export interface GitOptions {
  input?: string;
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
  onStderr?: (chunk: string) => void;
}

/**
 * Runs `git` in `repoPath`. Never throws on a non-zero exit code — callers decide.
 * Throws only when the process could not be started or timed out.
 */
export async function git(repoPath: string, args: string[], opts: GitOptions = {}): Promise<GitResult> {
  const started = Date.now();
  try {
    const result = await runProcess('git', args, {
    cwd: repoPath,
    env: {
      ...process.env,
      GIT_TERMINAL_PROMPT: '0',
      GIT_PAGER: 'cat',
      GIT_OPTIONAL_LOCKS: '0',
      ...opts.env,
    },
    ...(opts.input !== undefined ? { input: opts.input } : {}),
      ...(opts.timeoutMs !== undefined ? { timeoutMs: opts.timeoutMs } : {}),
      ...(opts.onStderr ? { onStderr: opts.onStderr } : {}),
    });
    recordAction({
      at: started,
      args,
      code: result.code,
      ms: Date.now() - started,
      ...(result.code !== 0 ? { error: result.stderr.trim() || result.stdout.trim() } : {}),
    });
    return { ...result, args };
  } catch (error) {
    recordAction({ at: started, args, code: -1, ms: Date.now() - started, error: String(error) });
    throw error;
  }
}

export class GitCommandError extends Error {
  constructor(message: string, readonly result: GitResult) {
    super(message);
    this.name = 'GitCommandError';
  }
}

export async function gitOrThrow(repoPath: string, args: string[], opts: GitOptions = {}): Promise<GitResult> {
  const result = await git(repoPath, args, opts);
  if (result.code !== 0) {
    throw new GitCommandError(
      `git ${args.join(' ')} failed (${result.code}): ${result.stderr.trim() || result.stdout.trim()}`,
      result
    );
  }
  return result;
}
