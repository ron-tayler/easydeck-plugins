import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { drawSpeakers, facePlaces, MAX_FACES } from './speakers-surface.js';
import type { Face } from './speakers-surface.js';

/** A face with a picture, since a data URL's contents do not matter here. */
function face(id: string, withPicture = true): Face {
  return withPicture ? { id, picture: `data:image/png;base64,${id}` } : { id };
}

/** Every tile in the markup, as the numbers that were drawn. */
function tiles(svg: string): { x: number; y: number; w: number; h: number }[] {
  return [...svg.matchAll(/<image x="([\d.]+)" y="([\d.]+)" width="([\d.]+)" height="([\d.]+)"/g)].map(
    (found) => ({
      x: Number(found[1]),
      y: Number(found[2]),
      w: Number(found[3]),
      h: Number(found[4]),
    }),
  );
}

describe('where the faces go', () => {
  it('gives one person the whole key', () => {
    assert.deepEqual(facePlaces(1, 100, 100), [{ x: 0, y: 0, w: 100, h: 100 }]);
  });

  it('divides a square key in two, then in three, then in four', () => {
    const two = facePlaces(2, 100, 100);
    assert.equal(two.length, 2);
    assert.deepEqual(two[0], { x: 0, y: 0, w: 100, h: 50 });

    // Three is a large one and two beside it rather than three slices: a third
    // of a square key is 33 units wide, and a face cropped into that is a nose.
    const three = facePlaces(3, 100, 100);
    assert.equal(three.length, 3);
    assert.deepEqual(three[0], { x: 0, y: 0, w: 100, h: 50 });
    assert.deepEqual(three[2], { x: 50, y: 50, w: 50, h: 50 });

    const four = facePlaces(4, 100, 100);
    assert.deepEqual(four[3], { x: 50, y: 50, w: 50, h: 50 });
  });

  it('lays them in a row when the space is a letterbox', () => {
    // A widget three keys wide, quartered, would be four wide slots with a
    // face in the middle of each. Four across fits the shape instead.
    const four = facePlaces(4, 300, 100);
    assert.deepEqual(
      four.map((cell) => cell.w),
      [75, 75, 75, 75],
    );
    assert.equal(four.every((cell) => cell.h === 100), true);
  });

  it('never divides further than the key can be read at', () => {
    assert.equal(facePlaces(9, 100, 100).length, MAX_FACES);
  });

  it('covers the whole area, whatever the count', () => {
    for (const count of [1, 2, 3, 4]) {
      const area = facePlaces(count, 100, 100).reduce((sum, cell) => sum + cell.w * cell.h, 0);
      assert.equal(area, 10_000, `${count} faces left part of the key unused`);
    }
  });
});

describe('drawing the faces', () => {
  it('crops each face to fill its tile, rather than fitting it inside', () => {
    // An avatar is a square with a head in the middle, and the middle is the
    // part worth keeping. Fitting would letterbox every tile.
    const svg = drawSpeakers([face('a'), face('b')], {}, 1, 1);
    assert.equal((svg.match(/preserveAspectRatio="xMidYMid slice"/g) ?? []).length, 2);
  });

  it('leaves a gap between the tiles and none around the outside', () => {
    const drawn = tiles(drawSpeakers([face('a'), face('b')], {}, 1, 1));

    // The first tile starts at the very edge; the second is pushed off it.
    assert.equal(drawn[0]?.x, 0);
    assert.equal(drawn[0]?.y, 0);
    assert.equal(drawn[1]?.y, 51.5);
    // And together they still reach the far edge.
    assert.equal((drawn[1]?.y ?? 0) + (drawn[1]?.h ?? 0), 100);
  });

  it('draws a colour for somebody whose picture has not arrived', () => {
    const svg = drawSpeakers([face('a', false)], {}, 1, 1);

    // A tile, and no picture in it: a key that flashed empty for the length of
    // one download would look like a key that failed.
    assert.equal(tiles(svg).length, 0);
    assert.match(svg, /<rect x="0" y="0" width="100" height="100" rx="10" fill="#[0-9a-f]{6}"\/>/);
  });

  it('gives two people two different colours', () => {
    const svg = drawSpeakers([face('a', false), face('bbbb', false)], {}, 1, 1);
    const colours = new Set([...svg.matchAll(/fill="(#[0-9a-f]{6})"/g)].map((found) => found[1]));
    assert.equal(colours.size, 2);
  });

  it('fades the whole picture when asked, and nothing when not', () => {
    assert.match(drawSpeakers([face('a')], { opacity: 0.35 }), /<g opacity="0.35">/);
    assert.equal(/opacity/.test(drawSpeakers([face('a')], {})), false);
  });

  it('leaves the key showing through unless a background was chosen', () => {
    assert.equal(/<rect width="100"/.test(drawSpeakers([face('a')], {})), false);
    assert.match(drawSpeakers([face('a')], { background: '#101010' }), /<rect width="100" height="100" fill="#101010"/);
  });

  it('does not let a colour out of its attribute', () => {
    // The field is free text somebody typed, and a quote in it would close the
    // attribute and let the rest be markup.
    const svg = drawSpeakers([face('a')], { background: '"><script>x</script>' });
    assert.equal(svg.includes('<script>'), false);
  });

  it('grows with the space the key was given', () => {
    const svg = drawSpeakers([face('a')], {}, 3, 2);
    assert.match(svg, /viewBox="0 0 300 200"/);
    assert.deepEqual(tiles(svg)[0], { x: 0, y: 0, w: 300, h: 200 });
  });
});
