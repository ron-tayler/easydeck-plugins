import { PLUGIN_API_VERSION, definePlugin, numberParam } from '@easydeck/plugin-sdk';
import type {
  ActionHandler,
  ParamOption,
  Plugin,
  PluginActivation,
  PluginHost,
  PluginManifest,
  Ticker,
  VariableValue,
} from '@easydeck/plugin-sdk';

import { LampSocket, discoverLamps, formatAddress, parseAddress } from './lamp-socket.js';
import type { DiscoveredLamp, LampAddress } from './lamp-socket.js';
import { FALLBACK_EFFECTS, parseCurr, parseListChunk } from './protocol.js';
import type { LampState } from './protocol.js';

/**
 * GyverLamp matrix lamps, driven over the local network.
 *
 * The lamp on the wall, on the keys beside everything else: which effect is
 * burning, how bright, how fast — and the power, because a deck without a
 * power key is silly. The shape is `ed.yandex` minus everything hard: no
 * account, no tokens, no push — a UDP socket, a queue, and a poll.
 *
 * Two facts about the firmware shape everything here; both were observed on
 * a real lamp rather than read in its source (docs/gyverlamp-plugin.md in
 * the main repository has the transcript):
 *
 * **Brightness belongs to the effect.** `BRI` and `SPD` set the *current
 * effect's* values, and switching effects loads the new one's stored
 * settings — including, after a round trip, values other than the ones last
 * sent. So nothing here assumes: every command's `CURR` reply is published
 * as the truth, and the variables mirror the lamp rather than the keys.
 *
 * **The lamp never speaks first.** There is no push and no subscription, so
 * the poll is the only way the deck learns what the physical button on the
 * lamp, or the phone app, just did. Every two seconds while something is
 * watching, gently when nothing is — the official app polls at the same
 * cadence, so the lamp is known to bear it.
 */

export const GYVERLAMP_PLUGIN_ID = 'rt.gyverlamp';

/** The argument that means "whichever lamp the settings chose". */
const NO_LAMP = '';

/** The app's own cadence, known to be comfortable for the firmware. */
const POLL_MS = 2000;

/** When nothing on screen reads a lamp variable: alive, but only just. */
const IDLE_POLL_MS = 10000;

/** Polls this many misses in a row mean the lamp is away, not unlucky. */
const MISS_LIMIT = 2;

/** Everything published per lamp, for clearing it all again. */
const FAMILIES = [
  'rt.gyverlamp.connected',
  'rt.gyverlamp.on',
  'rt.gyverlamp.effect',
  'rt.gyverlamp.effect-name',
  'rt.gyverlamp.brightness',
  'rt.gyverlamp.speed',
  'rt.gyverlamp.scale',
] as const;

