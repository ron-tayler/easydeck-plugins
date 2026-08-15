import { PLUGIN_API_VERSION, definePlugin, numberParam, stringParam } from '@easydeck/plugin-sdk';
import type {
  ParamOption,
  Plugin,
  PluginHost,
  PluginManifest,
  Ticker,
  VariableValue,
} from '@easydeck/plugin-sdk';

import { SoundpadConnection } from './soundpad-connection.js';

/**
 * Soundpad, as a deck sees it.
 *
 * A soundboard is the thing a stream deck is bought for, and the awkward part
 * of it is not playing a sound — it is *naming* one. Soundpad addresses sounds
 * by their row number, so a key that plays a fanfare says `DoPlaySound(7)`,
 * and a seven that means something different after somebody reorders their list
 * is the whole problem. Hence the list behind the field: the number is what
 * gets stored, the title is what gets shown, and the field is refilled from
 * Soundpad every time it is opened.
 *
 * Unlike OBS, Soundpad says nothing on its own — no event stream, no callbacks,
 * one question and one answer. So what a key *shows* has to be polled, and
 * `onWatched` decides both how often and, more to the point, *what*: each value
 * here costs a round trip of its own, so asking for four when a key shows one
 * is three wasted trips a second, for ever.
 *
 * There is also nothing to ask about recording. Soundpad will start and stop
 * it, and has no `IsRecording` — so this plugin offers those two orders and
 * publishes no state for them, rather than a variable that would be a guess.
 */

export const SOUNDPAD_PLUGIN_ID = 'ed.soundpad';

/** What Soundpad calls the four things playback can be doing. */
const STATUSES: Readonly<Record<string, string>> = {
  STOPPED: 'stopped',
  PLAYING: 'playing',
  PAUSED: 'paused',
  SEEKING: 'seeking',
};

/** Things that move while a sound plays, and are worth a second. */
const QUICK = ['ed.soundpad.status', 'ed.soundpad.playing', 'ed.soundpad.position', 'ed.soundpad.position-ms'];

/** Things a person changes by hand in Soundpad, which no event announces. */
const SLOW = [
  'ed.soundpad.volume',
  'ed.soundpad.muted',
  'ed.soundpad.sound-count',
  'ed.soundpad.duration',
  'ed.soundpad.duration-ms',
];

const QUICK_INTERVAL_MS = 1_000;
const SLOW_INTERVAL_MS = 5_000;

/**
 * Which lines a sound goes out on.
 *
 * The first is not "both" but "whatever Soundpad is set to", and it is the
 * default because it is the honest one: Soundpad has this setting in its own
 * window, and a key that silently overrode it would make that window a lie.
 * It also sends the one-argument form, which is what Soundpad does on its own.
 */
const LINES = [
  { value: '', label: { en: 'As Soundpad is set up', ru: 'Как настроено в Soundpad' } },
  { value: 'both', label: { en: 'Speakers and microphone', ru: 'В колонки и в микрофон' } },
  { value: 'speakers', label: { en: 'Speakers only', ru: 'Только в колонки' } },
  { value: 'microphone', label: { en: 'Microphone only', ru: 'Только в микрофон' } },
];

