import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { autoscrollDelta } from '../src/webview/pointer';

/**
 * Drag autoscroll: the panel is a scrolling page, so a drag that reaches an edge has to
 * scroll it or the range stops at the last row that happens to be visible.
 */
describe('drag autoscroll', () => {
  it('does nothing in the middle of the panel', () => {
    assert.equal(autoscrollDelta(400, 0, 800), 0);
    assert.equal(autoscrollDelta(37, 0, 800), 0);
    assert.equal(autoscrollDelta(762, 0, 800), 0);
  });

  it('scrolls up near the top edge and down near the bottom one', () => {
    assert.ok(autoscrollDelta(20, 0, 800) < 0, 'above the band is up');
    assert.ok(autoscrollDelta(780, 0, 800) > 0, 'below the band is down');
  });

  it('scrolls faster the deeper into the band the pointer is', () => {
    const grazing = autoscrollDelta(35, 0, 800);
    const deep = autoscrollDelta(5, 0, 800);
    assert.ok(deep < grazing, 'the deeper the pointer, the bigger the step');
    // The band is a band, not a cliff: just inside it moves a little.
    assert.equal(autoscrollDelta(36, 0, 800), 0);
    assert.ok(Math.abs(autoscrollDelta(0, 0, 800)) <= 32);
  });

  it('still scrolls when the panel is shorter than two bands', () => {
    const up = autoscrollDelta(10, 0, 60);
    const down = autoscrollDelta(50, 0, 60);
    assert.ok(up < 0);
    assert.ok(down > 0);
    assert.equal(autoscrollDelta(30, 0, 60), 0);
  });

  it('reads the viewport it is given, not a fixed one', () => {
    // The same pointer position over a scrolled viewport: `top`/`bottom` are in its space.
    assert.ok(autoscrollDelta(410, 400, 1200) < 0);
    assert.ok(autoscrollDelta(1190, 400, 1200) > 0);
  });
});
