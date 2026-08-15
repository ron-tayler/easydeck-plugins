import { PLUGIN_API_VERSION,
  definePlugin, numberParam, stringParam } from '@easydeck/plugin-sdk';
import type {
  PluginActivation,
  ActionHandler,
  ParamOption,
  Plugin,
  PluginHost,
  PluginManifest,
  SurfaceFrame,
  SurfaceRequest,
  VariableValue,
} from '@easydeck/plugin-sdk';

import { GlagolConnection } from './glagol-connection.js';
import type { SpeakerState } from './glagol-connection.js';
import { discoverSpeakers } from './glagol-discovery.js';
import { accountName, beginLogin, cloudSpeakers, deviceToken, musicToken } from './yandex-account.js';

/**
 * Yandex speakers, driven over the local network.
 *
 * The music a person has on in the room the deck sits in, on the keys beside
 * the ones that switch scenes — and, because the same channel carries any
 * phrase at all, the lights and the kettle with them.
 *
 * Three things shape this plugin.
 *
 * **The cloud is only for setting up.** Signing in, learning what the speakers
 * are called and which rooms they stand in: all of that happens once and is
 * kept. Pressing a key afterwards talks to a speaker in the flat over a socket
 * this program holds open, and nothing on a key's path leaves the house.
 *
 * **Every speaker is connected, not just the chosen one.** The state costs a
 * few messages a minute per speaker while nothing is playing, and holding them
 * all means a key aimed at the kitchen works the moment it is pressed rather
 * than after a connection is made. See `connectAll`.
 *
 * **A key must not wait to be told it worked.** The speaker sends its state on
 * its own beat, about once a second, so a key that waited for confirmation
 * would lag by up to that. Volume and playback are therefore published as soon
 * as they are commanded, and corrected by the next state if the speaker
 * disagreed.
 */

export const YANDEX_PLUGIN_ID = 'ed.yandex';

/**
 * What a cover is fetched at.
 *
 * The address carries `%%` where a size goes, and Yandex will serve most of
 * them. Measured: 10 KB at 200 and 29 KB at 400, both under a second. A key is
 * smaller than either, so the larger one is asked for only when the widget
 * covers more than a single key.
 */
const COVER_SMALL = '200x200';
const COVER_LARGE = '400x400';

/** Nothing playing has no cover, and asking again every repaint would be rude. */
const COVER_MISSING = '';

/**
 * The argument that means "whichever speaker the settings chose".
 *
 * An empty one, because `variableKey` gives a family with no argument its bare
 * name — so this is what makes `{{yandex.title}}` a key somebody can write.
 */
const NO_SPEAKER = '';

/** Everything published per speaker, for clearing it all again. */
const FAMILIES = [
  'ed.yandex.connected',
  'ed.yandex.playing',
  'ed.yandex.title',
  'ed.yandex.artist',
  'ed.yandex.volume',
  'ed.yandex.progress',
  'ed.yandex.progress-time',
  'ed.yandex.duration',
  'ed.yandex.duration-time',
  'ed.yandex.source',
] as const;