export const soundpadManifest: PluginManifest = {
  id: SOUNDPAD_PLUGIN_ID,
  name: { en: 'Soundpad', ru: 'Soundpad' },
  description: {
    en: 'Plays the sounds from your Soundpad list, and its volume',
    ru: 'Проигрывает звуки из списка Soundpad и управляет его громкостью',
  },
  version: '1.0.0',
  apiVersion: PLUGIN_API_VERSION,

  settings: [
    {
      /*
       * Off until asked for, as the OBS plugin is and for the same reason: a
       * machine with no Soundpad on it should not have something knocking on a
       * pipe every half minute for ever.
       */
      name: 'enabled',
      type: 'boolean',
      label: { en: 'Connect to Soundpad', ru: 'Подключаться к Soundpad' },
      default: false,
      required: false,
      description: {
        en: 'Soundpad needs no setting up: it always listens, and there is nothing to configure',
        ru: 'Soundpad настраивать не нужно: он всегда слушает, настраивать нечего',
      },
    },
  ],

  commands: [
    { name: 'reconnect', label: { en: 'Reconnect', ru: 'Переподключиться' }, icon: 'link' },
  ],

  variables: [
    {
      name: 'ed.soundpad.connected',
      type: 'boolean',
      label: { en: 'Soundpad connected', ru: 'Soundpad подключён' },
      initial: false,
    },
    {
      name: 'ed.soundpad.status',
      type: 'string',
      label: { en: 'What playback is doing', ru: 'Что с воспроизведением' },
      description: {
        en: 'stopped, playing, paused or seeking — compare against it to know which',
        ru: '«stopped», «playing», «paused» или «seeking» — сравнивайте, чтобы узнать',
      },
    },
    {
      name: 'ed.soundpad.playing',
      type: 'boolean',
      label: { en: 'A sound is playing', ru: 'Звук играет' },
      initial: false,
    },
    {
      name: 'ed.soundpad.volume',
      type: 'number',
      label: { en: 'Volume, %', ru: 'Громкость, %' },
      initial: 0,
    },
    {
      name: 'ed.soundpad.muted',
      type: 'boolean',
      label: { en: 'Muted', ru: 'Звук выключен' },
      initial: false,
    },
    {
      name: 'ed.soundpad.sound-count',
      type: 'number',
      label: { en: 'Sounds in the list', ru: 'Звуков в списке' },
      initial: 0,
    },
    {
      name: 'ed.soundpad.position',
      type: 'string',
      label: { en: 'Position', ru: 'Позиция' },
      initial: '0:00',
    },
    {
      name: 'ed.soundpad.position-ms',
      type: 'number',
      label: { en: 'Position, ms', ru: 'Позиция, мс' },
      description: {
        en: 'The number behind the position, for a handler to compare against',
        ru: 'Число за позицией — чтобы обработчик мог его сравнить',
      },
      initial: 0,
    },
    {
      name: 'ed.soundpad.duration',
      type: 'string',
      label: { en: 'Length', ru: 'Длительность' },
      initial: '0:00',
    },
    {
      name: 'ed.soundpad.duration-ms',
      type: 'number',
      label: { en: 'Length, ms', ru: 'Длительность, мс' },
      initial: 0,
    },
  ],

  actions: [
    {
      type: 'ed.soundpad.play',
      icon: 'play-pause',
      label: { en: 'Play a sound', ru: 'Проиграть звук' },
      description: {
        en: 'Held by name, so rearranging your Soundpad list does not change what a key plays',
        ru: 'Хранится по названию — поэтому перетаскивание списка в Soundpad не меняет, что играет клавиша',
      },
      params: [
        {
          name: 'sound',
          type: 'select',
          optionsFrom: 'sounds',
          label: { en: 'Sound', ru: 'Звук' },
          // Nothing to list means Soundpad is closed, and the name is a fine
          // thing to type — so no `emptyNote` here.
          placeholder: { en: 'Name, tag or file name', ru: 'Название, тег или имя файла' },
        },
        {
          name: 'lines',
          type: 'select',
          label: { en: 'Where to play it', ru: 'Куда проигрывать' },
          default: '',
          required: false,
          options: LINES,
        },
      ],
      group: { en: 'Sounds', ru: 'Звуки' },
    },
    {
      type: 'ed.soundpad.play-random',
      icon: 'cycle',
      label: { en: 'Play a random sound', ru: 'Проиграть случайный звук' },
      params: [],
      group: { en: 'Sounds', ru: 'Звуки' },
    },
    {
      type: 'ed.soundpad.play-previous',
      icon: 'previous',
      label: { en: 'Play the previous sound', ru: 'Проиграть предыдущий звук' },
      params: [],
      group: { en: 'Sounds', ru: 'Звуки' },
    },
    {
      type: 'ed.soundpad.play-next',
      icon: 'next',
      label: { en: 'Play the next sound', ru: 'Проиграть следующий звук' },
      params: [],
      group: { en: 'Sounds', ru: 'Звуки' },
    },
    {
      type: 'ed.soundpad.stop',
      icon: 'stop',
      label: { en: 'Stop', ru: 'Остановить' },
      params: [],
      group: { en: 'Sounds', ru: 'Звуки' },
    },
    {
      type: 'ed.soundpad.toggle-pause',
      icon: 'play-pause',
      label: { en: 'Pause / resume', ru: 'Пауза / продолжить' },
      params: [],
      group: { en: 'Sounds', ru: 'Звуки' },
    },
    {
      type: 'ed.soundpad.seek',
      icon: 'next',
      label: { en: 'Seek', ru: 'Перемотать' },
      description: {
        en: 'To a position in the sound, or by so much from where it is',
        ru: 'На позицию в звуке или на столько-то от текущей',
      },
      params: [
        {
          name: 'how',
          type: 'select',
          label: { en: 'How', ru: 'Как' },
          default: 'by',
          options: [
            { value: 'by', label: { en: 'By this much', ru: 'На столько-то' } },
            { value: 'to', label: { en: 'To this position', ru: 'На эту позицию' } },
          ],
        },
        {
          name: 'seconds',
          type: 'number',
          label: { en: 'Seconds', ru: 'Секунд' },
          default: 5,
          min: -600,
          max: 600,
          description: {
            en: 'A negative number goes backwards, where that means anything',
            ru: 'Отрицательное число — назад, там где это имеет смысл',
          },
        },
      ],
      group: { en: 'Sounds', ru: 'Звуки' },
    },

    {
      type: 'ed.soundpad.set-volume',
      icon: 'volume-up',
      label: { en: 'Set volume', ru: 'Задать громкость' },
      params: [
        {
          name: 'percent',
          type: 'number',
          label: { en: 'Volume, %', ru: 'Громкость, %' },
          default: 100,
          min: 0,
          max: 100,
        },
      ],
      group: { en: 'Volume', ru: 'Громкость' },
    },
    {
      type: 'ed.soundpad.adjust-volume',
      icon: 'volume-down',
      label: { en: 'Change volume', ru: 'Изменить громкость' },
      description: {
        en: 'Adds to the current volume; a negative number turns it down',
        ru: 'Прибавляет к текущей громкости; отрицательное число убавляет',
      },
      params: [
        {
          name: 'by',
          type: 'number',
          label: { en: 'Change, %', ru: 'Изменение, %' },
          default: -10,
          min: -100,
          max: 100,
        },
      ],
      group: { en: 'Volume', ru: 'Громкость' },
    },
    {
      type: 'ed.soundpad.toggle-mute',
      icon: 'mute',
      label: { en: 'Mute / unmute', ru: 'Выключить / включить звук' },
      params: [],
      group: { en: 'Volume', ru: 'Громкость' },
    },

    {
      type: 'ed.soundpad.record',
      icon: 'record',
      label: { en: 'Recording', ru: 'Запись' },
      description: {
        en: 'Soundpad cannot be asked whether it is recording, so this says which, not "toggle"',
        ru: 'Soundpad нельзя спросить, идёт ли запись, поэтому здесь не «переключить», а что именно',
      },
      params: [
        {
          name: 'do',
          type: 'select',
          label: { en: 'What to do', ru: 'Что сделать' },
          default: 'start',
          options: [
            { value: 'start', label: { en: 'Start recording', ru: 'Начать запись' } },
            { value: 'stop', label: { en: 'Stop recording', ru: 'Остановить запись' } },
          ],
        },
      ],
      group: { en: 'Recording', ru: 'Запись' },
    },
  ],

  presets: [
    {
      name: 'stop',
      label: { en: 'Stop', ru: 'Остановить' },
      description: { en: 'Stops whatever is playing', ru: 'Останавливает то, что играет' },
      button: {
        states: [
          {
            id: 'default',
            visual: {
              background: '#3a1f1f',
              label: { text: 'Стоп', color: '#ffffff', position: 'bottom', fontSize: 14 },
            },
            actions: { press: [{ type: 'ed.soundpad.stop', params: {} }] },
          },
        ],
      },
    },
    {
      name: 'random',
      label: { en: 'Random sound', ru: 'Случайный звук' },
      description: {
        en: 'Plays anything from the list, which is the best key on any soundboard',
        ru: 'Играет что угодно из списка — лучшая клавиша любого саундборда',
      },
      button: {
        states: [
          {
            id: 'default',
            visual: {
              background: '#1f3a4d',
              label: { text: '🎲', color: '#ffffff', position: 'center', fontSize: 34 },
            },
            actions: { press: [{ type: 'ed.soundpad.play-random', params: {} }] },
          },
        ],
      },
    },
    {
      name: 'mute',
      label: { en: 'Mute', ru: 'Заглушить' },
      description: {
        en: 'Goes dim while Soundpad is muted',
        ru: 'Гаснет, пока звук Soundpad выключен',
      },
      button: {
        stateFrom: 'ed.soundpad.muted',
        states: [
          {
            id: 'on',
            when: false,
            visual: {
              background: '#1d2733',
              label: { text: '{{soundpad.volume}}%', color: '#ffffff', position: 'bottom', fontSize: 14 },
            },
            actions: { press: [{ type: 'ed.soundpad.toggle-mute', params: {} }] },
          },
          {
            id: 'off',
            when: true,
            visual: {
              background: '#2a2f36',
              label: { text: '—', color: '#7d8590', position: 'center', fontSize: 26 },
            },
          },
        ],
      },
    },
  ],
};

