/**
 * The people talking right now, as a key.
 *
 * Pure, like the level meter next door and for the same reason: everything
 * that can be wrong here is arithmetic about rectangles, and none of it needs
 * a panel — or Discord — to check.
 *
 * The picture answers one question at a glance, and it is not "who is in the
 * call". It is "who is making the noise", which on a key beside the mute
 * button is the difference between knowing whether to speak and guessing.
 */

/**
 * How many faces fit before the key stops being readable.
 *
 * Four, and this is a limit on the drawing rather than on the room: a full
 * call is eight people and half of them talking at once is normal. Divided
 * into eight, a key is eight postage stamps and answers nothing. Who is
 * dropped is decided elsewhere, by how recently each started — see
 * `discord-plugin.ts`.
 */
export const MAX_FACES = 4;

/** Between one face and the next, in the hundred units a key is. */
const GAP = 3;

/** Corner rounding, so the tiles read as pictures rather than as a mosaic. */
const RADIUS = 10;

/** One person, as much of them as a picture needs. */
export interface Face {
  readonly id: string;
  /** The avatar as a data URL, once it has arrived. */
  readonly picture?: string;
}

export interface SpeakersStyle {
  /** Behind the faces; nothing means the key's own background shows through. */
  readonly background?: string;
  /**
   * How solid to draw them, 0..1.
   *
   * The room going quiet is drawn as the same faces faded rather than as an
   * empty key, when somebody has asked for that: a key that blanks the instant
   * everyone stops talking flickers through every gap in a conversation.
   */
  readonly opacity?: number;
}

interface Cell {
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
}

/**
 * Where each face goes, for as many as there are.
 *
 * The whole area is used, always: two faces are two halves, three are a large
 * one and two beside it, four are quarters. Nobody is shown small so that an
 * empty seat can be left for somebody who is not talking.
 *
 * Which way it splits follows the shape of the space rather than a fixed
 * grid. A key is square and splits one way; a widget three keys wide is a
 * letterbox, and quartering that gives four wide slots with a face in the
 * middle of each — so it lays them in a row instead.
 */
export function facePlaces(count: number, width: number, height: number): Cell[] {
  const many = Math.max(1, Math.min(MAX_FACES, count));
  if (many === 1) return [{ x: 0, y: 0, w: width, h: height }];

  // Long and thin in either direction: a single row or column, however many.
  if (width >= height * many * 0.75) return strip(many, width, height, true);
  if (height >= width * many * 0.75) return strip(many, width, height, false);

  if (many === 2) {
    return width > height ? strip(2, width, height, true) : strip(2, width, height, false);
  }

  if (many === 3) {
    /*
     * One large and two beside it, rather than three equal slices.
     *
     * Three slices of a square key are 33 units wide and 100 tall, and a face
     * cropped into that is a nose. The large one goes to the newest speaker,
     * which is what the caller's ordering already puts first.
     */
    if (width > height) {
      return [
        { x: 0, y: 0, w: width / 2, h: height },
        { x: width / 2, y: 0, w: width / 2, h: height / 2 },
        { x: width / 2, y: height / 2, w: width / 2, h: height / 2 },
      ];
    }

    return [
      { x: 0, y: 0, w: width, h: height / 2 },
      { x: 0, y: height / 2, w: width / 2, h: height / 2 },
      { x: width / 2, y: height / 2, w: width / 2, h: height / 2 },
    ];
  }

  return [
    { x: 0, y: 0, w: width / 2, h: height / 2 },
    { x: width / 2, y: 0, w: width / 2, h: height / 2 },
    { x: 0, y: height / 2, w: width / 2, h: height / 2 },
    { x: width / 2, y: height / 2, w: width / 2, h: height / 2 },
  ];
}

function strip(count: number, width: number, height: number, across: boolean): Cell[] {
  return Array.from({ length: count }, (_, index) =>
    across
      ? { x: (width / count) * index, y: 0, w: width / count, h: height }
      : { x: 0, y: (height / count) * index, w: width, h: height / count },
  );
}