export const yandexManifest: PluginManifest = {
  id: YANDEX_PLUGIN_ID,
  name: { en: 'Yandex Station', ru: 'Яндекс Станция' },
  description: {
    en: 'Music, volume and Alice on Yandex speakers around the house',
    ru: 'Музыка, громкость и Алиса на Яндекс Станциях по всему дому',
  },
  version: '1.0.0',
  apiVersion: PLUGIN_API_VERSION,

  settings: [
    {
      // Off until asked, like OBS and VTube Studio: a machine with no Yandex
      // account on it should not be listening for speakers on the network.
      name: 'enabled',
      type: 'boolean',
      label: { en: 'Connect to Yandex speakers', ru: 'Подключаться к Яндекс Станциям' },
      default: false,
      required: false,
    },
    {
      name: 'speaker',
      type: 'select',
      required: false,
      label: { en: 'Speaker', ru: 'Колонка' },
      optionsFrom: 'speakers',
      description: {
        en: 'The one keys drive unless they name another. Press Find speakers below to fill this in',
        ru: 'На неё работают клавиши, если в них не выбрана другая. Список заполняет кнопка «Найти колонки»',
      },
      emptyNote: {
        en: 'No speakers found yet — sign in, then press Find speakers',
        ru: 'Колонок пока нет — войдите и нажмите «Найти колонки»',
      },
    },
    {
      /*
       * Granted by a phone, not typed by anybody.
       *
       * Kept as an ordinary secret setting so it is sealed like every other,
       * and so somebody who moved machines can see at a glance whether this
       * one is signed in. The plugin writes it itself through `remember`.
       */
      name: 'token',
      type: 'string',
      secret: true,
      required: false,
      label: { en: 'Yandex account', ru: 'Аккаунт Яндекса' },
      description: {
        en: 'Filled in by Sign in below. Your password is never asked for or stored',
        ru: 'Заполняется кнопкой «Войти». Пароль не спрашивается и не хранится',
      },
    },
    {
      /*
       * The speakers this plugin has met, with the key each one wants.
       *
       * Written by the plugin and read by nobody else. It is here rather than
       * in a file of its own because `remember` is how a plugin keeps anything,
       * and sealed because a device token opens somebody's speaker.
       *
       * Keeping it matters: the endpoint that grants these answers 429 to a
       * program that asks too often, so fetching them afresh on every start
       * would eventually lock the plugin out of its own speakers.
       */
      name: 'devices',
      type: 'string',
      secret: true,
      internal: true,
      required: false,
      label: { en: 'Known speakers', ru: 'Известные колонки' },
    },
  ],

  commands: [
    {
      name: 'login',
      label: { en: 'Sign in', ru: 'Войти' },
      icon: 'link',
      description: {
        en: 'Opens a Yandex page to confirm on your phone. No password is entered here',
        ru: 'Откроет страницу Яндекса для подтверждения с телефона. Пароль здесь не вводится',
      },
    },
    {
      name: 'rescan',
      label: { en: 'Find speakers', ru: 'Найти колонки' },
      icon: 'globe',
      description: {
        en: 'Looks for speakers on the network and reads their names and rooms',
        ru: 'Ищет колонки в сети и читает их названия и комнаты',
      },
    },
    {
      name: 'signout',
      label: { en: 'Sign out', ru: 'Выйти' },
      icon: 'stop',
      confirm: {
        en: 'Forget this Yandex account and every speaker found with it?',
        ru: 'Забыть аккаунт Яндекса и все найденные колонки?',
      },
    },
  ],

  /*
   * Every one of these is a family, and the argument is a speaker.
   *
   * A house has four of them in four rooms, and a deck that could only ever
   * be about one is a deck that cannot say "the kitchen is playing, the office
   * is not" — which is most of what several speakers are for.
   *
   * The argument may also be left out, and then the variable is about whichever
   * speaker the settings chose: `{{yandex.title}}` beside
   * `{{yandex.title(M00K2R300K5PKR)}}`. That is not a special case in the
   * engine — `variableKey` gives a family with no argument its bare name — so
   * one declaration serves both, and a profile written for one speaker keeps
   * working when a second arrives.
   */
  variables: [
    {
      name: 'ed.yandex.connected',
      type: 'boolean',
      label: { en: 'Speaker connected', ru: 'Колонка на связи' },
      initial: false,
      argument: speakerArgument(),
    },
    {
      name: 'ed.yandex.speaker',
      type: 'string',
      label: { en: 'Chosen speaker', ru: 'Выбранная колонка' },
      description: {
        en: 'The name of the speaker the settings chose, which the variables with no argument are about',
        ru: 'Название колонки, выбранной в настройках, — о ней говорят переменные без аргумента',
      },
    },
    {
      name: 'ed.yandex.playing',
      type: 'boolean',
      label: { en: 'Playing', ru: 'Играет' },
      initial: false,
      argument: speakerArgument(),
    },
    {
      name: 'ed.yandex.title',
      type: 'string',
      label: { en: 'Track', ru: 'Трек' },
      argument: speakerArgument(),
    },
    {
      name: 'ed.yandex.artist',
      type: 'string',
      label: { en: 'Artist', ru: 'Исполнитель' },
      argument: speakerArgument(),
    },
    {
      name: 'ed.yandex.volume',
      type: 'number',
      label: { en: 'Volume, %', ru: 'Громкость, %' },
      description: {
        en: 'Nought to a hundred, as a person reads it rather than as the speaker sends it',
        ru: 'От нуля до ста, как читает человек, а не как присылает колонка',
      },
      argument: speakerArgument(),
    },
    {
      name: 'ed.yandex.progress',
      type: 'number',
      label: { en: 'Position, s', ru: 'Позиция, с' },
      argument: speakerArgument(),
    },
    {
      name: 'ed.yandex.duration',
      type: 'number',
      label: { en: 'Length, s', ru: 'Длительность, с' },
      argument: speakerArgument(),
    },
    {
      /*
       * The same position as `yandex.progress`, written the way a clock is.
       *
       * Separate rather than a formatting option on the other one: a label is
       * a template, and a template can only substitute a value — there is
       * nowhere in `{{yandex.progress}}` to say "as minutes and seconds". The
       * number stays because a gauge needs a number to be a fraction of.
       */
      name: 'ed.yandex.progress-time',
      type: 'string',
      label: { en: 'Position, as a clock', ru: 'Позиция, часами' },
      description: {
        en: '3:07, and 1:02:30 once something runs past an hour',
        ru: '3:07, а для длинного — 1:02:30',
      },
      argument: speakerArgument(),
    },
    {
      name: 'ed.yandex.duration-time',
      type: 'string',
      label: { en: 'Length, as a clock', ru: 'Длительность, часами' },
      description: {
        en: 'The other half of {{yandex.progress-time}} / {{yandex.duration-time}}',
        ru: 'Вторая половина подписи {{yandex.progress-time}} / {{yandex.duration-time}}',
      },
      argument: speakerArgument(),
    },
    {
      name: 'ed.yandex.source',
      type: 'string',
      label: { en: 'What is on', ru: 'Что включено' },
      description: {
        en: 'Playlist, Radio, Album — a radio has no track list, so shuffle and repeat do nothing on one',
        ru: 'Playlist, Radio, Album — у радио нет списка треков, поэтому перемешивание и повтор на нём не работают',
      },
      argument: speakerArgument(),
    },
  ],

  surfaces: [
    {
      /*
       * The one thing about music that a label cannot say.
       *
       * A title and an artist are text and go on a key through its label
       * already. The cover is the reason this exists — and it is also the
       * reason the widget is worth making bigger than one key, which is the
       * only way an album cover reads as one.
       */
      type: 'ed.yandex.cover',
      label: { en: 'Album art', ru: 'Обложка' },
      description: {
        en: 'The cover of whatever is playing. Looks best across two keys by two',
        ru: 'Обложка того, что играет. Лучше всего смотрится на квадрате два на два',
      },
      icon: 'page',
      params: [
        {
          name: 'speaker',
          type: 'select',
          required: false,
          label: { en: 'Speaker', ru: 'Колонка' },
          optionsFrom: 'speakers',
          description: {
            en: 'Leave empty for the one chosen in settings',
            ru: 'Оставьте пустым для той, что выбрана в настройках',
          },
        },
      ],
    },
  ],

  actions: [
    {
      type: 'ed.yandex.play-pause',
      icon: 'toggle',
      label: { en: 'Play or pause', ru: 'Играть или пауза' },
      params: [
        {
          name: 'mode',
          type: 'select',
          default: 'toggle',
          label: { en: 'What to do', ru: 'Что сделать' },
          options: [
            { value: 'toggle', label: { en: 'Toggle', ru: 'Переключить' } },
            { value: 'play', label: { en: 'Play', ru: 'Играть' } },
            { value: 'pause', label: { en: 'Pause', ru: 'Пауза' } },
          ],
        },
        speakerParam(),
      ],
    },
    {
      type: 'ed.yandex.next-track',
      icon: 'next',
      label: { en: 'Next track', ru: 'Следующий трек' },
      params: [speakerParam()],
    },
    {
      type: 'ed.yandex.prev-track',
      icon: 'previous',
      label: { en: 'Previous track', ru: 'Предыдущий трек' },
      params: [speakerParam()],
    },
    {
      type: 'ed.yandex.rewind',
      icon: 'clock',
      label: { en: 'Seek', ru: 'Перемотать' },
      params: [
        {
          name: 'mode',
          type: 'select',
          default: 'forward',
          label: { en: 'Which way', ru: 'Куда' },
          options: [
            { value: 'forward', label: { en: 'Forward', ru: 'Вперёд' } },
            { value: 'back', label: { en: 'Back', ru: 'Назад' } },
            { value: 'to', label: { en: 'To position', ru: 'На позицию' } },
          ],
        },
        {
          name: 'seconds',
          type: 'number',
          default: 15,
          min: 0,
          max: 3600,
          label: { en: 'Seconds', ru: 'Секунды' },
        },
        speakerParam(),
      ],
    },
    {
      type: 'ed.yandex.volume',
      icon: 'increment',
      label: { en: 'Volume', ru: 'Громкость' },
      params: [
        {
          name: 'mode',
          type: 'select',
          default: 'up',
          label: { en: 'What to do', ru: 'Что сделать' },
          options: [
            { value: 'up', label: { en: 'Louder', ru: 'Громче' } },
            { value: 'down', label: { en: 'Quieter', ru: 'Тише' } },
            { value: 'set', label: { en: 'Set to', ru: 'Задать' } },
          ],
        },
        {
          name: 'value',
          type: 'number',
          default: 10,
          min: 0,
          max: 100,
          label: { en: 'Per cent', ru: 'Проценты' },
          description: {
            en: 'How much to move it by, or what to set it to',
            ru: 'На сколько изменить или какую выставить',
          },
        },
        speakerParam(),
      ],
    },
    {
      type: 'ed.yandex.repeat',
      icon: 'cycle',
      label: { en: 'Repeat', ru: 'Повтор' },
      description: {
        en: 'Does nothing while a radio station is on: a radio has no track list to repeat',
        ru: 'Ничего не делает на радио: у радио нет списка треков, который можно повторять',
      },
      params: [
        {
          name: 'mode',
          type: 'select',
          default: 'cycle',
          label: { en: 'Mode', ru: 'Режим' },
          options: [
            { value: 'cycle', label: { en: 'Next mode', ru: 'Следующий режим' } },
            { value: 'None', label: { en: 'Off', ru: 'Выключить' } },
            { value: 'One', label: { en: 'One track', ru: 'Один трек' } },
            { value: 'All', label: { en: 'Everything', ru: 'Всё подряд' } },
          ],
        },
        speakerParam(),
      ],
    },
    {
      type: 'ed.yandex.shuffle',
      icon: 'state',
      label: { en: 'Shuffle', ru: 'Перемешать' },
      description: {
        en: 'Does nothing while a radio station is on',
        ru: 'Ничего не делает на радио',
      },
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
        speakerParam(),
      ],
    },
    {
      /*
       * A phrase Alice carries out, which is the widest door in this plugin.
       *
       * Anything the speaker can be told out loud can be put on a key: the
       * lights in one room, a timer, the kettle. The smart home is already set
       * up in the Yandex app, and this borrows all of it without touching the
       * smart-home API at all.
       */
      type: 'ed.yandex.command',
      icon: 'text',
      label: { en: 'Tell Alice', ru: 'Команда Алисе' },
      description: {
        en: 'Anything you would say out loud: "turn on the desk lamp", "set a timer for ten minutes"',
        ru: 'Что угодно, что вы сказали бы вслух: «включи ночник», «поставь таймер на десять минут»',
      },
      params: [
        {
          name: 'text',
          type: 'string',
          label: { en: 'Command', ru: 'Команда' },
          placeholder: { en: 'turn on the desk lamp', ru: 'включи ночник' },
        },
        speakerParam(),
      ],
    },
    {
      type: 'ed.yandex.say',
      icon: 'speaker',
      label: { en: 'Say out loud', ru: 'Сказать вслух' },
      description: {
        en: 'The speaker reads the text out. Alice does not answer — this is not a command',
        ru: 'Колонка произносит текст. Алиса не отвечает — это не команда',
      },
      params: [
        {
          name: 'text',
          type: 'string',
          label: { en: 'Words', ru: 'Текст' },
          placeholder: { en: 'the stream starts in a minute', ru: 'стрим начинается через минуту' },
        },
        speakerParam(),
      ],
    },
  ],

  presets: [
    {
      name: 'cover',
      label: { en: 'Album art', ru: 'Обложка' },
      description: {
        en: 'Shows what is playing and pauses it when pressed. Stretch it over two keys by two',
        ru: 'Показывает, что играет, и ставит на паузу. Растяните на квадрат два на два',
      },
      button: {
        stateFrom: 'ed.yandex.playing',
        states: [
          {
            id: 'paused',
            when: false,
            visual: {
              background: '#1a1c22',
              surface: { type: 'ed.yandex.cover' },
              label: { text: '{{yandex.title}}', fontSize: 11 },
            },
            actions: { press: [{ type: 'ed.yandex.play-pause', params: { mode: 'toggle' } }] },
          },
          {
            id: 'playing',
            when: true,
            visual: {
              background: '#1a1c22',
              surface: { type: 'ed.yandex.cover' },
            },
            actions: { press: [{ type: 'ed.yandex.play-pause', params: { mode: 'toggle' } }] },
          },
        ],
      },
    },
    {
      name: 'play-pause',
      label: { en: 'Play / pause', ru: 'Играть / пауза' },
      button: {
        stateFrom: 'ed.yandex.playing',
        states: [
          {
            id: 'paused',
            when: false,
            visual: { background: '#22303c', icon: { source: 'plugin:ed.yandex/play.svg' } },
            actions: { press: [{ type: 'ed.yandex.play-pause', params: { mode: 'toggle' } }] },
          },
          {
            id: 'playing',
            when: true,
            visual: { background: '#2f6f4f', icon: { source: 'plugin:ed.yandex/pause.svg' } },
            actions: { press: [{ type: 'ed.yandex.play-pause', params: { mode: 'toggle' } }] },
          },
        ],
      },
    },
    {
      name: 'now-playing',
      label: { en: 'What is playing', ru: 'Что играет' },
      description: {
        en: 'The track and the artist, as text',
        ru: 'Трек и исполнитель, текстом',
      },
      button: {
        states: [
          {
            id: 'default',
            visual: {
              background: '#1a1c22',
              label: { text: '{{yandex.title}}\n{{yandex.artist}}', fontSize: 11 },
            },
          },
        ],
      },
    },
  ],
};