export interface SoundpadPluginOptions {
  /** Overridden by tests, which listen on a pipe of their own. */
  readonly pipe?: string;
  readonly retryDelaysMs?: readonly number[];
}

export class SoundpadPlugin implements Plugin {
  private host?: PluginHost;
  private connection?: SoundpadConnection;
  private ticker?: Ticker;
  private watched = new Set<string>();
  /** What was last published, so an unchanged answer costs no repaint. */
  private readonly published = new Map<string, VariableValue>();

  constructor(private readonly options: SoundpadPluginOptions = {}) {}

  start(host: PluginHost): void {
    this.host = host;

    host.onWatched((keys) => {
      this.watched = new Set(keys);
      this.retime();
      void this.poll();
    });

    host.onSettingsChanged(() => this.reconnect());

    // Registered stopped: what is worth asking for depends on what is being
    // read, and at this point nothing has said.
    this.ticker = host.update(0, () => void this.poll());

    this.registerOptions(host);
    this.reconnect();
  }

  stop(): void {
    this.ticker?.stop();
    this.ticker = undefined;
    this.connection?.stop();
    this.connection = undefined;
    this.host = undefined;
  }

  /** Opens the pipe, or closes it and says so when the setting is off. */
  reconnect(): void {
    const host = this.host;
    if (!host) return;

    this.connection?.stop();
    this.connection = undefined;
    this.forget();

    if (host.settings()['enabled'] !== true) {
      host.setStatus('off', {
        en: 'Switched off. Turn it on to connect to Soundpad',
        ru: 'Выключено. Включите, чтобы подключаться к Soundpad',
      });
      // Said out loud rather than left empty: a key bound to this should read
      // "no" while the plugin is off, which is what is true.
      this.set('ed.soundpad.connected', false);
      this.retime();
      return;
    }

    this.connection = new SoundpadConnection({
      ...(this.options.pipe === undefined ? {} : { pipe: this.options.pipe }),
      ...(this.options.retryDelaysMs === undefined ? {} : { retryDelaysMs: this.options.retryDelaysMs }),
      onState: (state, message) => this.onState(state, message),
      log: (level, message) => host.log(level, message),
    });

    this.connection.start();
  }