export const gyverLampManifest: PluginManifest = {
  id: GYVERLAMP_PLUGIN_ID,
  name: { en: 'GyverLamp', ru: 'GyverLamp' },
  description: {
    en: 'Effects, brightness and power of GyverLamp matrix lamps over the local network',
    ru: 'Эффекты, яркость и питание матричных ламп GyverLamp по локальной сети',
  },
  version: '1.1.0',
  apiVersion: PLUGIN_API_VERSION,
  author: { en: 'Ron_Tayler', ru: 'Ron_Tayler' },
  cover: 'plugin:rt.gyverlamp/assets/cover.svg',

  settings: [
    {
      // Off until asked, like every network plugin here: a machine with no
      // lamp should not be sweeping its subnets for one.
      name: 'enabled',
      type: 'boolean',
      label: { en: 'Connect to GyverLamp', ru: 'Подключаться к GyverLamp' },
      default: false,
      required: false,
    },
    {
      name: 'lamp',
      type: 'select',
      required: false,
      label: { en: 'Lamp', ru: 'Лампа' },
      optionsFrom: 'lamps',
      description: {
        en: 'The one keys drive unless they name another. Press Find lamps below to fill this in',
        ru: 'С ней работают клавиши, если в них не выбрана другая. Список заполняет кнопка «Найти лампы»',
      },
      emptyNote: {
        en: 'No lamps yet — press Find lamps, or add an address below',
        ru: 'Ламп пока нет — нажмите «Найти лампы» или впишите адрес ниже',
      },
    },
    {
      /*
       * The way in for a lamp the sweep cannot see: another subnet, a lamp
       * in access-point mode, a firewall in the way. Declarative on purpose —
       * a list to edit survives a rescan, where a "add this one" button
       * would need a paired way to un-add it.
       */
      name: 'manual',
      type: 'string',
      required: false,
      label: { en: 'Addresses by hand', ru: 'Адреса вручную' },
      placeholder: { en: '192.168.1.90, 192.168.0.5:8888', ru: '192.168.1.90, 192.168.0.5:8888' },
      description: {
        en: 'For lamps Find lamps cannot reach, separated by commas',
        ru: 'Для ламп, которые не находит поиск, через запятую',
      },
    },
    {
      /*
       * The lamps this plugin has met, each with the effect list read from
       * it. Written by the plugin and read by nobody else. The list is
       * cached because it is ~2.5 KB of text that never changes until the
       * lamp is reflashed — asking on every start would be three datagrams
       * of ceremony for an answer already known.
       */
      name: 'lamps',
      type: 'string',
      internal: true,
      required: false,
      label: { en: 'Known lamps', ru: 'Известные лампы' },
    },
  ],

  commands: [
    {
      name: 'rescan',
      label: { en: 'Find lamps', ru: 'Найти лампы' },
      icon: 'globe',
      description: {
        en: 'Asks every host of the local network which of them is a lamp',
        ru: 'Спрашивает каждый адрес локальной сети, не лампа ли он',
      },
    },
  ],

  /*
   * Every one of these is a family, and the argument is a lamp — the same
   * bargain the speaker plugin makes, for the same reason: a second lamp
   * must not mean a second profile. Left out, the argument means whichever
   * lamp the settings chose, and `variableKey` gives that family its bare
   * name — so `{{rt.gyverlamp.effect-name}}` is a key somebody can write.
   */
  variables: [
    {
      name: 'rt.gyverlamp.lamp',
      type: 'string',
      label: { en: 'Chosen lamp', ru: 'Выбранная лампа' },
      description: {
        en: 'The lamp the settings chose, which the variables with no argument are about',
        ru: 'Лампа, выбранная в настройках, — о ней говорят переменные без аргумента',
      },
    },
    {
      name: 'rt.gyverlamp.connected',
      type: 'boolean',
      label: { en: 'Lamp answering', ru: 'Лампа на связи' },
      initial: false,
      argument: lampArgument(),
    },
    {
      name: 'rt.gyverlamp.on',
      type: 'boolean',
      label: { en: 'Lamp on', ru: 'Лампа горит' },
      initial: false,
      argument: lampArgument(),
    },
    {
      name: 'rt.gyverlamp.effect',
      type: 'number',
      label: { en: 'Effect number', ru: 'Номер эффекта' },
      argument: lampArgument(),
    },
    {
      name: 'rt.gyverlamp.effect-name',
      type: 'string',
      label: { en: 'Effect', ru: 'Эффект' },
      description: {
        en: 'As the lamp itself names it, read from the lamp once and kept',
        ru: 'Как его называет сама лампа — список читается из лампы и запоминается',
      },
      argument: lampArgument(),
    },
    {
      name: 'rt.gyverlamp.brightness',
      type: 'number',
      label: { en: 'Brightness', ru: 'Яркость' },
      description: {
        en: '1 to 255, and it belongs to the effect: switching effects switches it too',
        ru: 'От 1 до 255, и она принадлежит эффекту: сменился эффект — сменилась и яркость',
      },
      argument: lampArgument(),
    },
    {
      name: 'rt.gyverlamp.speed',
      type: 'number',
      label: { en: 'Speed', ru: 'Скорость' },
      argument: lampArgument(),
    },
    {
      name: 'rt.gyverlamp.scale',
      type: 'number',
      label: { en: 'Scale', ru: 'Масштаб' },
      description: {
        en: 'Each effect reads it its own way — size here, colour or variant there',
        ru: 'Каждый эффект понимает его по-своему: где-то размер, где-то цвет или вариант',
      },
      argument: lampArgument(),
    },
  ],

  actions: [
    {
      type: 'rt.gyverlamp.power',
      icon: 'toggle',
      label: { en: 'Power', ru: 'Питание' },
      params: [
        {
          name: 'mode',
          type: 'select',
          default: 'toggle',
          label: { en: 'What to do', ru: 'Что сделать' },
          options: [
            { value: 'toggle', label: { en: 'Toggle', ru: 'Переключить' } },
            { value: 'on', label: { en: 'On', ru: 'Включить' } },
            { value: 'off', label: { en: 'Off', ru: 'Выключить' } },
          ],
        },
        lampParam(),
      ],
    },
    {
      type: 'rt.gyverlamp.effect',
      icon: 'cycle',
      label: { en: 'Effect', ru: 'Эффект' },
      params: [
        {
          name: 'mode',
          type: 'select',
          default: 'set',
          label: { en: 'Which one', ru: 'Какой' },
          options: [
            { value: 'set', label: { en: 'This one', ru: 'Вот этот' } },
            { value: 'next', label: { en: 'Next', ru: 'Следующий' } },
            { value: 'prev', label: { en: 'Previous', ru: 'Предыдущий' } },
            { value: 'random', label: { en: 'Random', ru: 'Случайный' } },
          ],
        },
        {
          name: 'effect',
          type: 'select',
          required: false,
          label: { en: 'Effect', ru: 'Эффект' },
          optionsFrom: 'effects',
          dependsOn: ['lamp'],
          emptyNote: {
            en: 'No effect list yet — find the lamps first',
            ru: 'Списка эффектов пока нет — сначала найдите лампы',
          },
          description: {
            en: 'Only for "This one"; the list is the lamp\'s own',
            ru: 'Только для «Вот этот»; список — из самой лампы',
          },
        },
        lampParam(),
      ],
    },
    {
      type: 'rt.gyverlamp.brightness',
      icon: 'increment',
      label: { en: 'Brightness', ru: 'Яркость' },
      description: {
        en: 'Of the current effect — the firmware keeps one per effect',
        ru: 'Текущего эффекта — прошивка хранит свою на каждый эффект',
      },
      params: [
        {
          name: 'mode',
          type: 'select',
          default: 'up',
          label: { en: 'What to do', ru: 'Что сделать' },
          options: [
            { value: 'up', label: { en: 'Brighter', ru: 'Ярче' } },
            { value: 'down', label: { en: 'Dimmer', ru: 'Тише' } },
            { value: 'set', label: { en: 'Set to', ru: 'Задать' } },
          ],
        },
        {
          name: 'value',
          type: 'number',
          default: 25,
          min: 1,
          max: 255,
          label: { en: 'How much', ru: 'Сколько' },
          description: {
            en: 'The step, or the value to set; the lamp holds 1 to 255',
            ru: 'Шаг или значение; лампа понимает от 1 до 255',
          },
        },
        lampParam(),
      ],
    },
    {
      type: 'rt.gyverlamp.speed',
      icon: 'next',
      label: { en: 'Speed', ru: 'Скорость' },
      description: {
        en: 'Of the current effect, like brightness',
        ru: 'Текущего эффекта, как и яркость',
      },
      params: [
        {
          name: 'mode',
          type: 'select',
          default: 'up',
          label: { en: 'What to do', ru: 'Что сделать' },
          options: [
            { value: 'up', label: { en: 'Faster', ru: 'Быстрее' } },
            { value: 'down', label: { en: 'Slower', ru: 'Медленнее' } },
            { value: 'set', label: { en: 'Set to', ru: 'Задать' } },
          ],
        },
        {
          name: 'value',
          type: 'number',
          default: 25,
          min: 1,
          max: 255,
          label: { en: 'How much', ru: 'Сколько' },
        },
        lampParam(),
      ],
    },
    {
      type: 'rt.gyverlamp.scale',
      icon: 'variable',
      label: { en: 'Scale', ru: 'Масштаб' },
      description: {
        en: 'The third knob of an effect. Each effect reads it its own way — size here, colour or variant there',
        ru: 'Третья ручка эффекта. Каждый эффект понимает её по-своему: где-то размер, где-то цвет или вариант',
      },
      params: [
        {
          name: 'mode',
          type: 'select',
          default: 'up',
          label: { en: 'What to do', ru: 'Что сделать' },
          options: [
            { value: 'up', label: { en: 'More', ru: 'Больше' } },
            { value: 'down', label: { en: 'Less', ru: 'Меньше' } },
            { value: 'set', label: { en: 'Set to', ru: 'Задать' } },
          ],
        },
        {
          name: 'value',
          type: 'number',
          default: 10,
          min: 1,
          max: 255,
          label: { en: 'How much', ru: 'Сколько' },
          description: {
            en: 'Most effects use 1 to 100; a few read the whole 1 to 255',
            ru: 'Большинству эффектов хватает 1–100; некоторые понимают весь диапазон до 255',
          },
        },
        lampParam(),
      ],
    },
  ],

  presets: [
    {
      name: 'power',
      label: { en: 'Power', ru: 'Питание' },
      description: {
        en: 'Turns the lamp on and off, and shows which it is',
        ru: 'Включает и выключает лампу и показывает, горит ли она',
      },
      button: {
        stateFrom: 'rt.gyverlamp.on',
        states: [
          {
            id: 'off',
            when: false,
            visual: {
              background: '#22303c',
              icon: { source: 'plugin:rt.gyverlamp/power.svg' },
            },
            actions: { press: [{ type: 'rt.gyverlamp.power', params: { mode: 'toggle' } }] },
          },
          {
            id: 'on',
            when: true,
            visual: {
              background: '#2f6f4f',
              icon: { source: 'plugin:rt.gyverlamp/power.svg' },
            },
            actions: { press: [{ type: 'rt.gyverlamp.power', params: { mode: 'toggle' } }] },
          },
        ],
      },
    },
    {
      name: 'effect',
      label: { en: 'Effect, by name', ru: 'Эффект, по имени' },
      description: {
        en: 'Says which effect is burning; pressing it moves to the next',
        ru: 'Показывает, какой эффект горит; нажатие включает следующий',
      },
      button: {
        states: [
          {
            id: 'default',
            visual: {
              background: '#1a1c22',
              label: { text: '{{rt.gyverlamp.effect-name}}', fontSize: 12 },
            },
            actions: { press: [{ type: 'rt.gyverlamp.effect', params: { mode: 'next' } }] },
          },
        ],
      },
    },
    {
      name: 'brighter',
      label: { en: 'Brighter', ru: 'Ярче' },
      button: {
        states: [
          {
            id: 'default',
            visual: {
              background: '#22303c',
              label: { text: 'Ярче\n{{rt.gyverlamp.brightness}}', fontSize: 13 },
            },
            actions: {
              press: [{ type: 'rt.gyverlamp.brightness', params: { mode: 'up', value: 25 } }],
            },
          },
        ],
      },
    },
    {
      name: 'dimmer',
      label: { en: 'Dimmer', ru: 'Тише' },
      button: {
        states: [
          {
            id: 'default',
            visual: {
              background: '#22303c',
              label: { text: 'Тише\n{{rt.gyverlamp.brightness}}', fontSize: 13 },
            },
            actions: {
              press: [{ type: 'rt.gyverlamp.brightness', params: { mode: 'down', value: 25 } }],
            },
          },
        ],
      },
    },
  ],
};