/** Which speaker a variable is about; left out, it is the one settings chose. */
function speakerArgument() {
  return {
    label: { en: 'Speaker', ru: 'Колонка' },
    description: {
      en: 'Leave empty for the one chosen in settings',
      ru: 'Оставьте пустым для той, что выбрана в настройках',
    },
    optionsFrom: 'speakers',
  };
}

/** The speaker a key drives, offered the same way everywhere it appears. */
function speakerParam() {
  return {
    name: 'speaker',
    type: 'select' as const,
    required: false,
    label: { en: 'Speaker', ru: 'Колонка' },
    optionsFrom: 'speakers',
    description: {
      en: 'Leave empty for the one chosen in settings',
      ru: 'Оставьте пустым для той, что выбрана в настройках',
    },
  };
}

/** A speaker this plugin has met, and everything it needs to reach it again. */
interface KnownSpeaker {
  readonly deviceId: string;
  readonly platform: string;
  readonly name: string;
  readonly room?: string;
  readonly host?: string;
  readonly port?: number;
  /** The key this speaker's own socket checks. Kept; see the `devices` setting. */
  readonly token?: string;
  /** Seen on the network but not in this account — a neighbour's, a flatmate's. */
  readonly foreign?: boolean;
}

export interface YandexPluginOptions {
  readonly retryDelaysMs?: readonly number[];
  /** Overridden by tests, which have no speakers and no account. */
  readonly discover?: typeof discoverSpeakers;
  /** Off only in tests, where the stand-in speaker is a plain socket. */
  readonly secure?: boolean;
}

