/**
 * Level meters, drawn as a key.
 *
 * Pure, like the hardware graph next door and for the same reason: everything
 * that can be wrong here is arithmetic about numbers and colours, and none of
 * it needs a panel to check.
 */

export interface MeterStyle {
  /** Bars standing up side by side, rather than lying along the key. */
  readonly vertical: boolean;
  /** How much of the key the whole block of bars takes, 0..1. */
  readonly thickness: number;
  readonly calm: string;
  readonly loud: string;
  readonly hot: string;
  /**
   * The trough each bar sits in, drawn whether or not there is a level.
   *
   * Without it a silent input draws nothing at all, and a key metering three
   * things where two are quiet looks exactly like a key metering one — you
   * cannot tell which bar is which, or that the others are there. Every mixer
   * has this for the same reason.
   */
  readonly track?: string;
  readonly background?: string;
  /** Where amber starts and where red starts, as shares of the scale. */
  readonly warnAt: number;
  readonly hotAt: number;
}

/**
 * The quietest sound worth drawing, in decibels.
 *
 * The same floor OBS puts on its own mixer. Below this a meter is measuring
 * the room rather than the person in it.
 */
export const FLOOR_DB = -60;

/** Between one bar and the next, in the hundred units a key is. */
const GAP = 3;

/**
 * A level as a share of the scale, from the multiplier OBS reports.
 *
 * Logarithmic, because hearing is. Drawn straight from the multiplier, a
 * normal speaking voice — around a twentieth of full scale — would be a stub
 * at the very bottom of the key while sounding perfectly loud, and the meter
 * would look broken rather than quiet.
 *
 * Measured on the developer's machine: desktop audio at 0.72 of full scale is
 * −2.8 dB and nearly the whole bar; a quiet room on the microphone reads 0.07,
 * which is −23 dB and about six tenths. Those are the numbers OBS's own mixer
 * shows for the same moment.
 */
export function levelOf(multiplier: number): number {
  if (!Number.isFinite(multiplier) || multiplier <= 0) return 0;

  const db = 20 * Math.log10(Math.min(1, multiplier));
  if (db <= FLOOR_DB) return 0;

  return Math.min(1, (db - FLOOR_DB) / -FLOOR_DB);
}

/**
 * The picture, as SVG text.
 *
 * Several inputs at once, because one bar on a key is a key that has told you
 * about one microphone and spent itself doing it. A mixer is read by comparing
 * the bars against each other, so they share a scale, a size and a colouring,
 * and the only thing that tells them apart is their order — which is the order
 * they were listed in.
 *
 * The block of bars takes as much of the key as it was told to and no more, so
 * a meter can be a strip along the bottom with a label above it, or the whole
 * face of the key. What is under it shows through unless a background is asked
 * for.
 *
 * Coloured by where each part of a bar sits rather than by how loud it is
 * overall: a bar reaching into the red is green, then amber, then red, which is
 * what every mixer in the world looks like and therefore needs no explaining.
 */
export function drawMeter(
  levels: readonly number[],
  style: MeterStyle,
  cols = 1,
  rows = 1,
): string {
  const width = 100 * cols;
  const height = 100 * rows;

  const parts: string[] = [
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" width="${width}" height="${height}">`,
  ];

  if (style.background) {
    parts.push(`<rect width="${width}" height="${height}" fill="${escape(style.background)}"/>`);
  }

  if (levels.length > 0) {
    // The block runs across the key's short way; the bars divide it between
    // them, and each grows along the long way.
    const across = Math.max(2, Math.min(1, style.thickness) * (style.vertical ? width : height));
    const gaps = GAP * Math.max(0, levels.length - 1);
    const thick = Math.max(1, (across - gaps) / levels.length);

    levels.forEach((level, index) => {
      const filled = Math.max(0, Math.min(1, level));
      const offset = index * (thick + GAP);

      const zones: [number, number, string][] = [
        // The trough first and full length, so every bar is visible at rest
        // and the lit part is drawn over it.
        ...(style.track ? ([[0, 1, style.track]] as [number, number, string][]) : []),
        [0, Math.min(filled, style.warnAt), style.calm],
        [style.warnAt, Math.min(filled, style.hotAt), style.loud],
        [style.hotAt, filled, style.hot],
      ];

      for (const [from, to, colour] of zones) {
        if (to <= from) continue;

        /*
         * Vertical bars grow upward from the bottom and are laid out from the
         * left; horizontal bars grow rightward and are stacked from the bottom
         * up. Upward and rightward are the only directions a level is ever
         * drawn in, and bottom-up stacking puts the first one where the eye
         * already is on a key with a label above it.
         */
        const box = style.vertical
          ? { x: offset, y: height - to * height, w: thick, h: (to - from) * height }
          : { x: from * width, y: height - thick - offset, w: (to - from) * width, h: thick };

        parts.push(
          `<rect x="${round(box.x)}" y="${round(box.y)}" width="${round(box.w)}" ` +
            `height="${round(box.h)}" fill="${escape(colour)}"/>`,
        );
      }
    });
  }

  parts.push('</svg>');
  return parts.join('');
}

function round(value: number): number {
  return Math.round(value * 100) / 100;
}

/**
 * Colours come from a form somebody filled in, and land inside an attribute.
 *
 * Nothing here trusts the value to be a colour: the field is free text, and a
 * quote in it would otherwise close the attribute and let the rest be markup.
 */
function escape(value: string): string {
  return value.replace(/[<>&"']/g, (char) => `&#${char.charCodeAt(0)};`);
}