/** Which lamp a variable is about; left out, it is the one settings chose. */
function lampArgument() {
  return {
    label: { en: 'Lamp', ru: 'Лампа' },
    description: {
      en: 'Leave empty for the one chosen in settings',
      ru: 'Оставьте пустой для той, что выбрана в настройках',
    },
    optionsFrom: 'lamps',
  };
}

/** The lamp a key drives, offered the same way everywhere it appears. */
function lampParam() {
  return {
    name: 'lamp',
    type: 'select' as const,
    required: false,
    label: { en: 'Lamp', ru: 'Лампа' },
    optionsFrom: 'lamps',
    description: {
      en: 'Leave empty for the one chosen in settings',
      ru: 'Оставьте пустой для той, что выбрана в настройках',
    },
  };
}

/** A lamp this plugin has met, and everything read from it so far. */
interface KnownLamp {
  readonly address: LampAddress;
  readonly name?: string;
  /** Effect names by number, the lamp's own; absent until LIST has answered. */
  readonly effects?: readonly string[];
}

export interface GyverLampPluginOptions {
  /** Shortened by tests, which have a lamp one loopback away. */
  readonly pollMs?: number;
  readonly idlePollMs?: number;
  readonly requestTimeoutMs?: number;
  /** Overridden by tests, which have no subnet worth sweeping. */
  readonly sweep?: () => Promise<DiscoveredLamp[]>;
}

