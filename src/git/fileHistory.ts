import path from 'node:path';
import { git } from './exec';
import { authorColumnWidth, truncateAuthor } from './log';

/** Path of a file relative to the repository root, using forward slashes. */
export function repoRelativePath(repoPath: string, filePath: string): string {
  return path.relative(repoPath, filePath).split(path.sep).join('/');
}

export async function fileLog(repoPath: string, relativePath: string, limit = 200): Promise<string> {
  const result = await git(repoPath, [
    'log',
    '--follow',
    '--no-color',
    '--date=short',
    `--max-count=${limit}`,
    '--format=%h%x1f%ad%x1f%an%x1f%s%x1f%D',
    '--',
    relativePath,
  ]);
  if (result.code !== 0) {
    throw new Error(result.stderr.trim() || `git log --follow failed (${result.code})`);
  }

  const lines = result.stdout.split('\n').filter((line) => line.length > 0);
  const header = `История файла: ${relativePath} (${lines.length} коммитов)`;
  const commits = lines.map((line) => {
    const [sha = '', date = '', author = '', subject = '', refs = ''] = line.split('\x1f');
    return { sha, date, author, subject, refs };
  });
  // Same author column as the history graph: as wide as the longest name, so
  // the subject starts two columns after it instead of after a fixed 20.
  const authorWidth = authorColumnWidth(commits.map((commit) => commit.author));
  const rows = commits.map(({ sha, date, author, subject, refs }) => {
    // `%D` gives bare ref names (the history graph reads the same field), so the
    // parentheses below are the only ones — with `%d` they were doubled up.
    const decorations = refs.trim() ? `  (${refs.trim()})` : '';
    return `${sha.padEnd(9)}${date.padEnd(12)}${truncateAuthor(author).padEnd(authorWidth)}${subject}${decorations}`;
  });
  return ['', header, '─'.repeat(Math.max(20, header.length)), ...rows, ''].join('\n');
}

export async function fileBlame(repoPath: string, relativePath: string, maxLines = 3000): Promise<string> {
  const result = await git(repoPath, ['blame', '--date=short', '--', relativePath]);
  if (result.code !== 0) {
    throw new Error(result.stderr.trim() || `git blame failed (${result.code})`);
  }
  const lines = result.stdout.split('\n');
  if (lines.length > maxLines) {
    return `${lines.slice(0, maxLines).join('\n')}\n… (blame обрезан: ${lines.length - maxLines} строк)\n`;
  }
  return result.stdout;
}
