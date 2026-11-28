import type { ColorRole } from '../protocol';

export interface RefSegment {
  text: string;
  role: ColorRole;
}

/**
 * A refs label split into painted pieces. The label `refsLabel()` builds is
 * `[HEAD -> main tag: v1 origin/main]`; an unpushed tag is one token and takes the
 * `untracked` colour, while the rest of the bracket keeps the `refs` colour. With no
 * remote answer (`pushedTags` absent) the whole label is one refs segment.
 */
export function refSegments(label: string, pushedTags?: ReadonlySet<string>): RefSegment[] {
  if (label.length === 0) {
    return [];
  }
  if (!pushedTags) {
    return [{ text: label, role: 'refs' }];
  }
  const result: RefSegment[] = [];
  const pattern = /tag:\s+([^\s\]]+)/g;
  let at = 0;
  let matched = false;
  for (let match = pattern.exec(label); match; match = pattern.exec(label)) {
    const name = match[1] ?? '';
    if (pushedTags.has(name)) {
      continue;
    }
    matched = true;
    if (match.index > at) {
      result.push({ text: label.slice(at, match.index), role: 'refs' });
    }
    result.push({ text: match[0], role: 'untracked' });
    at = match.index + match[0].length;
  }
  if (!matched) {
    return [{ text: label, role: 'refs' }];
  }
  if (at < label.length) {
    result.push({ text: label.slice(at), role: 'refs' });
  }
  return result;
}