export class GyverLampPlugin implements Plugin {
  private host?: PluginHost;
  private readonly socket = new LampSocket();
  private readonly known = new Map<string, KnownLamp>();
  private readonly states = new Map<string, LampState>();
  private readonly misses = new Map<string, number>();
  /** One LIST attempt per lamp per session; a rescan starts the count over. */
  private readonly listAsked = new Set<string>();
  private ticker?: Ticker;
  private watchedCount = 0;

  /** True while this plugin is writing its own settings; see `onSettingsChanged`. */
  private writing = false;

  constructor(private readonly options: GyverLampPluginOptions = {}) {}

  start(host: PluginHost): void {
    this.host = host;

    host.provideOptions('lamps', async () =>
      [...this.known.values()]
        .sort((one, other) => describeLamp(one).localeCompare(describeLamp(other)))
        .map<ParamOption>((lamp) => {
          const key = formatAddress(lamp.address);
          const away = (this.misses.get(key) ?? 0) >= MISS_LIMIT;
          return {
            value: key,
            label: away
              ? { en: `${describeLamp(lamp)} (not answering)`, ru: `${describeLamp(lamp)} (не отвечает)` }
              : { en: describeLamp(lamp) },
          };
        }),
    );

    host.provideOptions('effects', async (params) => {
      const lamp = this.lampFor(String(params['lamp'] ?? ''));
      const effects = lamp ? this.effectsOf(lamp) : FALLBACK_EFFECTS;
      return effects.map<ParamOption>((name, index) => ({
        value: String(index),
        label: { en: `${index}. ${name}` },
      }));
    });

    host.onSettingsChanged(() => {
      if (this.writing) return;
      this.restart();
    });

    /*
     * The poll rides the host's schedule, not a timer of this plugin's own —
     * stopping the plugin then means stopping. The cadence follows whether
     * anything on screen actually reads a lamp variable: the datagrams are
     * three bytes, but a lamp nobody is looking at deserves quiet too.
     */
    this.ticker = host.update(this.options.pollMs ?? POLL_MS, () => this.poll());

    host.onWatched((keys) => {
      this.watchedCount = keys.length;
      this.pace();
    });

    this.restart();
  }

