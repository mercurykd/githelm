import { keySegments } from '../../views/rowLabels';
import type { HintModel } from '../protocol';

/** `c commit   alt+s stage all` → `{ keys: 'c', label: 'commit' }`, `{ keys: 'alt+s', label: 'stage all' }`. */
export function parseHints(keysLine: string): HintModel[] {
  return keySegments(keysLine)
    .map((segment) => {
      const space = segment.indexOf(' ');
      return space < 0
        ? { keys: segment, label: '' }
        : { keys: segment.slice(0, space), label: segment.slice(space + 1).trim() };
    })
    .filter((hint) => hint.keys.length > 0);
}
