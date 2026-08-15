import assert from 'node:assert/strict';
import { PluginRuntime, PluginSettingsStore, installForTest } from '../../../../testing/core.js';
import { describe, it } from 'node:test';

import { FLOOR_DB, drawMeter, levelOf } from './obs-meter.js';

const style = {
  vertical: false,
  thickness: 0.2,
  calm: '#3fb950',
  loud: '#d29922',
  hot: '#f85149',
  warnAt: 0.75,
  hotAt: 0.92,
};

describe('a level from what OBS reports', () => {
  it('is logarithmic, because hearing is', () => {
    /*
     * Drawn straight from the multiplier, a normal speaking voice — about a
     * twentieth of full scale — would be a stub at the bottom of the key while
     * sounding perfectly loud, and the meter would look broken rather than
     * quiet.
     */
    assert.equal(levelOf(1), 1);

    // Measured on the developer's machine, and the numbers OBS's own mixer
    // showed for the same moment: desktop audio at 0.72, a quiet room at 0.07.
    assert.ok(levelOf(0.72) > 0.9, 'nearly the whole bar');
    assert.ok(levelOf(0.07) > 0.55 && levelOf(0.07) < 0.68, 'about six tenths');
  });

  it('bottoms out where OBS does', () => {
    // Below the mixer's own floor a meter is measuring the room rather than
    // the person in it.
    const floor = 10 ** (FLOOR_DB / 20);

    assert.equal(levelOf(floor), 0);
    assert.equal(levelOf(floor / 2), 0);
    assert.equal(levelOf(0), 0);
  });

  it('answers nothing for a number that is not one', () => {
    assert.equal(levelOf(Number.NaN), 0);
    assert.equal(levelOf(-1), 0);
  });
});

/** The lit width of every bar in a picture, ignoring the root element. */
const lit = (svg: string): number[] =>
  [...svg.matchAll(/<rect [^>]*width="([\d.]+)"/g)].map((match) => Number(match[1]));

describe('drawing a meter', () => {
  it('takes as much of the key as it was told to', () => {
    // Less than all of it leaves room for a label saying which inputs these
    // are; all of it is a key that is nothing but a mixer.
    const strip = drawMeter([1], { ...style, thickness: 0.2 });
    assert.match(strip, /height="20"/);
    assert.match(strip, /y="80"/);

    const whole = drawMeter([1], { ...style, thickness: 1 });
    assert.match(whole, /height="100"/);
  });

  it('colours by where the bar is, not by how loud it got', () => {
    /*
     * A bar reaching into the red is green, then amber, then red — which is
     * what every mixer in the world looks like and therefore needs no
     * explaining.
     */
    const full = drawMeter([1], style);
    assert.match(full, /#3fb950/);
    assert.match(full, /#d29922/);
    assert.match(full, /#f85149/);

    const quiet = drawMeter([0.5], style);
    assert.match(quiet, /#3fb950/);
    assert.doesNotMatch(quiet, /#d29922/);
    assert.doesNotMatch(quiet, /#f85149/);
  });

  it('draws nothing but the background for silence', () => {
    const svg = drawMeter([0], { ...style, background: '#101820' });

    assert.match(svg, /#101820/);
    assert.doesNotMatch(svg, /#3fb950/);
  });

  it('grows upward when the bars are stood on end', () => {
    // Upward and rightward are the only directions a level is ever drawn in.
    const svg = drawMeter([0.5], { ...style, vertical: true });

    assert.match(svg, /y="50"/);
    assert.match(svg, /height="50"/);
  });

  it('grows the viewBox with the keys it covers', () => {
    assert.match(drawMeter([1], style, 3, 1), /viewBox="0 0 300 100"/);
    assert.match(drawMeter([1], style, 2, 2), /viewBox="0 0 200 200"/);
  });

  it('will not let a colour out of its attribute', () => {
    // The colour fields are free text and this ends up inside an attribute.
    const svg = drawMeter([1], { ...style, calm: '"><script>alert(1)</script>' });

    assert.doesNotMatch(svg, /<script>/);
    assert.match(svg, /fill="&#34;/);
  });
});

describe('several inputs on one key', () => {
  const whole = { ...style, thickness: 1 };

  it('divides the block between them, with a gap', () => {
    // Read by comparing the bars against each other, so they are the same size
    // and the same colouring, and only their order tells them apart.
    const one = drawMeter([0.5], whole);
    const three = drawMeter([0.5, 0.5, 0.5], whole);

    assert.match(one, /height="100"/);
    // Three bars and two gaps inside the same hundred.
    assert.match(three, /height="31.33"/);
    assert.equal((three.match(/<rect /g) ?? []).length, 3);
  });

  it('measures them all against one scale', () => {
    /*
     * The point of putting them together. Scaled to their own peaks, a
     * whisper and a shout would be the same bar.
     */
    const svg = drawMeter([1, 0.5], whole);
    const widths = lit(svg);

    // The loud one is drawn in three zones, the quiet one in one.
    assert.equal(widths.reduce((total, width) => total + width, 0), 100 + 50);
  });

  it('stacks the first one where the eye already is', () => {
    // Bottom-up, so on a key with a label above it the first input is nearest
    // the words that name it.
    const svg = drawMeter([1, 1], whole);
    const tops = [...svg.matchAll(/<rect [^>]*y="([\d.]+)"/g)].map((match) => Number(match[1]));

    assert.ok(Math.max(...tops) > Math.min(...tops), 'they are not on top of each other');
  });

  it('draws nothing at all when nothing was named', () => {
    const svg = drawMeter([], whole);
    assert.equal((svg.match(/<rect /g) ?? []).length, 0);
  });

  it('shows a silent input as an empty trough rather than as nothing', () => {
    /*
     * Without it, a key metering three things where two are quiet looks
     * exactly like a key metering one, and there is no telling which bar is
     * which or that the others are there.
     */
    const bare = drawMeter([1, 0, 0], whole);
    assert.equal((bare.match(/<rect /g) ?? []).length, 3, 'only the loud one is drawn');

    const troughed = drawMeter([1, 0, 0], { ...whole, track: '#ffffff20' });
    const troughs = [...troughed.matchAll(/fill="#ffffff20"/g)];
    assert.equal(troughs.length, 3, 'one behind every bar, loud or not');
  });

  it('draws the trough under the level, not over it', () => {
    const svg = drawMeter([1], { ...whole, track: '#ffffff20' });
    assert.ok(svg.indexOf('#ffffff20') < svg.indexOf('#3fb950'));
  });
});
