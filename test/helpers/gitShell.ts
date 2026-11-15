import { spawnSync } from 'node:child_process';

export interface GitShellProbe {
  ok: boolean;
  status: number | null;
}

/**
 * Checks whether git can actually execute a shell command.
 *
 * `GIT_SEQUENCE_EDITOR` is run through a POSIX shell, so `git rebase -i`
 * depends on git's own `sh.exe` (not on whatever `sh` happens to be in PATH).
 * A shell alias is the cheapest way to ask git itself.
 */
export function probeGitShell(): GitShellProbe {
  const result = spawnSync('git', ['-c', 'alias.githelmprobe=!exit 0', 'githelmprobe'], {
    stdio: 'ignore',
    timeout: 10_000,
    windowsHide: true,
  });
  return { ok: result.status === 0, status: result.status };
}