/**
 * The picture, as SVG text.
 *
 * Faces are cropped to fill their tile rather than fitted inside it, which is
 * what every call in the world looks like: an avatar is a square with a head
 * in the middle of it, and the middle is the part worth keeping. Fitting
 * instead would letterbox every tile and shrink the head to make room for the
 * bars.
 *
 * A face whose picture has not arrived is a solid tile in a colour of its own
 * rather than a hole. It lasts as long as one fetch from Discord's CDN and
 * never again for that person, but a key that flashes empty in that moment
 * looks like a key that failed.
 */
export function drawSpeakers(
  faces: readonly Face[],
  style: SpeakersStyle = {},
  cols = 1,
  rows = 1,
): string {
  const width = 100 * cols;
  const height = 100 * rows;
  const shown = faces.slice(0, MAX_FACES);

  const parts: string[] = [
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" width="${width}" height="${height}">`,
  ];

  if (style.background) {
    parts.push(`<rect width="${width}" height="${height}" fill="${escape(style.background)}"/>`);
  }

  const opacity = style.opacity ?? 1;
  if (opacity < 1) parts.push(`<g opacity="${round(Math.max(0, opacity))}">`);

  facePlaces(shown.length, width, height).forEach((cell, index) => {
    const face = shown[index];
    if (!face) return;

    const box = inset(cell, width, height);
    if (box.w <= 0 || box.h <= 0) return;

    const clip = `f${index}`;
    const radius = Math.min(RADIUS, box.w / 2, box.h / 2);

    parts.push(
      `<clipPath id="${clip}">` +
        `<rect x="${round(box.x)}" y="${round(box.y)}" width="${round(box.w)}" ` +
        `height="${round(box.h)}" rx="${round(radius)}"/></clipPath>`,
      `<rect x="${round(box.x)}" y="${round(box.y)}" width="${round(box.w)}" ` +
        `height="${round(box.h)}" rx="${round(radius)}" fill="${standIn(face.id)}"/>`,
    );

    if (face.picture) {
      parts.push(
        `<image x="${round(box.x)}" y="${round(box.y)}" width="${round(box.w)}" ` +
          `height="${round(box.h)}" preserveAspectRatio="xMidYMid slice" ` +
          `clip-path="url(#${clip})" href="${escape(face.picture)}"/>`,
      );
    }
  });

  if (opacity < 1) parts.push('</g>');

  parts.push('</svg>');
  return parts.join('');
}

/**
 * Gaps between the tiles and none around the outside.
 *
 * A widget that left a margin at the edge would sit in a frame of key
 * background, which on a key that is mostly this picture reads as the picture
 * being the wrong size.
 */
function inset(cell: Cell, width: number, height: number): Cell {
  const left = cell.x > 0 ? GAP / 2 : 0;
  const top = cell.y > 0 ? GAP / 2 : 0;
  const right = cell.x + cell.w < width ? GAP / 2 : 0;
  const bottom = cell.y + cell.h < height ? GAP / 2 : 0;

  return {
    x: cell.x + left,
    y: cell.y + top,
    w: cell.w - left - right,
    h: cell.h - top - bottom,
  };
}

/**
 * A colour for somebody whose picture is not here yet.
 *
 * From their id, so it is the same colour every time and two people beside
 * each other are two colours. Discord does the same thing for the same reason.
 */
function standIn(id: string): string {
  const palette = ['#5865f2', '#3ba55d', '#faa81a', '#ed4245', '#eb459f', '#00a8fc'];
  let hash = 0;
  for (const char of id) hash = (hash * 31 + char.charCodeAt(0)) % 100_003;

  return palette[hash % palette.length]!;
}

function round(value: number): number {
  return Math.round(value * 100) / 100;
}

/** A colour comes from a form somebody filled in, and lands inside an attribute. */
function escape(value: string): string {
  return value.replace(/[<>&"']/g, (char) => `&#${char.charCodeAt(0)};`);
}
