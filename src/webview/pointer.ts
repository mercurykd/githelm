/**
 * How far a drag scrolls the list when the pointer is near an edge of the window.
 *
 * The webview only knows the rows the pointer is over, so a drag that reaches the edge
 * of the window stops growing there: the reader would have to drop the selection, scroll
 * and Shift+Click — over rows that are not on screen yet. A drag therefore scrolls the
 * page while the button is held, and the selection follows the row that arrives under the
 * pointer. The farther into the `margin` band the pointer is, the faster it goes, so a
 * drag to the very edge moves like a page-flip and one that only grazes the band crawls.
 *
 * `top`/`bottom` are the visible band (the viewport), `pointerY` is in the same space.
 * The answer is pixels per frame: negative scrolls up, positive down, `0` means "the
 * pointer is not in a band, do not scroll".
 */
export function autoscrollDelta(
  pointerY: number,
  top: number,
  bottom: number,
  margin = 36,
  step = 16
): number {
  if (bottom - top < margin * 2) {
    // A panel shorter than two bands has no middle: split it in half instead.
    const half = (bottom - top) / 2;
    if (pointerY < top + half) {
      return -Math.ceil(step / 2);
    }
    return pointerY > bottom - half ? Math.ceil(step / 2) : 0;
  }
  if (pointerY < top + margin) {
    return -Math.ceil(step * Math.min(2, (top + margin - pointerY) / margin));
  }
  if (pointerY > bottom - margin) {
    return Math.ceil(step * Math.min(2, (pointerY - (bottom - margin)) / margin));
  }
  return 0;
}