  stop(): void {
    this.ticker?.stop();
    this.ticker = undefined;
    this.socket.close();
    this.states.clear();
    this.misses.clear();
  }

  // --- setting up ---------------------------------------------------------

  /**
   * Finds the lamps: the sweep for whatever answers, the settings for
   * whatever was typed, and the old list for whatever is merely switched
   * off right now. A union rather than a replacement — a lamp that missed
   * one scan because it was unplugged should not take its keys with it.
   */
  async rescan(): Promise<void> {
    const host = this.require();
    host.setStatus('connecting', { en: 'Looking for lamps', ru: 'Ищем лампы' });

    const found = await (this.options.sweep ?? discoverLamps)();

    for (const lamp of found) {
      const address: LampAddress = { host: lamp.host, port: lamp.port };
      const key = formatAddress(address);
      const kept = this.known.get(key);
      this.known.set(key, {
        address,
        ...(lamp.name ? { name: lamp.name } : kept?.name ? { name: kept.name } : {}),
        ...(kept?.effects ? { effects: kept.effects } : {}),
      });
    }

    this.mergeManual();
    this.listAsked.clear();
    await this.remember();

    /*
     * Somebody who has not chosen gets the first one chosen for them,
     * written into the setting so the window says which lamp the bare
     * variables are about.
     */
    const first = [...this.known.keys()].sort()[0];
    if (String(host.settings()['lamp'] ?? '') === '' && first) {
      await this.write('lamp', first);
    }

    host.log('info', `GyverLamp: ${found.length} lamp(s) answered, ${this.known.size} known`);

    // The scan may be the moment the very first lamp arrives, and the poll's
    // schedule was paused while there was nothing to ask. Written before it
    // was called: the settings writes above go out with `writing` held, so
    // no restart runs pace() for us.
    this.pace();
    await this.poll();
  }

  // --- running ------------------------------------------------------------

  private restart(): void {
    const host = this.host;
    if (!host) return;

    this.known.clear();
    for (const lamp of readKnown(host.settings()['lamps'])) {
      this.known.set(formatAddress(lamp.address), lamp);
    }
    this.mergeManual();

    if (host.settings()['enabled'] !== true) {
      this.clearVariables();
      host.setStatus('off');
      this.pace();
      return;
    }

    if (this.known.size === 0) {
      host.setStatus('error', {
        en: 'No lamps yet — press Find lamps',
        ru: 'Ламп пока нет — нажмите «Найти лампы»',
      });
      this.pace();
      return;
    }

    host.setStatus('connecting');
    this.pace();
    void this.poll();
  }