export class YandexPlugin implements Plugin {
  private host?: PluginHost;
  private readonly known = new Map<string, KnownSpeaker>();
  private readonly connections = new Map<string, GlagolConnection>();
  private readonly states = new Map<string, SpeakerState>();

  /**
   * Covers already fetched, by the address they came from.
   *
   * A surface is asked for on every repaint, and a repaint happens whenever
   * anything moves anywhere on the page — so fetching here would put a request
   * on the wire every time a clock ticked. What is kept is the picture; the
   * fetch happens once per cover and asks for a redraw when it lands.
   */
  private readonly covers = new Map<string, string>();
  private readonly fetching = new Set<string>();

  /** True while this plugin is writing its own settings; see `onSettingsChanged`. */
  private writing = false;

  constructor(private readonly options: YandexPluginOptions = {}) {}

  start(host: PluginHost): void {
    this.host = host;

    /*
     * The speakers worth offering, which is not the same as the ones known.
     *
     * A speaker on the network that this account never heard of belongs to
     * somebody else — a flatmate, a neighbour — and offering it is offering a
     * key that can only ever fail. One of ours that is merely switched off is
     * offered and said to be off: a key set up now keeps working when it is
     * plugged back in, since what a key stores is the id.
     */
    host.provideOptions('speakers', async () =>
      [...this.known.values()]
        .filter((speaker) => !speaker.foreign)
        .sort((one, other) => describeSpeaker(one).localeCompare(describeSpeaker(other)))
        .map<ParamOption>((speaker) => ({
          value: speaker.deviceId,
          label: speaker.host
            ? { en: describeSpeaker(speaker) }
            : {
                en: `${describeSpeaker(speaker)} (offline)`,
                ru: `${describeSpeaker(speaker)} (не в сети)`,
              },
        })),
    );

    host.provideSurface('ed.yandex.cover', async (request) => this.cover(request));

    host.onSettingsChanged(() => {
      if (this.writing) return;
      this.restart();
    });

    this.restart();
  }