  private onState(state: 'connecting' | 'ready' | 'error', message?: string): void {
    const host = this.host;
    if (!host) return;

    const text = message === undefined ? undefined : { en: message, ru: message };

    if (state === 'ready') {
      host.setStatus('ready');
      this.set('ed.soundpad.connected', true);
      this.retime();
      void this.poll();
      return;
    }

    host.setStatus(state === 'connecting' ? 'connecting' : 'error', text);
    this.set('ed.soundpad.connected', false);

    /*
     * What was last known is cleared rather than left standing.
     *
     * A key showing `50%` for a Soundpad that has been closed for an hour is
     * worse than a key showing nothing: it is the same picture as a Soundpad
     * that is running and set to fifty.
     */
    if (state === 'error') this.forget('ed.soundpad.connected');
    this.retime();
  }

  // --- the lists a configurator offers -------------------------------------

  /**
   * The sounds Soundpad has, by name.
   *
   * Read when somebody opens the field rather than kept: the list is theirs to
   * edit while the deck runs, and a copy of it here would be a second version
   * of the truth that goes stale the first time they drag a row.
   *
   * The value stored is the *name*, not the row number, even though the number
   * is the only thing `DoPlaySound` understands. Soundpad's list is meant to be
   * dragged about, and a number is a promise that breaks the moment somebody
   * does — silently, and into playing the wrong sound rather than none. The row
   * is looked up again at the moment the key is pressed; see `findSound`.
   *
   * The number still appears in the label, because it is how you find the row
   * in Soundpad's own window while you are setting a key up.
   */
  private registerOptions(host: PluginHost): void {
    host.provideOptions('sounds', async () => {
      const list = await this.require().ask('GetSoundlist()');
      return soundOptions(list);
    });
  }