  /** Lamps typed into the settings, laid over whatever else is known. */
  private mergeManual(): void {
    const manual = String(this.host?.settings()['manual'] ?? '');

    for (const piece of manual.split(',')) {
      if (piece.trim() === '') continue;

      const address = parseAddress(piece);
      if (!address) {
        this.host?.log('warn', `GyverLamp: '${piece.trim()}' is not an address`);
        continue;
      }

      const key = formatAddress(address);
      if (!this.known.has(key)) this.known.set(key, { address });
    }
  }

  private enabled(): boolean {
    return this.host?.settings()['enabled'] === true;
  }

  /** How often to ask, given whether anybody is listening to the answers. */
  private pace(): void {
    if (!this.enabled() || this.known.size === 0) {
      this.ticker?.every(0);
      return;
    }

    this.ticker?.every(
      this.watchedCount > 0
        ? (this.options.pollMs ?? POLL_MS)
        : (this.options.idlePollMs ?? IDLE_POLL_MS),
    );
  }

  /**
   * One GET to every lamp, all of them at once — each has its own queue, so
   * a lamp that is away does not make the others late.
   */
  private async poll(): Promise<void> {
    if (!this.enabled() || this.known.size === 0) return;

    await Promise.all(
      [...this.known.values()].map(async (lamp) => {
        const key = formatAddress(lamp.address);

        try {
          const state = parseCurr(await this.ask(lamp, 'GET', 1));
          if (!state) return;

          this.publish(lamp, state);
          if (!lamp.effects && !this.listAsked.has(key)) void this.fetchEffects(lamp);
        } catch {
          const missed = (this.misses.get(key) ?? 0) + 1;
          this.misses.set(key, missed);
          if (missed === MISS_LIMIT) this.clearLamp(lamp);
        }
      }),
    );

    const anyAnswering = [...this.known.keys()].some(
      (key) => (this.misses.get(key) ?? 0) < MISS_LIMIT && this.states.has(key),
    );
    this.require().setStatus(
      anyAnswering ? 'ready' : 'error',
      anyAnswering ? undefined : { en: 'No lamp is answering', ru: 'Ни одна лампа не отвечает' },
    );
  }

  /**
   * The lamp's own effect list, asked for once and kept in the settings.
   *
   * Three datagrams of ~870 bytes each; forks of the firmware differ in
   * what they burn, so the lamp is the authority and `FALLBACK_EFFECTS` is
   * only for a lamp that never answers.
   */
  private async fetchEffects(lamp: KnownLamp): Promise<void> {
    const key = formatAddress(lamp.address);
    this.listAsked.add(key);

    const collected = new Map<number, string>();
    try {
      for (const line of ['LIST1', 'LIST2', 'LIST3']) {
        // One attempt, not two: commands to this lamp queue behind these,
        // and a firmware that ignores LIST would hold a key press hostage
        // for every retry. A rescan is the second attempt.
        const chunk = parseListChunk(
          await this.ask(lamp, line, 1, this.options.requestTimeoutMs ?? 1800),
        );
        if (chunk) for (const [index, name] of chunk) collected.set(index, name);
      }
    } catch {
      return; // The fallback list stands until a rescan tries again.
    }

    if (collected.size === 0) return;

    const effects = new Array<string>(Math.max(...collected.keys()) + 1).fill('');
    for (const [index, name] of collected) effects[index] = name;

    this.known.set(key, { ...lamp, effects });
    await this.remember();
    this.require().log('info', `GyverLamp: ${describeLamp(lamp)} lists ${collected.size} effects`);
  }

  /** What one lamp is doing, as variables a key can read. */
  private publish(lamp: KnownLamp, state: LampState): void {
    const key = formatAddress(lamp.address);
    this.states.set(key, state);
    this.misses.set(key, 0);

    const values: Record<string, VariableValue> = {
      'rt.gyverlamp.connected': true,
      'rt.gyverlamp.on': state.on,
      'rt.gyverlamp.effect': state.effect,
      'rt.gyverlamp.effect-name': this.effectName(lamp, state.effect),
      'rt.gyverlamp.brightness': state.brightness,
      'rt.gyverlamp.speed': state.speed,
      'rt.gyverlamp.scale': state.scale,
    };

    const chosen = this.chosen();
    const isChosen = chosen && formatAddress(chosen.address) === key;

    const host = this.require();
    for (const [name, value] of Object.entries(values)) {
      host.setFamily(name, key, value);
      if (isChosen) host.setFamily(name, NO_LAMP, value);
    }
    if (isChosen) host.setVariable('rt.gyverlamp.lamp', describeLamp(lamp));
  }