  stop(): void {
    for (const connection of this.connections.values()) connection.stop();
    this.connections.clear();
    this.states.clear();
  }

  // --- setting up ---------------------------------------------------------

  /**
   * Signs in, which happens on a phone rather than here.
   *
   * The link is opened in the user's browser: on a machine already signed in
   * to Yandex that is enough on its own, and otherwise the page shows a code
   * to confirm from the Yandex app. Either way no password reaches this
   * program — what comes back is a token.
   */
  async login(): Promise<void> {
    const host = this.require();

    const pending = await beginLogin();
    host.openExternal(pending.link);
    host.setStatus('connecting', {
      en: 'Waiting for you to confirm the sign-in',
      ru: 'Ждём подтверждения входа',
    });

    const xToken = await pending.confirm();
    const music = await musicToken(xToken);

    await this.write('token', xToken);

    // Told who they signed in as, because a household with two accounts is
    // exactly where a silent success is a problem later.
    const who = await accountName(xToken).catch(() => '');
    host.log('info', who ? `Signed in to Yandex as ${who}` : 'Signed in to Yandex');

    await this.rescan(music);
  }

  /**
   * Finds the speakers, and works out what to call them.
   *
   * Both halves are needed and neither is enough. The network says which
   * speakers are reachable and at what address; the account says what they are
   * called and which room each stands in. A speaker the network shows and the
   * account does not is somebody else's — kept in the list, marked, and never
   * connected to.
   */
  async rescan(music?: string): Promise<void> {
    const host = this.require();
    const xToken = String(host.settings()['token'] ?? '');
    if (xToken === '') throw new Error('Sign in first');

    host.setStatus('connecting', { en: 'Looking for speakers', ru: 'Ищем колонки' });

    const key = music ?? (await musicToken(xToken));
    const [onNetwork, inAccount] = await Promise.all([
      (this.options.discover ?? discoverSpeakers)(),
      cloudSpeakers(xToken, key),
    ]);

    const byId = new Map(inAccount.map((speaker) => [speaker.deviceId, speaker]));
    const found = new Map<string, KnownSpeaker>();

    for (const speaker of inAccount) {
      const local = onNetwork.find((candidate) => candidate.deviceId === speaker.deviceId);

      /*
       * Only the things that are actually speakers.
       *
       * The account's device list is everything it has ever spoken to: the
       * smart-home hub, the TV module, and an entry per phone with the Yandex
       * app on it. The smart home says which is which; when it could not be
       * asked, answering on the network is the next best evidence, since
       * nothing but a speaker announces itself over mDNS.
       */
      const isSpeaker = speaker.isSpeaker ?? local !== undefined;
      if (!isSpeaker) continue;

      found.set(speaker.deviceId, {
        ...speaker,
        ...(local ? { host: local.host, port: local.port } : {}),
        // Kept from the last scan: a token does not expire, and the endpoint
        // that grants them dislikes being asked twice.
        ...(this.known.get(speaker.deviceId)?.token
          ? { token: this.known.get(speaker.deviceId)!.token }
          : {}),
      });
    }

    for (const local of onNetwork) {
      if (byId.has(local.deviceId)) continue;
      found.set(local.deviceId, {
        deviceId: local.deviceId,
        platform: local.platform,
        name: local.deviceId,
        host: local.host,
        port: local.port,
        foreign: true,
      });
    }

    // Tokens for the reachable ones we have never asked about. Serial rather
    // than parallel, because this is the endpoint that answers 429 to a burst.
    for (const speaker of found.values()) {
      if (speaker.foreign || speaker.token || !speaker.host) continue;
      try {
        const token = await deviceToken(key, speaker.deviceId, speaker.platform);
        found.set(speaker.deviceId, { ...speaker, token });
      } catch (error) {
        host.log('warn', `${speaker.name}: ${(error as Error).message}`);
      }
    }

    this.known.clear();
    for (const [id, speaker] of found) this.known.set(id, speaker);
    await this.write('devices', JSON.stringify([...found.values()]));

    /*
     * Somebody who has not chosen gets the first one chosen for them.
     *
     * Written into the setting rather than merely assumed, so the window says
     * which speaker the variables are about. Without this the plugin sat
     * connected to four speakers and published nothing at all — there was no
     * "the" speaker for `yandex.title` to be about.
     */
    const reachable = [...found.values()].filter((speaker) => speaker.host && !speaker.foreign);
    if (String(host.settings()['speaker'] ?? '') === '' && reachable[0]) {
      await this.write('speaker', reachable[0].deviceId);
    }

    host.log(
      'info',
      `Yandex: ${reachable.length} speaker(s) on the network, ${found.size - reachable.length} not reachable`,
    );

    this.connectAll();
  }

  /** Forgets the account and everything found with it. */
  async signOut(): Promise<void> {
    this.stop();
    this.known.clear();
    await this.write('token', '');
    await this.write('devices', '');
    this.clearVariables();
    this.require().setStatus('off');
  }

  // --- running ------------------------------------------------------------

