import type { ScreenKind } from './protocol';

/**
 * The screens `Tab` walks, in the order it walks them: the four screens that read the
 * repository. Help is deliberately not one of them: it is a key map you read, not a
 * screen you work in, and it has no repository of its own — `h` and its command still
 * open it.
 */
export const CAROUSEL: readonly ScreenKind[] = ['status', 'branches', 'tags', 'log'];

/**
 * The screen one `Tab` away, or `undefined` when the current screen is not in the
 * carousel at all. `direction` is `1` for `Tab` and `-1` for `Shift+Tab`, and the walk
 * wraps around, so `Shift+Tab` on the status screen is the tags screen.
 */
export function nextScreen(from: ScreenKind, direction: 1 | -1): ScreenKind | undefined {
  const at = CAROUSEL.indexOf(from);
  if (at < 0) {
    return undefined;
  }
  return CAROUSEL[(at + direction + CAROUSEL.length) % CAROUSEL.length];
}