  /** A lamp that stopped answering stops being reported on, at once. */
  private clearLamp(lamp: KnownLamp): void {
    const key = formatAddress(lamp.address);
    this.states.delete(key);

    const chosen = this.chosen();
    const isChosen = chosen && formatAddress(chosen.address) === key;

    const host = this.require();
    for (const name of FAMILIES) {
      host.setFamily(name, key, name === 'rt.gyverlamp.connected' ? false : undefined);
      if (isChosen) {
        host.setFamily(name, NO_LAMP, name === 'rt.gyverlamp.connected' ? false : undefined);
      }
    }
  }

  private clearVariables(): void {
    const host = this.host;
    if (!host) return;

    host.setVariable('rt.gyverlamp.lamp', undefined);
    for (const name of FAMILIES) {
      host.setFamily(name, NO_LAMP, undefined);
      for (const key of this.known.keys()) host.setFamily(name, key, undefined);
    }
    this.states.clear();
    this.misses.clear();
  }

  // --- acting -------------------------------------------------------------

  handlers(): Record<string, ActionHandler> {
    return {
      'rt.gyverlamp.power': async (params) => {
        const lamp = this.target(params);
        const mode = String(params['mode'] ?? 'toggle');
        const wanted = mode === 'toggle' ? !(await this.stateOf(lamp)).on : mode === 'on';

        await this.command(lamp, wanted ? 'P_ON' : 'P_OFF');
      },

      'rt.gyverlamp.effect': async (params) => {
        const lamp = this.target(params);
        const mode = String(params['mode'] ?? 'set');

        let wanted: number;
        if (mode === 'set') {
          wanted = Number(params['effect']);
          if (!Number.isInteger(wanted) || wanted < 0) {
            throw new Error('Choose an effect for the key');
          }
        } else {
          const state = await this.stateOf(lamp);
          const count = Math.max(1, this.effectsOf(lamp).length);

          if (mode === 'next') wanted = (state.effect + 1) % count;
          else if (mode === 'prev') wanted = (state.effect + count - 1) % count;
          else {
            // Random that never lands where it already is: a key that does
            // nothing one press in eighty-seven reads as a broken key.
            do {
              wanted = Math.floor(Math.random() * count);
            } while (count > 1 && wanted === state.effect);
          }
        }

        await this.command(lamp, `EFF${wanted}`);
      },

      'rt.gyverlamp.brightness': async (params) => {
        await this.level(params, 'BRI', (state) => state.brightness);
      },

      'rt.gyverlamp.speed': async (params) => {
        await this.level(params, 'SPD', (state) => state.speed);
      },

      'rt.gyverlamp.scale': async (params) => {
        await this.level(params, 'SCA', (state) => state.scale);
      },
    };
  }

  /** Brightness, speed and scale are the same action with a different letter. */
  private async level(
    params: Readonly<Record<string, unknown>>,
    command: 'BRI' | 'SPD' | 'SCA',
    read: (state: LampState) => number,
  ): Promise<void> {
    const lamp = this.target(params);
    const mode = String(params['mode'] ?? 'up');
    const value = clamp(numberParam(params, 'value', 25), 1, 255);

    const wanted =
      mode === 'set'
        ? value
        : clamp(read(await this.stateOf(lamp)) + (mode === 'down' ? -value : value), 1, 255);

    await this.command(lamp, `${command}${wanted}`);
  }

  /**
   * Sends one command and publishes whatever the lamp answers.
   *
   * The reply is the point: after `EFF` the lamp reports the new effect's
   * *stored* brightness and speed, and mirroring that reply is what keeps a
   * key honest about values this program never sent.
   */
  private async command(lamp: KnownLamp, command: string): Promise<LampState> {
    const state = parseCurr(await this.ask(lamp, command, 2));
    if (!state) throw new Error(`${describeLamp(lamp)} gave a reply that is not a state`);

    this.publish(lamp, state);
    return state;
  }