  private restart(): void {
    const host = this.host;
    if (!host) return;

    this.stop();
    this.known.clear();

    if (host.settings()['enabled'] !== true) {
      this.clearVariables();
      host.setStatus('off');
      return;
    }

    for (const speaker of readKnown(host.settings()['devices'])) {
      this.known.set(speaker.deviceId, speaker);
    }

    if (String(host.settings()['token'] ?? '') === '') {
      host.setStatus('error', {
        en: 'Not signed in — press Sign in',
        ru: 'Вход не выполнен — нажмите «Войти»',
      });
      return;
    }

    if (this.known.size === 0) {
      host.setStatus('error', {
        en: 'No speakers yet — press Find speakers',
        ru: 'Колонок пока нет — нажмите «Найти колонки»',
      });
      return;
    }

    this.connectAll();
  }

  /**
   * Opens a socket to every speaker of the account that is on the network.
   *
   * All of them rather than the chosen one, because a key aimed at another
   * room should work when it is pressed and not a second later, and because
   * the cost was measured before it was assumed: a speaker with nothing
   * playing sends four to six messages every fifteen seconds.
   */
  private connectAll(): void {
    const host = this.require();

    for (const speaker of this.known.values()) {
      if (speaker.foreign || !speaker.host || !speaker.token) continue;
      if (this.connections.has(speaker.deviceId)) continue;

      const connection = new GlagolConnection({
        host: speaker.host,
        port: speaker.port ?? 1961,
        ...(this.options.retryDelaysMs ? { retryDelaysMs: this.options.retryDelaysMs } : {}),
        ...(this.options.secure === false ? { secure: false } : {}),
        token: () => this.known.get(speaker.deviceId)?.token ?? '',
        onState: (state) => this.onState(speaker.deviceId, state),
        onConnection: (state, message) => this.onConnection(speaker, state, message),
        log: (level, text) => host.log(level, text),
      });

      this.connections.set(speaker.deviceId, connection);
      connection.start();
    }

    if (this.connections.size === 0) {
      host.setStatus('error', {
        en: 'No speakers of this account are on the network',
        ru: 'Ни одной колонки этого аккаунта нет в сети',
      });
    }
  }

  private onConnection(
    speaker: KnownSpeaker,
    state: 'connecting' | 'ready' | 'error' | 'rejected',
    message?: string,
  ): void {
    const host = this.require();

    if (state === 'rejected') {
      // The token was refused. Dropped so the next scan fetches a fresh one,
      // rather than reconnecting for ever with a key that will not open it.
      this.known.set(speaker.deviceId, { ...speaker, token: undefined });
      host.log('warn', `${speaker.name}: ${message ?? 'refused the token'} — press Find speakers`);
    }

    const anyReady = [...this.connections.values()].some((connection) => connection.open);
    host.setStatus(anyReady ? 'ready' : state === 'connecting' ? 'connecting' : 'error', {
      en: anyReady ? '' : (message ?? 'Not connected'),
    });

    host.setFamily('ed.yandex.connected', speaker.deviceId, state === 'ready');
    if (speaker.deviceId === this.chosen()?.deviceId) {
      host.setFamily('ed.yandex.connected', NO_SPEAKER, state === 'ready');
    }
  }

  private onState(deviceId: string, state: SpeakerState): void {
    this.states.set(deviceId, state);
    this.publish(deviceId, state);

    // A widget on a key may be pointed at any speaker, so a cover that changed
    // anywhere is worth a look.
    void this.prefetchCover(state);
  }

  /**
   * What one speaker is doing, as variables a key can read.
   *
   * Written twice when this is the chosen speaker: once under its own name and
   * once with no argument at all. Every speaker is reported rather than only
   * the watched ones — the socket is open regardless, the state arrives
   * regardless, and with four of them in a flat the saving would be nothing
   * against a rule somebody has to remember.
   */
  private publish(deviceId: string, state: SpeakerState): void {
    const host = this.require();
    const player = state.playerState;

    const values: Record<string, VariableValue | undefined> = {
      'ed.yandex.playing': state.playing === true,
      'ed.yandex.volume': state.volume === undefined ? undefined : Math.round(state.volume * 100),
      'ed.yandex.title': player?.title ?? '',
      'ed.yandex.artist': player?.subtitle ?? '',
      'ed.yandex.progress': round(player?.progress),
      'ed.yandex.progress-time': asClock(player?.progress),
      'ed.yandex.duration': round(player?.duration),
      'ed.yandex.duration-time': asClock(player?.duration),
      'ed.yandex.source': player?.entityInfo?.type ?? '',
    };

    for (const [name, value] of Object.entries(values)) {
      host.setFamily(name, deviceId, value);
      if (deviceId === this.chosen()?.deviceId) host.setFamily(name, NO_SPEAKER, value);
    }

    if (deviceId === this.chosen()?.deviceId) {
      host.setVariable('ed.yandex.speaker', this.chosen()?.name ?? '');
    }
  }

  private clearVariables(): void {
    const host = this.host;
    if (!host) return;

    host.setVariable('ed.yandex.speaker', undefined);

    for (const name of FAMILIES) {
      host.setFamily(name, NO_SPEAKER, undefined);
      for (const deviceId of this.known.keys()) host.setFamily(name, deviceId, undefined);
    }
  }

  // --- the cover ----------------------------------------------------------