  // --- what a key asked for -------------------------------------------------

  /**
   * Plays what a key names, whatever row it happens to be on now.
   *
   * The list is read on every press rather than remembered. It costs one round
   * trip down a local pipe, and the alternative is a copy that disagrees with
   * Soundpad exactly when it matters — the press after somebody rearranged
   * their sounds. If a list ever grows big enough for that to be felt, this is
   * the place for a cache, and it will need a reason to be safe.
   *
   * A plain number is still taken as a row number, for anybody who wants one.
   */
  async play(sound: string, lines: string): Promise<void> {
    const wanted = sound.trim();
    if (wanted === '') throw new TypeError('No sound was named');

    const index = /^\d+$/.test(wanted)
      ? Number(wanted)
      : findSound(await this.require().ask('GetSoundlist()'), wanted);

    if (index === undefined || index < 1) {
      throw new Error(`Soundpad has no sound called '${wanted}'`);
    }

    // No third and fourth argument at all for "as Soundpad is set up": the
    // one-argument form is what Soundpad does by itself, and passing its own
    // setting back to it would be this plugin guessing what that setting is.
    if (lines === '' || lines === undefined) {
      await this.require().tell(`DoPlaySound(${index})`);
      return;
    }

    const speakers = lines !== 'microphone';
    const microphone = lines !== 'speakers';
    await this.require().tell(`DoPlaySound(${index}, ${speakers}, ${microphone})`);
  }

  async simple(command: string): Promise<void> {
    await this.require().tell(command);
  }

  async seek(how: string, seconds: number): Promise<void> {
    const ms = Math.round(seconds * 1000);
    await this.require().tell(how === 'to' ? `DoSeekMs(${Math.max(0, ms)})` : `DoJumpMs(${ms})`);
  }

  /**
   * Sets the volume, having first made sure it is a number.
   *
   * Measured, not assumed: `SetVolume(abc)` answers `R-200` and leaves the
   * volume at zero. Soundpad accepts nonsense and reports success, so the one
   * place that can refuse it is here.
   */
  async setVolume(percent: number): Promise<void> {
    await this.require().tell(`SetVolume(${clampVolume(percent)})`);
  }

  /** Reads before it writes, because "quieter" only means something against now. */
  async adjustVolume(by: number): Promise<void> {
    const connection = this.require();
    const current = Number(await connection.ask('GetVolume()'));
    const from = Number.isFinite(current) ? current : 0;

    await connection.tell(`SetVolume(${clampVolume(from + by)})`);
  }

  private require(): SoundpadConnection {
    const connection = this.connection;
    if (!connection?.connected) throw new Error('Soundpad is not connected');
    return connection;
  }

  // --- publishing -----------------------------------------------------------

  /**
   * Asks Soundpad for what somebody is actually looking at.
   *
   * The gate is on the *questions*, not on the answers. Every value here is a
   * round trip of its own, so the thrift `onWatched` buys elsewhere by skipping
   * a write buys real traffic here: a page showing only the volume asks one
   * question a beat instead of five.
   */
  private async poll(): Promise<void> {
    const connection = this.connection;
    if (!connection?.connected) return;

    try {
      if (this.anyWatched(['ed.soundpad.status', 'ed.soundpad.playing'])) {
        const status = STATUSES[(await connection.ask('GetPlayStatus()')).trim()] ?? 'stopped';
        this.set('ed.soundpad.status', status);
        this.set('ed.soundpad.playing', status === 'playing');
      }

      if (this.anyWatched(['ed.soundpad.volume'])) {
        this.set('ed.soundpad.volume', clampVolume(Number(await connection.ask('GetVolume()'))));
      }

      if (this.anyWatched(['ed.soundpad.muted'])) {
        this.set('ed.soundpad.muted', (await connection.ask('IsMuted()')).trim() === '1');
      }

      if (this.anyWatched(['ed.soundpad.sound-count'])) {
        this.set('ed.soundpad.sound-count', whole(await connection.ask('GetSoundFileCount()')));
      }

      if (this.anyWatched(['ed.soundpad.position', 'ed.soundpad.position-ms'])) {
        const ms = whole(await connection.ask('GetPlaybackPositionInMs()'));
        this.set('ed.soundpad.position-ms', ms);
        this.set('ed.soundpad.position', asClock(ms));
      }

      if (this.anyWatched(['ed.soundpad.duration', 'ed.soundpad.duration-ms'])) {
        const ms = whole(await connection.ask('GetPlaybackDurationInMs()'));
        this.set('ed.soundpad.duration-ms', ms);
        this.set('ed.soundpad.duration', asClock(ms));
      }
    } catch (cause) {
      // Soundpad going away mid-poll. The connection reports that itself and
      // starts retrying; there is nothing to add and nothing to alarm anybody
      // with, so this only says so in the log.
      this.host?.log('warn', `Could not read Soundpad: ${reason(cause)}`);
    }
  }