  /** The last known state, or one fetched for the occasion. */
  private async stateOf(lamp: KnownLamp): Promise<LampState> {
    const kept = this.states.get(formatAddress(lamp.address));
    if (kept) return kept;

    const state = parseCurr(await this.ask(lamp, 'GET', 2));
    if (!state) throw new Error(`${describeLamp(lamp)} gave a reply that is not a state`);

    this.publish(lamp, state);
    return state;
  }

  private ask(lamp: KnownLamp, command: string, attempts: number, timeoutMs?: number): Promise<string> {
    return this.socket.request(lamp.address, command, {
      attempts,
      timeoutMs: timeoutMs ?? this.options.requestTimeoutMs ?? 1200,
    });
  }

  /** Which lamp a key means, or a refusal that says how to fix it. */
  private target(params: Readonly<Record<string, unknown>>): KnownLamp {
    const lamp = this.lampFor(String(params['lamp'] ?? ''));
    if (!lamp) throw new Error('No lamp chosen — pick one in the plugin settings');
    return lamp;
  }

  /** The named lamp, or the one settings chose, or the only one there is. */
  private lampFor(key: string): KnownLamp | undefined {
    if (key !== '') return this.known.get(key);
    return this.chosen();
  }

  private chosen(): KnownLamp | undefined {
    const wanted = String(this.host?.settings()['lamp'] ?? '');
    const named = wanted === '' ? undefined : this.known.get(wanted);
    if (named) return named;

    const first = [...this.known.keys()].sort()[0];
    return first === undefined ? undefined : this.known.get(first);
  }

  private effectsOf(lamp: KnownLamp): readonly string[] {
    return lamp.effects && lamp.effects.length > 0 ? lamp.effects : FALLBACK_EFFECTS;
  }

  /** A name for an effect the list does not cover is its number, plainly. */
  private effectName(lamp: KnownLamp, index: number): string {
    const name = this.effectsOf(lamp)[index];
    return name === undefined || name === '' ? String(index) : name;
  }

  private async remember(): Promise<void> {
    const lamps = [...this.known.values()].map((lamp) => ({
      host: lamp.address.host,
      port: lamp.address.port,
      ...(lamp.name ? { name: lamp.name } : {}),
      ...(lamp.effects ? { effects: lamp.effects } : {}),
    }));

    await this.write('lamps', JSON.stringify(lamps));
  }

  /**
   * Stores a setting this plugin worked out, without hearing about it
   * again: saving notifies every listener, this one included, and reacting
   * would restart the plugin in the middle of its own scan.
   */
  private async write(name: string, value: VariableValue): Promise<void> {
    this.writing = true;
    try {
      await this.require().remember(name, value);
    } finally {
      this.writing = false;
    }
  }

  private require(): PluginHost {
    const host = this.host;
    if (!host) throw new Error('The plugin is not running');
    return host;
  }
}

/** What a lamp is called in a list: its name when it sent one, its address else. */
function describeLamp(lamp: KnownLamp): string {
  return lamp.name ?? formatAddress(lamp.address);
}

function clamp(value: number, low: number, high: number): number {
  return Math.max(low, Math.min(high, Math.round(value)));
}

/** The remembered lamp list, read defensively: it is a string on disk. */
function readKnown(value: unknown): KnownLamp[] {
  if (typeof value !== 'string' || value.trim() === '') return [];

  try {
    const parsed: unknown = JSON.parse(value);
    if (!Array.isArray(parsed)) return [];

    const lamps: KnownLamp[] = [];
    for (const entry of parsed) {
      if (typeof entry !== 'object' || entry === null) continue;

      const { host, port, name, effects } = entry as Record<string, unknown>;
      if (typeof host !== 'string' || typeof port !== 'number') continue;

      lamps.push({
        address: { host, port },
        ...(typeof name === 'string' ? { name } : {}),
        ...(Array.isArray(effects) && effects.every((one) => typeof one === 'string')
          ? { effects: effects as string[] }
          : {}),
      });
    }
    return lamps;
  } catch {
    return [];
  }
}

/**
 * Builds the running parts.
 *
 * Exported apart from the default so the tests can pass options — short
 * timeouts, a stand-in sweep. The host always takes the defaults.
 */
export function activateWith(options: GyverLampPluginOptions = {}): PluginActivation {
  const plugin = new GyverLampPlugin(options);

  return {
    plugin,
    handlers: plugin.handlers(),
    commands: {
      rescan: () => plugin.rescan(),
    },
  };
}

export default definePlugin({ manifest: gyverLampManifest, activate: () => activateWith() });