  /**
   * The album art of whatever is playing, as a picture for a key.
   *
   * Answers with what has already been fetched and nothing else. The identity
   * handed back is the cover's own address, so a key showing the same cover
   * two repaints running is written to the panel once — which matters, because
   * this is the widget most likely to sit on screen for an hour.
   */
  private cover(request: SurfaceRequest): SurfaceFrame | undefined {
    const speaker = this.speakerFor(String(request.params['speaker'] ?? ''));
    if (!speaker) return undefined;

    const uri = this.states.get(speaker.deviceId)?.playerState?.extra?.coverURI;
    if (!uri) return undefined;

    const size = request.cols > 1 || request.rows > 1 ? COVER_LARGE : COVER_SMALL;
    const address = uri.replace('%%', size);
    const kept = this.covers.get(address);

    if (kept === undefined) {
      void this.fetchCover(address);
      return undefined;
    }

    return kept === COVER_MISSING ? undefined : { source: kept, id: address };
  }

  /** Asks for a cover no more than once, and asks for a repaint when it lands. */
  private async fetchCover(address: string): Promise<void> {
    if (this.fetching.has(address)) return;
    this.fetching.add(address);

    try {
      const response = await fetch(`https://${address}`);
      if (!response.ok) throw new Error(`cover ${response.status}`);

      const type = response.headers.get('content-type') ?? 'image/jpeg';
      const bytes = Buffer.from(await response.arrayBuffer());
      this.covers.set(address, `data:${type};base64,${bytes.toString('base64')}`);
      this.host?.redraw();
    } catch (error) {
      // Remembered as missing rather than retried on the next repaint, which
      // would be a request a second for as long as the key is on screen.
      this.covers.set(address, COVER_MISSING);
      this.host?.log('warn', `Could not fetch album art: ${(error as Error).message}`);
    } finally {
      this.fetching.delete(address);
    }
  }

  /** Fetches a cover the moment the track changes, before a key asks for it. */
  private async prefetchCover(state: SpeakerState): Promise<void> {
    const uri = state.playerState?.extra?.coverURI;
    if (!uri) return;

    for (const size of [COVER_SMALL, COVER_LARGE]) {
      const address = uri.replace('%%', size);
      if (!this.covers.has(address)) await this.fetchCover(address);
    }
  }

  // --- acting -------------------------------------------------------------

  handlers(): Record<string, ActionHandler> {
    return {
      'ed.yandex.play-pause': async (params) => {
        const { deviceId, state } = this.target(params);
        const mode = String(params['mode'] ?? 'toggle');
        const playing = mode === 'toggle' ? state?.playing !== true : mode === 'play';

        this.send(deviceId, { command: playing ? 'play' : 'stop' });
        // Published at once rather than waited for: the speaker reports on its
        // own beat, and a key that took a second to change looks broken.
        this.expect(deviceId, 'ed.yandex.playing', playing);
      },

      'ed.yandex.next-track': async (params) => {
        this.send(this.target(params).deviceId, { command: 'next' });
      },

      'ed.yandex.prev-track': async (params) => {
        this.send(this.target(params).deviceId, { command: 'prev' });
      },

      'ed.yandex.rewind': async (params) => {
        const { deviceId, state } = this.target(params);
        const seconds = Math.max(0, numberParam(params, 'seconds', 15));
        const at = state?.playerState?.progress ?? 0;
        const mode = String(params['mode'] ?? 'forward');

        const position =
          mode === 'to' ? seconds : mode === 'back' ? Math.max(0, at - seconds) : at + seconds;

        this.send(deviceId, { command: 'rewind', position: Math.round(position) });
      },

      'ed.yandex.volume': async (params) => {
        const { deviceId, state } = this.target(params);
        const step = Math.max(0, Math.min(100, numberParam(params, 'value', 10))) / 100;
        const now = state?.volume ?? 0.5;
        const mode = String(params['mode'] ?? 'up');

        const wanted = mode === 'set' ? step : mode === 'down' ? now - step : now + step;
        // One decimal place, which is all the speaker keeps: sending 0.37 and
        // then reading 0.4 back would make a key twitch on every press.
        const volume = Math.round(Math.max(0, Math.min(1, wanted)) * 10) / 10;

        this.send(deviceId, { command: 'setVolume', volume });
        this.expect(deviceId, 'ed.yandex.volume', Math.round(volume * 100));
      },

      'ed.yandex.repeat': async (params) => {
        const { deviceId, state } = this.target(params);
        const asked = String(params['mode'] ?? 'cycle');
        const now = state?.playerState?.entityInfo?.repeatMode ?? 'None';
        const mode = asked === 'cycle' ? nextRepeat(now) : asked;

        this.send(deviceId, { command: 'repeat', mode });
      },

      'ed.yandex.shuffle': async (params) => {
        const { deviceId, state } = this.target(params);
        const mode = String(params['mode'] ?? 'toggle');
        const now = state?.playerState?.entityInfo?.shuffled === true;

        this.send(deviceId, { command: 'shuffle', enable: mode === 'toggle' ? !now : mode === 'on' });
      },

      'ed.yandex.command': async (params) => {
        this.send(this.target(params).deviceId, {
          command: 'sendText',
          text: stringParam(params, 'text'),
        });
      },

      /*
       * Speech, which is not `sendText`.
       *
       * `sendText` hands the words to Alice as something to carry out, and she
       * answers. This form makes the speaker read the text out and stop, which
       * is what "announce that the stream is starting" means.
       */
      'ed.yandex.say': async (params) => {
        this.send(this.target(params).deviceId, {
          command: 'serverAction',
          serverActionEventPayload: {
            type: 'server_action',
            name: 'update_form',
            payload: {
              form_update: {
                name: 'personal_assistant.scenarios.quasar.iot.repeat_phrase',
                slots: [
                  { type: 'string', name: 'phrase_to_repeat', value: stringParam(params, 'text') },
                ],
              },
              resubmit: true,
            },
          },
        });
      },
    };
  }