  /** A second while something moves, five while nothing does, and none at all. */
  private retime(): void {
    if (!this.connection?.connected) {
      this.ticker?.every(0);
      return;
    }

    if (this.anyWatched(QUICK)) this.ticker?.every(QUICK_INTERVAL_MS);
    else if (this.anyWatched(SLOW)) this.ticker?.every(SLOW_INTERVAL_MS);
    else this.ticker?.every(0);
  }

  private anyWatched(names: readonly string[]): boolean {
    return names.some((name) => this.watched.has(name));
  }

  /**
   * Written only if something reads it, and only if it changed.
   *
   * The second half matters more here than elsewhere: this polls, so it
   * arrives at the same answer over and over, and a write that repeats the
   * value still costs a repaint of the page and a run of every handler.
   */
  private set(name: string, value: VariableValue): void {
    if (!this.watched.has(name) && name !== 'ed.soundpad.connected') return;
    if (this.published.get(name) === value) return;

    this.published.set(name, value);
    this.host?.setVariable(name, value);
  }

  /** Clears what was published, except whatever is named as still true. */
  private forget(...keep: readonly string[]): void {
    for (const name of this.published.keys()) {
      if (keep.includes(name)) continue;
      this.host?.setVariable(name, undefined);
    }

    const kept = keep
      .filter((name) => this.published.has(name))
      .map((name) => [name, this.published.get(name)!] as const);

    this.published.clear();
    for (const [name, value] of kept) this.published.set(name, value);
  }
}

/**
 * The module a built `main.mjs` default-exports.
 *
 * The same wiring `registerSoundpadPlugin` used to do in the main repository,
 * inverted: the plugin describes itself and the host does the installing.
 */
export default definePlugin({
  manifest: soundpadManifest,
  activate() {
    const plugin = new SoundpadPlugin();

    return {
      plugin,
      handlers: {
        'ed.soundpad.play': async (params) =>
          plugin.play(stringParam(params, 'sound'), String(params['lines'] ?? '')),

        'ed.soundpad.play-random': async () => plugin.simple('DoPlayRandomSound()'),
        'ed.soundpad.play-previous': async () => plugin.simple('DoPlayPreviousSound()'),
        'ed.soundpad.play-next': async () => plugin.simple('DoPlayNextSound()'),
        'ed.soundpad.stop': async () => plugin.simple('DoStopSound()'),
        'ed.soundpad.toggle-pause': async () => plugin.simple('DoTogglePause()'),
        'ed.soundpad.toggle-mute': async () => plugin.simple('DoToggleMute()'),

        'ed.soundpad.seek': async (params) =>
          plugin.seek(String(params['how'] ?? 'by'), numberParam(params, 'seconds', 5)),

        'ed.soundpad.set-volume': async (params) =>
          plugin.setVolume(numberParam(params, 'percent', 100)),
        'ed.soundpad.adjust-volume': async (params) =>
          plugin.adjustVolume(numberParam(params, 'by', -10)),

        'ed.soundpad.record': async (params) =>
          plugin.simple(params['do'] === 'stop' ? 'DoStopRecording()' : 'DoStartRecording()'),
      },
      commands: { reconnect: () => plugin.reconnect() },
    };
  },
});

/** One row of Soundpad's list, as much of it as anything here needs. */
interface Row {
  readonly index: number;
  readonly title: string;
  readonly tag: string;
  readonly file: string;
}

