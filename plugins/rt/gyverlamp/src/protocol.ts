/**
 * The GyverLamp wire format, read and written as the firmware speaks it.
 *
 * The lamp is an ESP8266 running the `gunner47 v2.87in1` fork of GyverLamp,
 * and its whole protocol is one UDP datagram of ASCII per command with one
 * datagram back. Everything here was checked against a real lamp before it
 * was written down — see the main repository's docs/gyverlamp-plugin.md for
 * the transcript and the surprises.
 *
 * The commands this plugin sends:
 *
 *   GET        — the state line, `CURR <effect> <bri> <speed> <scale> <on> …`
 *   P_ON/P_OFF — power
 *   EFF<n>     — switch to effect n, counted from nought
 *   BRI<n>     — brightness 1..255, *of the current effect*
 *   SPD<n>     — speed 1..255, of the current effect too
 *   LIST1..3   — the effect registry, ~870 bytes a line
 *   DISCOVER   — answered `IP a.b.c.d:8888[:name]`, and only by a lamp in
 *                Wi-Fi-client mode
 *
 * Every command that changes something answers with the same `CURR` line GET
 * does, which is what lets a key mirror the lamp instead of assuming: after
 * an effect switch the lamp loads that effect's *stored* brightness and
 * speed, not the ones last sent, and the reply is where the truth is.
 */

/** What the lamp says it is doing, one `CURR` line's worth. */
export interface LampState {
  readonly effect: number;
  readonly brightness: number;
  readonly speed: number;
  readonly scale: number;
  readonly on: boolean;
}

/** `CURR 42 145 203 1 1 …` — the trailing mode flags and clock are not ours. */
export function parseCurr(text: string): LampState | undefined {
  const found = /^CURR (\d+) (\d+) (\d+) (\d+) ([01])\b/.exec(text);
  if (!found) return undefined;

  return {
    effect: Number(found[1]),
    brightness: Number(found[2]),
    speed: Number(found[3]),
    scale: Number(found[4]),
    on: found[5] === '1',
  };
}

/**
 * One `LIST<n>` reply, as effect numbers and clean names.
 *
 * The firmware writes every entry as `42. Oгoнь,99,252,1,100,1` — the number
 * repeated inside the name, then the speed and scale bounds and a colour
 * flag. The number is parsed and the prefix dropped: a variable saying what
 * is on the wall wants `Oгoнь`, and a list can put the number back. The
 * bounds are left on the floor until something draws a slider.
 */
export function parseListChunk(text: string): Map<number, string> | undefined {
  if (!/^LIST\d;/.test(text)) return undefined;

  const effects = new Map<number, string>();
  for (const entry of text.split(';').slice(1)) {
    const found = /^(\d+)\.\s*(.+?),\d+,\d+,\d+,\d+,\d+$/.exec(entry.trim());
    if (found) effects.set(Number(found[1]), found[2]!);
  }

  return effects;
}

/** `IP 192.168.1.90:8888` — with a name after the port when the build sends one. */
export function parseDiscoverReply(text: string): { port: number; name?: string } | undefined {
  const found = /^IP (\d+\.\d+\.\d+\.\d+):(\d+)(?::(.+))?$/.exec(text.trim());
  if (!found) return undefined;

  const port = Number(found[2]);
  if (!Number.isInteger(port) || port < 1 || port > 65535) return undefined;

  return found[3] ? { port, name: found[3] } : { port };
}

/**
 * The 87 effects of the build this plugin was written against, for a lamp
 * that never answers `LIST` — an older firmware, or one asked at a bad
 * moment. The odd spelling is the firmware's own (Latin letters standing in
 * for Cyrillic ones) and is kept as it is, because it is what the official
 * app shows and what the person at the deck has already seen.
 */
export const FALLBACK_EFFECTS: readonly string[] = [
  'Бeлый cвeт',
  'Цвeт',
  'Cмeнa цвeтa',
  'Бeзyмиe',
  'Oблaкa',
  'Лaвa',
  'Плaзмa',
  'Paдyгa 3D',
  'Пaвлин',
  '3eбpa',
  'Лec',
  'Oкeaн',
  'Mячики',
  'Mячики бeз гpaниц',
  'Пoпкopн',
  'Cпиpaли',
  'Пpизмaтa',
  'Дымoвыe шaшки',
  'Плaмя',
  'Oгoнь 2021',
  'Tиxий oкeaн',
  'Teни',
  'ДHK',
  'Cтaя',
  'Cтaя и xищник',
  'Moтыльки',
  'Лaмпa c мoтылькaми',
  '3мeйки',
  'Nexus',
  'Шapы',
  'Cинycoид',
  'Meтaбoлз',
  'Ceвepнoe cияниe',
  'Плaзмeннaя лaмпa',
  'Лaвoвaя лaмпa',
  'Жидкaя лaмпa',
  'Жидкaя лaмпa (auto)',
  'Kaпли нa cтeклe',
  'Maтpицa',
  'Oгoнь 2012',
  'Oгoнь 2018',
  'Oгoнь 2020',
  'Oгoнь',
  'Bиxpи плaмeни',
  'Paзнoцвeтныe виxpи',
  'Maгмa',
  'Kипeниe',
  'Boдoпaд',
  'Boдoпaд 4 в 1',
  'Бacceйн',
  'Пyльc',
  'Paдyжный пyльc',
  'Бeлый пyльc',
  'Ocциллятop',
  'Иcтoчник',
  'Фeя',
  'Koмeтa',
  'Oднoцвeтнaя кoмeтa',
  'Двe кoмeты',
  'Тpи кoмeты',
  'Пpитяжeниe',
  'Пapящий oгoнь',
  'Bepxoвoй oгoнь',
  'Paдyжный змeй',
  'Koнфeтти',
  'Mepцaниe',
  'Дым',
  'Paзнoцвeтный дым',
  'Пикacco',
  'Boлны',
  'Цвeтныe дpaжe',
  'Koдoвый зaмoк',
  'Kyбик Pyбикa',
  'Tyчкa в бaнкe',
  'Гроза в банке',
  'Ocaдки',
  'Paзнoцвeтный дoждь',
  'Cнeгoпaд',
  '3вeздoпaд / Meтeль',
  'Пpыгyны',
  'Cвeтлячки',
  'Cвeтлячки co шлeйфoм',
  'Люмeньep',
  'Пeйнтбoл',
  'Paдyгa',
  'Чacы',
  'Бeгyщaя cтpoкa',
];