  /**
   * Says what a key just asked for, before the speaker has confirmed it.
   *
   * Under both names, so a key bound to that speaker and a key bound to
   * "whichever was chosen" change together — one of them lagging a second
   * behind the other is worse than both lagging.
   */
  private expect(deviceId: string, name: string, value: VariableValue): void {
    const host = this.require();
    host.setFamily(name, deviceId, value);
    if (deviceId === this.chosen()?.deviceId) host.setFamily(name, NO_SPEAKER, value);
  }

  private send(deviceId: string, payload: Record<string, unknown>): void {
    const connection = this.connections.get(deviceId);
    if (!connection) throw new Error('That speaker is not connected');
    connection.send(payload);
  }

  /** Which speaker a key means, and what it was last seen doing. */
  private target(params: Readonly<Record<string, unknown>>): {
    deviceId: string;
    state?: SpeakerState;
  } {
    const speaker = this.speakerFor(String(params['speaker'] ?? ''));
    if (!speaker) throw new Error('No speaker chosen — pick one in the plugin settings');

    const state = this.states.get(speaker.deviceId);
    return state === undefined
      ? { deviceId: speaker.deviceId }
      : { deviceId: speaker.deviceId, state };
  }

  /** The named speaker, or the one settings chose, or the only one there is. */
  private speakerFor(deviceId: string): KnownSpeaker | undefined {
    if (deviceId !== '') return this.known.get(deviceId);
    return this.chosen();
  }

  /**
   * The speaker everything unqualified is about.
   *
   * Falls back to the first reachable one when nothing was chosen — which is
   * the state a profile is in before anybody has opened the settings, and
   * which used to mean no variables were published at all. Deterministic
   * rather than whichever answered first, so the key that says what is playing
   * is not about a different speaker after every restart.
   */
  private chosen(): KnownSpeaker | undefined {
    const wanted = String(this.host?.settings()['speaker'] ?? '');
    const named = wanted === '' ? undefined : this.known.get(wanted);
    if (named) return named;

    return this.usable()[0];
  }

  /** The speakers of this account that are on the network, in a fixed order. */
  private usable(): KnownSpeaker[] {
    return [...this.known.values()]
      .filter((speaker) => !speaker.foreign && speaker.host)
      .sort((one, other) => describeSpeaker(one).localeCompare(describeSpeaker(other)));
  }

  /**
   * Stores a setting this plugin worked out, without hearing about it again.
   *
   * Saving notifies every listener, this one included, and reacting to that
   * would tear down the connections in the middle of the scan that was filling
   * them in.
   */
  private async write(name: string, value: string): Promise<void> {
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

/** "Кабинет · Яндекс станция", which is how somebody picks one from a list. */
function describeSpeaker(speaker: KnownSpeaker): string {
  return speaker.room ? `${speaker.room} · ${speaker.name}` : speaker.name;
}

function nextRepeat(now: string): string {
  return now === 'None' ? 'All' : now === 'All' ? 'One' : 'None';
}

function round(value: number | undefined): number | undefined {
  return value === undefined ? undefined : Math.round(value);
}

/**
 * Seconds, as a clock reads them: `3:07`, and `1:02:30` past the hour.
 *
 * The hour is left off whatever it costs in consistency, because almost every
 * track is under four minutes and `0:03:07` on a key is three characters of
 * nothing in a space that has very few. Seconds are always two digits, since a
 * number that changes width makes the whole label jump every ten seconds.
 *
 * Empty for a speaker with nothing loaded — the same answer the title and the
 * artist give, so a key showing all three goes blank together rather than
 * keeping a lonely `0:00` from whatever last played.
 */
function asClock(seconds: number | undefined): string {
  if (seconds === undefined || !Number.isFinite(seconds) || seconds < 0) return '';

  const whole = Math.floor(seconds);
  const hours = Math.floor(whole / 3600);
  const minutes = Math.floor((whole % 3600) / 60);
  const rest = whole % 60;

  const pad = (value: number): string => String(value).padStart(2, '0');
  return hours > 0 ? `${hours}:${pad(minutes)}:${pad(rest)}` : `${minutes}:${pad(rest)}`;
}

/** The remembered speaker list, read defensively: it is a string on disk. */
function readKnown(value: unknown): KnownSpeaker[] {
  if (typeof value !== 'string' || value.trim() === '') return [];

  try {
    const parsed: unknown = JSON.parse(value);
    if (!Array.isArray(parsed)) return [];

    return parsed.filter(
      (entry): entry is KnownSpeaker =>
        typeof entry === 'object' &&
        entry !== null &&
        typeof (entry as KnownSpeaker).deviceId === 'string' &&
        typeof (entry as KnownSpeaker).platform === 'string',
    );
  } catch {
    return [];
  }
}

/**
 * Builds the running parts.
 *
 * Exported apart from the default so the tests can pass options — short
 * retry delays, a fake to connect to. The host always takes the defaults.
 */
export function activateWith(options: YandexPluginOptions = {}): PluginActivation {
  const plugin = new YandexPlugin(options);

  return {
    plugin,
    handlers: plugin.handlers(),
    commands: {
      login: () => plugin.login(),
      rescan: () => plugin.rescan(),
      signout: () => plugin.signOut(),
    },
  };
}

export default definePlugin({ manifest: yandexManifest, activate: () => activateWith() });