/**
 * The rows of a sound list.
 *
 * Parsed with a regular expression rather than an XML library, which is the
 * same trade the rest of this package makes: the document is two attributes
 * deep, generated by one program, and a dependency to read it would be more to
 * carry than to gain.
 */
function rows(xml: string): Row[] {
  const found: Row[] = [];

  for (const row of xml.matchAll(/<Sound\b([^>]*)\/>/g)) {
    const attributes = row[1] ?? '';
    const index = Number(attribute(attributes, 'index') ?? '');
    if (!Number.isFinite(index) || index < 1) continue;

    found.push({
      index,
      title: attribute(attributes, 'title') ?? '',
      tag: attribute(attributes, 'tag') ?? '',
      file: fileName(attribute(attributes, 'url') ?? ''),
    });
  }

  return found;
}

/**
 * The choices a field offers, held by name.
 *
 * A sound with no title falls back to its file name — Soundpad leaves the title
 * empty for a file with no tags, and a list of blank rows is no list at all.
 * Whatever is shown is what gets stored, so the thing somebody picked is the
 * thing that will be looked for.
 */
export function soundOptions(xml: string): ParamOption[] {
  return rows(xml)
    .map((row) => ({ row, name: nameOf(row) }))
    .filter(({ name }) => name !== '')
    .map(({ row, name }) => ({ value: name, label: { en: `${row.index}. ${name}` } }));
}

/**
 * The row a name refers to, or nothing.
 *
 * Three things count as a name, in the order somebody would expect them to:
 * the title Soundpad shows, the tag it searches by, and the file on disk. Then
 * the same three again ignoring case, because a name typed by hand rarely
 * matches the capitals of a file somebody downloaded.
 *
 * The lowest row wins where several match. Titles are not unique — two copies
 * of the same file are an ordinary thing to have — and picking the first is at
 * least the same answer every time, which "whichever" would not be.
 */
export function findSound(xml: string, wanted: string): number | undefined {
  const all = rows(xml);
  const needle = wanted.trim();
  const folded = needle.toLowerCase();

  const attempts: readonly ((row: Row) => boolean)[] = [
    (row) => row.title === needle,
    (row) => row.tag === needle,
    (row) => row.file === needle,
    (row) => row.title.toLowerCase() === folded,
    (row) => row.tag.toLowerCase() === folded,
    (row) => row.file.toLowerCase() === folded,
  ];

  for (const matches of attempts) {
    const hit = all.filter(matches).sort((a, b) => a.index - b.index)[0];
    if (hit) return hit.index;
  }

  return undefined;
}

/** What a row is called: its title, or the file it came from. */
function nameOf(row: Row): string {
  return row.title !== '' ? row.title : row.file;
}

function attribute(attributes: string, name: string): string | undefined {
  const found = new RegExp(`\\b${name}="([^"]*)"`).exec(attributes);
  return found ? unescapeXml(found[1] ?? '') : undefined;
}

function unescapeXml(text: string): string {
  return text
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

function fileName(path: string): string {
  const cut = Math.max(path.lastIndexOf('\\'), path.lastIndexOf('/'));
  return cut < 0 ? path : path.slice(cut + 1);
}

/**
 * A duration as a key shows it: `4:59`, and `1:04:59` once there is an hour.
 *
 * Written here rather than borrowed from the clock plugin, which has the same
 * function. Every built-in plugin has to be liftable out of this build on its
 * own — that is the plan for the ones that will live in their own repository —
 * and a plugin that cannot leave without taking another with it is not.
 */
function asClock(ms: number): string {
  const whole = Math.max(0, Math.floor(ms / 1000));
  const hours = Math.floor(whole / 3600);
  const minutes = Math.floor((whole % 3600) / 60);
  const seconds = whole % 60;
  const pad = (value: number): string => String(value).padStart(2, '0');

  return hours > 0 ? `${hours}:${pad(minutes)}:${pad(seconds)}` : `${minutes}:${pad(seconds)}`;
}

/** Soundpad answers in decimal text; anything else counts as nothing. */
function whole(answer: string): number {
  const value = Number(answer.trim());
  return Number.isFinite(value) ? Math.round(value) : 0;
}

function clampVolume(percent: number): number {
  if (!Number.isFinite(percent)) return 0;
  return Math.min(100, Math.max(0, Math.round(percent)));
}

function reason(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}
