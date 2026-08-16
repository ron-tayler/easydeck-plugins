import {
  PLUGIN_API_VERSION,
  definePlugin,
  numberParam,
  parseVariableKey,
  readList,
  stringParam,
} from '@easydeck/plugin-sdk';
import type {
  PluginActivation,
  ActionHandler,
  ButtonPreset,
  ParamOption,
  Plugin,
  PluginHost,
  PluginManifest,
  PresetButton,
  SurfaceFrame,
  SurfaceRequest,
  Ticker,
  VariableValue,
} from '@easydeck/plugin-sdk';

import { ObsConnection, VOLUME_METERS } from './obs-connection.js';
import { drawMeter, levelOf } from './obs-meter.js';

/**
 * OBS Studio, as a deck sees it.
 *
 * The first plugin that holds a connection open, and therefore the first with
 * settings, a status worth showing and lists that only exist while another
 * program is running. Everything it publishes is a variable, so a key can bind
 * to it without knowing anything about OBS: a scene button lights up because
 * `obs.scene` equals its scene, not because the plugin reached in and coloured
 * it.
 *
 * Feedback comes from events rather than polling. OBS says what changed the
 * moment it changes, which is why the recording key turns red when the
 * recording is stopped from OBS's own window — the deck is showing the truth,
 * not its own last instruction.
 */

export const OBS_PLUGIN_ID = 'ed.obs';

/**
 * "Whatever is on air" and "whatever is queued next", as answers in their own
 * right.
 *
 * A key showing the live scene must not name one, or it stops being about the
 * live scene the moment somebody switches. Written with a character no OBS
 * scene name can start with, so neither can ever collide with a real name.
 */
const PROGRAM = '@program';
const PREVIEW = '@preview';

/**
 * What a thumbnail is asked for at, and what it costs.
 *
 * Measured against OBS 31 on the developer's machine: a 128-pixel JPEG at this
 * quality came back in about a millisecond and weighed five kilobytes, and ten
 * in a row took fourteen milliseconds altogether. A scene that is *not* on air
 * cost the same as one that is — the fear that OBS would have to render it
 * specially turned out to be unfounded.
 *
 * PNG was measured too, at thirty-eight kilobytes for the same picture. The
 * panel re-encodes whatever it is given anyway, so the larger one buys nothing
 * on the way in.
 */
const SHOT_FORMAT = 'jpg';
const SHOT_SIZE = 144;
const SHOT_QUALITY = 70;

/**
 * How often a level reaches a key.
 *
 * OBS sends twenty a second. A key is looked at rather than watched, and
 * twenty repaints a second would be twenty pictures down the USB cable — so
 * what reaches it is the loudest moment of each half-second rather than every
 * sample of it.
 */
const METER_INTERVAL_MS = 500;

/** Where amber starts and where red starts, as shares of the scale. */
const WARN_AT = 0.75;
const HOT_AT = 0.92;

export const obsManifest: PluginManifest = {
  id: OBS_PLUGIN_ID,
  name: { en: 'OBS', ru: 'OBS' },
  cover: "plugin:ed.obs/assets/logo.webp",
  description: {
    en: 'Scenes, streaming, recording and audio in OBS Studio',
    ru: 'Сцены, стрим, запись и звук в OBS Studio',
  },
  version: '1.0.0',
  apiVersion: PLUGIN_API_VERSION,

  /*
   * What OBS can put on a key that a variable cannot.
   *
   * Everything this plugin publishes as a variable is a word or a number, and
   * words and numbers already go on a key through its label. A widget is worth
   * having only where the answer is a *picture*, and OBS has exactly one thing
   * of that kind worth the trouble: what a scene actually looks like.
   */
  surfaces: [
    {
      type: 'ed.obs.thumbnail',
      label: { en: 'Scene thumbnail', ru: 'Миниатюра сцены' },
      description: {
        en: 'What a scene or a source looks like right now, on the key that switches to it',
        ru: 'Как сейчас выглядит сцена или источник — на клавише, которая её включает',
      },
      icon: 'page',
      params: [
        {
          name: 'source',
          type: 'select',
          optionsFrom: 'shootable',
          label: { en: 'What to show', ru: 'Что показывать' },
          default: PROGRAM,
          emptyNote: {
            en: 'OBS is not running, so it cannot say what it has',
            ru: 'OBS не запущен, поэтому список сцен взять неоткуда',
          },
        },
        {
          /*
           * How often, chosen rather than fixed. A key showing what is on air
           * wants a second; a key showing the scene you switch to at the end
           * of a stream is as good at a minute, and cheaper.
           *
           * Not offered faster than a second on purpose. A screenshot costs
           * OBS a real capture, and a key is looked at, not watched.
           */
          name: 'every',
          type: 'select',
          label: { en: 'Refresh', ru: 'Обновлять' },
          default: '5',
          options: [
            { value: '1', label: { en: 'Every second', ru: 'Раз в секунду' } },
            { value: '5', label: { en: 'Every 5 seconds', ru: 'Раз в 5 секунд' } },
            { value: '10', label: { en: 'Every 10 seconds', ru: 'Раз в 10 секунд' } },
            { value: '30', label: { en: 'Every 30 seconds', ru: 'Раз в 30 секунд' } },
            { value: '60', label: { en: 'Every minute', ru: 'Раз в минуту' } },
          ],
        },
      ],
    },

    /*
     * The level of a sound, which is the other thing no variable can say.
     *
     * `obs.mute(Микрофон)` answers whether the microphone is switched on. It
     * cannot answer whether anybody can hear you — a live microphone with a
     * dead cable reads exactly the same as a working one. That is a shape
     * moving twenty times a second, and it belongs on the key you would press
     * to fix it.
     */
    {
      type: 'ed.obs.meter',
      label: { en: 'Level meter', ru: 'Индикатор уровня' },
      description: {
        en: 'How loud an input actually is, as a strip along the key',
        ru: 'Насколько громок вход на самом деле — полоской по краю клавиши',
      },
      icon: 'mute',
      params: [
        {
          /*
           * Several, because one bar on a key is a key that has told you about
           * one microphone and spent itself doing it. A mixer is read by
           * comparing the bars against each other.
           */
          name: 'inputs',
          type: 'list',
          optionsFrom: 'audio-inputs',
          label: { en: 'Sources', ru: 'Источники' },
          description: {
            en: 'Drawn in the order listed, sharing one scale so they can be compared',
            ru: 'Рисуются в порядке списка, по общей шкале — чтобы их можно было сравнивать',
          },
          emptyNote: {
            en: 'OBS is not running, so it cannot say what it has',
            ru: 'OBS не запущен, поэтому список источников взять неоткуда',
          },
        },
        {
          name: 'direction',
          type: 'select',
          label: { en: 'Bars', ru: 'Полоски' },
          default: 'bottom',
          options: [
            { value: 'bottom', label: { en: 'Lying, stacked upward', ru: 'Лежат, стопкой снизу вверх' } },
            { value: 'side', label: { en: 'Standing, side by side', ru: 'Стоят рядом, слева направо' } },
          ],
        },
        {
          name: 'thickness',
          type: 'number',
          label: { en: 'How much of the key, %', ru: 'Сколько от клавиши, %' },
          default: 100,
          min: 2,
          max: 100,
          description: {
            en: 'Less than all of it leaves room for a label saying which inputs these are',
            ru: 'Меньше ста оставляет место для подписи, какие это входы',
          },
        },
        { name: 'calm', type: 'color', label: { en: 'Quiet', ru: 'Тихо' }, default: '#3fb950' },
        { name: 'loud', type: 'color', label: { en: 'Loud', ru: 'Громко' }, default: '#d29922' },
        { name: 'hot', type: 'color', label: { en: 'Too loud', ru: 'Перегруз' }, default: '#f85149' },
        {
          name: 'track',
          type: 'color',
          label: { en: 'The trough behind a bar', ru: 'Подложка под полоской' },
          default: '#ffffff20',
          required: false,
          description: {
            en: 'Without it a silent input draws nothing, and you cannot tell which bar is which',
            ru: 'Без неё молчащий вход не рисует ничего, и не понять, где какая полоска',
          },
        },
        {
          name: 'background',
          type: 'color',
          label: { en: 'Behind the meter', ru: 'Фон индикатора' },
          required: false,
          description: {
            en: "Empty lets the key's own background show through",
            ru: 'Пусто — виден собственный фон клавиши',
          },
        },
      ],
    },
  ],

  settings: [
    {
      /*
       * Nothing special to the host: an ordinary boolean setting the plugin
       * reads for itself.
       *
       * Which is the point — any plugin can have one, and it means whatever
       * that plugin decides. Here it means "open the socket": a machine with
       * no OBS on it should not have something knocking on port 4455 every
       * half minute for ever, and a plugin that connects the moment it is
       * installed is a plugin that fails before anybody has configured it.
       */
      name: 'enabled',
      type: 'boolean',
      label: { en: 'Connect to OBS', ru: 'Подключаться к OBS' },
      default: false,
      required: false,
    },
    {
      name: 'host',
      type: 'string',
      label: { en: 'Address', ru: 'Адрес' },
      default: '127.0.0.1',
      description: {
        en: 'Leave as it is unless OBS runs on another machine',
        ru: 'Оставьте как есть, если OBS не на другом компьютере',
      },
    },
    {
      name: 'port',
      type: 'number',
      label: { en: 'Port', ru: 'Порт' },
      default: 4455,
      min: 1,
      max: 65535,
    },
    {
      name: 'password',
      type: 'string',
      secret: true,
      required: false,
      label: { en: 'Password', ru: 'Пароль' },
      description: {
        en: 'From Tools → WebSocket Server Settings in OBS',
        ru: 'Из «Инструменты → Настройки сервера WebSocket» в OBS',
      },
    },
  ],

  commands: [{ name: 'reconnect', label: { en: 'Reconnect', ru: 'Переподключиться' }, icon: 'link' }],

  variables: [
    {
      name: 'ed.obs.connected',
      type: 'boolean',
      label: { en: 'OBS connected', ru: 'OBS подключён' },
      initial: false,
    },
    { name: 'ed.obs.scene', type: 'string', label: { en: 'Current scene', ru: 'Текущая сцена' } },
    {
      name: 'ed.obs.streaming',
      type: 'boolean',
      label: { en: 'Streaming', ru: 'Идёт трансляция' },
      initial: false,
    },
    {
      name: 'ed.obs.recording',
      type: 'boolean',
      label: { en: 'Recording', ru: 'Идёт запись' },
      initial: false,
    },
    {
      name: 'ed.obs.recording-paused',
      type: 'boolean',
      label: { en: 'Recording paused', ru: 'Запись на паузе' },
      initial: false,
    },
    {
      name: 'ed.obs.replay-buffer',
      type: 'boolean',
      label: { en: 'Replay buffer on', ru: 'Буфер повтора включён' },
      initial: false,
    },
    {
      name: 'ed.obs.virtual-cam',
      type: 'boolean',
      label: { en: 'Virtual camera on', ru: 'Виртуальная камера включена' },
      initial: false,
    },

    {
      /*
       * True between the transition starting and ending.
       *
       * OBS reports both edges, so this is knowable rather than guessed from
       * a duration — which matters because a transition can be stopped, and a
       * key counting down a timer would then lie until the timer ran out.
       */
      name: 'ed.obs.transitioning',
      type: 'boolean',
      label: { en: 'Transition running', ru: 'Идёт переход' },
      initial: false,
    },
    {
      name: 'ed.obs.transition-name',
      type: 'string',
      label: { en: 'Current transition', ru: 'Текущий переход' },
    },
    {
      name: 'ed.obs.transition-duration',
      type: 'number',
      label: { en: 'Transition, ms', ru: 'Длительность перехода, мс' },
      initial: 0,
    },

    /*
     * Families: one declaration each, however many inputs and sources the
     * user has. The key carries which one — `obs.mute(Микрофон)` — and only
     * the keys a profile actually reads are ever asked about or published.
     */
    {
      name: 'ed.obs.mute',
      type: 'boolean',
      label: { en: 'Muted', ru: 'Звук выключен' },
      argument: {
        label: { en: 'Source', ru: 'Источник' },
        optionsFrom: 'audio-inputs',
      },
    },
    {
      name: 'ed.obs.volume',
      type: 'number',
      label: { en: 'Volume, dB', ru: 'Громкость, дБ' },
      argument: {
        label: { en: 'Source', ru: 'Источник' },
        optionsFrom: 'audio-inputs',
      },
    },
    {
      name: 'ed.obs.monitor',
      type: 'enum',
      label: { en: 'Monitoring', ru: 'Прослушивание' },
      options: [
        { value: 'off', label: { en: 'Off', ru: 'Выключено' } },
        { value: 'monitor', label: { en: 'Monitor only', ru: 'Только слушать' } },
        { value: 'both', label: { en: 'Monitor and output', ru: 'Слушать и выводить' } },
      ],
      argument: {
        label: { en: 'Source', ru: 'Источник' },
        optionsFrom: 'audio-inputs',
      },
    },
    {
      name: 'ed.obs.filter',
      type: 'boolean',
      label: { en: 'Filter on', ru: 'Фильтр включён' },
      argument: {
        label: { en: 'Source', ru: 'Источник' },
        optionsFrom: 'sources',
        then: { label: { en: 'Filter', ru: 'Фильтр' }, optionsFrom: 'filters' },
      },
    },
    {
      name: 'ed.obs.visible',
      type: 'boolean',
      label: { en: 'Source shown', ru: 'Источник показан' },
      argument: {
        label: { en: 'Scene', ru: 'Сцена' },
        optionsFrom: 'scenes',
        then: { label: { en: 'Source', ru: 'Источник' }, optionsFrom: 'scene-sources' },
      },
    },
  ],

  actions: [
    {
      type: 'ed.obs.set-scene',
      icon: 'page',
      label: { en: 'Switch scene', ru: 'Переключить сцену' },
      params: [
        {
          name: 'scene',
          type: 'select',
          optionsFrom: 'scenes',
          label: { en: 'Scene', ru: 'Сцена' },
          placeholder: { en: 'Name of the scene', ru: 'Название сцены' },
        },
      ],
      group: { en: 'Scenes', ru: 'Сцены' },
    },
    {
      type: 'ed.obs.preview-scene',
      icon: 'page',
      label: { en: 'Set preview scene', ru: 'Сцена в предпросмотр' },
      description: {
        en: 'Studio mode only: puts a scene in the preview without going live',
        ru: 'Только в студийном режиме: ставит сцену в предпросмотр, не выпуская в эфир',
      },
      params: [
        {
          name: 'scene',
          type: 'select',
          optionsFrom: 'scenes',
          label: { en: 'Scene', ru: 'Сцена' },
        },
      ],
      group: { en: 'Scenes', ru: 'Сцены' },
    },
    {
      type: 'ed.obs.transition',
      icon: 'back',
      label: { en: 'Transition', ru: 'Переход' },
      description: {
        en: 'Studio mode only: sends the preview to the stream',
        ru: 'Только в студийном режиме: отправляет предпросмотр в эфир',
      },
      params: [],
      group: { en: 'Scenes', ru: 'Сцены' },
    },

    {
      type: 'ed.obs.toggle-stream',
      presetOnly: true,
      icon: 'globe',
      label: { en: 'Start / stop stream', ru: 'Начать / завершить трансляцию' },
      params: [],
      group: { en: 'Broadcast', ru: 'Эфир' },
    },
    {
      type: 'ed.obs.toggle-record',
      presetOnly: true,
      icon: 'stop',
      label: { en: 'Start / stop recording', ru: 'Начать / остановить запись' },
      params: [],
      group: { en: 'Broadcast', ru: 'Эфир' },
    },
    {
      type: 'ed.obs.toggle-record-pause',
      icon: 'play-pause',
      label: { en: 'Pause / resume recording', ru: 'Пауза / продолжить запись' },
      params: [],
      group: { en: 'Broadcast', ru: 'Эфир' },
    },
    {
      type: 'ed.obs.toggle-replay-buffer',
      presetOnly: true,
      icon: 'previous',
      label: { en: 'Replay buffer on / off', ru: 'Буфер повтора вкл / выкл' },
      params: [],
      group: { en: 'Broadcast', ru: 'Эфир' },
    },
    {
      type: 'ed.obs.save-replay',
      icon: 'next',
      label: { en: 'Save replay', ru: 'Сохранить повтор' },
      params: [],
      group: { en: 'Broadcast', ru: 'Эфир' },
    },
    {
      type: 'ed.obs.toggle-virtual-cam',
      presetOnly: true,
      icon: 'app',
      label: { en: 'Virtual camera on / off', ru: 'Виртуальная камера вкл / выкл' },
      params: [],
      group: { en: 'Broadcast', ru: 'Эфир' },
    },

    {
      type: 'ed.obs.toggle-mute',
      icon: 'mute',
      label: { en: 'Mute / unmute', ru: 'Выключить / включить звук' },
      params: [
        {
          name: 'input',
          type: 'select',
          optionsFrom: 'audio-inputs',
          label: { en: 'Source', ru: 'Источник' },
          placeholder: { en: 'Name of the audio source', ru: 'Название источника звука' },
        },
      ],
      group: { en: 'Audio', ru: 'Звук' },
    },
    {
      type: 'ed.obs.set-volume',
      icon: 'volume-up',
      label: { en: 'Set volume', ru: 'Задать громкость' },
      description: {
        en: 'In decibels, as OBS shows them: 0 is unchanged, −60 is silence',
        ru: 'В децибелах, как показывает OBS: 0 — без изменения, −60 — тишина',
      },
      params: [
        {
          name: 'input',
          type: 'select',
          optionsFrom: 'audio-inputs',
          label: { en: 'Source', ru: 'Источник' },
        },
        {
          name: 'db',
          type: 'number',
          label: { en: 'Volume, dB', ru: 'Громкость, дБ' },
          default: 0,
          min: -100,
          max: 26,
        },
      ],
      group: { en: 'Audio', ru: 'Звук' },
    },
    {
      type: 'ed.obs.adjust-volume',
      icon: 'volume-down',
      label: { en: 'Change volume', ru: 'Изменить громкость' },
      description: {
        en: 'Adds to the current volume; a negative number turns it down',
        ru: 'Прибавляет к текущей громкости; отрицательное число убавляет',
      },
      params: [
        {
          name: 'input',
          type: 'select',
          optionsFrom: 'audio-inputs',
          label: { en: 'Source', ru: 'Источник' },
        },
        {
          name: 'db',
          type: 'number',
          label: { en: 'Change, dB', ru: 'Изменение, дБ' },
          default: -3,
          min: -50,
          max: 50,
        },
      ],
      group: { en: 'Audio', ru: 'Звук' },
    },

    {
      type: 'ed.obs.set-monitor',
      icon: 'keyboard',
      label: { en: 'Set monitoring', ru: 'Прослушивание источника' },
      description: {
        en: 'Whether you hear the source yourself, and whether the stream does',
        ru: 'Слышите ли источник вы сами и попадает ли он в трансляцию',
      },
      params: [
        {
          name: 'input',
          type: 'select',
          optionsFrom: 'audio-inputs',
          label: { en: 'Source', ru: 'Источник' },
        },
        {
          name: 'monitor',
          type: 'select',
          label: { en: 'Monitoring', ru: 'Прослушивание' },
          options: [
            { value: 'off', label: { en: 'Off', ru: 'Выключено' } },
            { value: 'monitor', label: { en: 'Monitor only', ru: 'Только слушать' } },
            { value: 'both', label: { en: 'Monitor and output', ru: 'Слушать и выводить' } },
          ],
          default: 'monitor',
        },
      ],
      group: { en: 'Audio', ru: 'Звук' },
    },

    {
      type: 'ed.obs.toggle-filter',
      icon: 'toggle',
      label: { en: 'Filter on / off', ru: 'Фильтр вкл / выкл' },
      description: {
        en: 'Any filter OBS lists on the source, audio or visual alike',
        ru: 'Любой фильтр источника — что звуковой, что визуальный',
      },
      params: [
        {
          name: 'source',
          type: 'select',
          optionsFrom: 'sources',
          label: { en: 'Source', ru: 'Источник' },
        },
        {
          /*
           * Depends on the source above: OBS keeps filters per source, and
           * the list is asked for again whenever that box changes.
           *
           * And now waits for it, rather than sitting there empty. A form that
           * offers two boxes, one of which cannot answer until the other is
           * filled, is a puzzle about which to fill first.
           */
          name: 'filter',
          type: 'select',
          optionsFrom: 'filters',
          dependsOn: ['source'],
          emptyNote: {
            en: 'OBS lists no filters on that source',
            ru: 'OBS не показывает фильтров у этого источника',
          },
          label: { en: 'Filter', ru: 'Фильтр' },
        },
      ],
      group: { en: 'Filters', ru: 'Фильтры' },
    },

    {
      type: 'ed.obs.toggle-source',
      icon: 'folder',
      label: { en: 'Show / hide source', ru: 'Показать / скрыть источник' },
      params: [
        {
          name: 'scene',
          type: 'select',
          optionsFrom: 'scenes',
          label: { en: 'Scene', ru: 'Сцена' },
        },
        {
          name: 'source',
          type: 'select',
          optionsFrom: 'sources',
          dependsOn: ['scene'],
          emptyNote: {
            en: 'That scene has nothing in it',
            ru: 'В этой сцене ничего нет',
          },
          label: { en: 'Source', ru: 'Источник' },
        },
      ],
      group: { en: 'Audio', ru: 'Звук' },
    },
  ],

  presets: [
    lamp(
      'stream',
      { en: 'Stream', ru: 'Трансляция' },
      { en: 'Starts and stops the stream, and shows whether it is live', ru: 'Запускает и останавливает трансляцию и показывает, идёт ли она' },
      'ed.obs.streaming',
      'ed.obs.toggle-stream',
      { off: 'Stream', on: 'LIVE' },
      '#7a2c2c',
    ),
    lamp(
      'record',
      { en: 'Recording', ru: 'Запись' },
      { en: 'Starts and stops recording, and shows whether it is running', ru: 'Запускает и останавливает запись и показывает, идёт ли она' },
      'ed.obs.recording',
      'ed.obs.toggle-record',
      { off: 'Record', on: '● REC' },
      '#7a2c2c',
    ),
    lamp(
      'replay',
      { en: 'Replay buffer', ru: 'Буфер повтора' },
      { en: 'Turns the replay buffer on and off', ru: 'Включает и выключает буфер повтора' },
      'ed.obs.replay-buffer',
      'ed.obs.toggle-replay-buffer',
      { off: 'Replay', on: 'Replay on' },
      '#2f5d3a',
    ),
    lamp(
      'virtual-cam',
      { en: 'Virtual camera', ru: 'Виртуальная камера' },
      { en: 'Turns the virtual camera on and off', ru: 'Включает и выключает виртуальную камеру' },
      'ed.obs.virtual-cam',
      'ed.obs.toggle-virtual-cam',
      { off: 'Cam', on: 'Cam on' },
      '#2f5d3a',
    ),
    {
      name: 'current-scene',
      label: { en: 'Current scene', ru: 'Текущая сцена' },
      description: {
        en: 'Shows which scene is live, and does nothing when pressed',
        ru: 'Показывает, какая сцена в эфире; на нажатие не реагирует',
      },
      button: {
        states: [
          {
            id: 'default',
            visual: { background: '#22303c', label: { text: '{{obs.scene}}', fontSize: 12 } },
          },
        ],
      },
    },
  ],
};

/**
 * A key that both does a thing and shows whether the thing is on.
 *
 * The shape every OBS toggle wants, written once. Two states bound to a
 * boolean: OBS reports the change whoever caused it, so pressing Start in
 * OBS's own window lights the key on the desk.
 *
 * The words on the key are English and short — LIVE, REC — rather than
 * translated. A label goes into the profile as plain text at the moment it is
 * dropped, so it would be frozen in whatever language the configurator
 * happened to be in; these are the words already printed on the equipment
 * this sits next to.
 */
function lamp(
  name: string,
  label: { en: string; ru: string },
  description: { en: string; ru: string },
  variable: string,
  action: string,
  text: { off: string; on: string },
  colour: string,
): ButtonPreset {
  const button: PresetButton = {
    stateFrom: variable,
    states: [
      {
        id: 'off',
        when: false,
        visual: { background: '#22303c', label: { text: text.off, fontSize: 13 } },
        actions: { press: [{ type: action }] },
      },
      {
        id: 'on',
        when: true,
        visual: { background: colour, label: { text: text.on, fontSize: 13 } },
        actions: { press: [{ type: action }] },
      },
    ],
  };

  return { name, label, description, button };
}

export interface ObsPluginOptions {
  /** Overridden by tests, which cannot spend a second per attempt. */
  readonly retryDelaysMs?: readonly number[];
}

/** A key a profile reads, split into what it asks about. */
interface Watch {
  readonly family: string;
  readonly first: string;
  readonly second?: string;
}

export class ObsPlugin implements Plugin {
  private connection?: ObsConnection;
  private host?: PluginHost;
  /**
   * What some profile reads, and therefore all this plugin reports on.
   *
   * Without it, publishing every input's volume and every source's visibility
   * in every scene would mean hundreds of requests on connect and hundreds of
   * values kept up to date so that a deck could show one of them.
   */
  private watching: readonly Watch[] = [];

  /**
   * The last picture taken of each source, and when.
   *
   * A surface is asked for on every repaint, and a repaint happens whenever
   * anything at all moves — so drawing straight from OBS here would take a
   * screenshot every time a clock ticked somewhere else on the page. The
   * picture is therefore kept, handed over as often as anybody asks, and
   * refreshed on the beat below.
   */
  private readonly shots = new Map<string, { source: string; at: number }>();

  /** What the thumbnails on screen are of, and how often each wants refreshing. */
  private wanted: readonly { source: string; everyMs: number }[] = [];
  private ticker?: Ticker;

  /** Inputs a meter on screen is showing, and therefore worth listening for. */
  private metered = new Set<string>();
  /** The loudest each of those has been since the last publish. */
  private readonly peaks = new Map<string, number>();
  /** What the meters are drawing, which changes on the beat and not before. */
  private readonly levels = new Map<string, number>();
  private meterBeat?: Ticker;

  constructor(private readonly options: ObsPluginOptions = {}) {}

  start(host: PluginHost): void {
    this.host = host;
    this.connect();
    host.onSettingsChanged(() => this.connect());

    host.onWatched((keys) => {
      this.watching = keys.map(parseWatch).filter((watch): watch is Watch => watch !== undefined);
      // Read at once rather than at the next connect: a key added while OBS
      // is running should start showing something immediately.
      if (this.connection?.connected) void this.readWatched();
    });

    host.provideSurface('ed.obs.thumbnail', async (request) => this.thumbnail(request));
    host.provideSurface('ed.obs.meter', async (request) => this.meter(request));

    /*
     * Levels are published on a beat of their own rather than as they arrive.
     *
     * OBS sends twenty a second; a key is looked at, not watched, and twenty
     * repaints a second would be twenty pictures down the USB cable. What is
     * published every half-second is the *peak* since the last one, not the
     * latest sample — a clap between two samples is exactly what a meter is
     * for, and taking the last value would throw away thirty-nine readings in
     * forty and miss it.
     */
    this.meterBeat = host.update(0, () => this.publishLevels());

    /*
     * Which thumbnails are on screen decides both what is photographed and how
     * often. A page with no OBS key on it costs nothing at all, and a page
     * with one minute-refresh key costs one screenshot a minute — neither of
     * which the plugin could work out for itself.
     */
    host.onWidgets((widgets) => {
      this.wanted = widgets
        .filter((widget) => widget.type === 'ed.obs.thumbnail')
        .map((widget) => ({
          source: String(widget.params['source'] ?? PROGRAM),
          everyMs: Math.max(1, Number(widget.params['every']) || 5) * 1000,
        }));

      /*
       * The meters on screen decide whether OBS is asked for levels at all.
       *
       * Twenty events a second carrying every input, arriving whether or not
       * anybody is looking, is exactly the flood the ordinary subscription set
       * leaves out. Asked for while a meter is on a page and dropped when the
       * page turns — which is the thing `onWidgets` was built for.
       */
      this.metered = new Set(
        widgets
          .filter((widget) => widget.type === 'ed.obs.meter')
          .flatMap((widget) => readList(widget.params['inputs'])),
      );

      this.connection?.subscribeExtra(this.metered.size > 0 ? VOLUME_METERS : 0);
      this.meterBeat?.every(this.metered.size > 0 ? METER_INTERVAL_MS : 0);
      if (this.metered.size === 0) {
        this.peaks.clear();
        this.levels.clear();
      }

      this.retime();
      void this.refresh();
    });

    // Registered stopped: what is worth photographing depends on what is on
    // screen, and at this point nothing has said.
    this.ticker = host.update(0, () => this.refresh());
  }

  stop(): void {
    this.ticker?.stop();
    this.meterBeat?.stop();
    this.ticker = undefined;
    this.meterBeat = undefined;
    this.connection?.stop();
    this.connection = undefined;
  }

  // --- thumbnails -----------------------------------------------------------

  /**
   * The last picture of whatever this key names.
   *
   * Nothing until the first one has been taken, which is a key showing its own
   * still or nothing at all — the same as any other widget that is not ready.
   */
  private thumbnail(request: SurfaceRequest): SurfaceFrame | undefined {
    const kept = this.shots.get(String(request.params['source'] ?? PROGRAM));
    return kept ? { source: kept.source } : undefined;
  }

  // --- levels ---------------------------------------------------------------

  /**
   * Keeps the loudest moment of each input until the next publish.
   *
   * Every event carries every input; only the ones a key is showing are kept,
   * which is most of the saving. What is kept is the maximum, because a level
   * is about the loudest thing that happened and not about whenever the last
   * sample happened to land.
   */
  private onMeters(data: Record<string, unknown>): void {
    const inputs = (data['inputs'] as { inputName?: string; inputLevelsMul?: number[][] }[]) ?? [];

    for (const input of inputs) {
      const name = String(input.inputName ?? '');
      if (!this.metered.has(name)) continue;

      let loudest = 0;
      for (const channel of input.inputLevelsMul ?? []) {
        /*
         * The largest of whatever the channel carries.
         *
         * obs-websocket documents three numbers per channel, and on the
         * machine this was measured on only the third ever moved — the first
         * two were flat zero for every input, loud or quiet. Taking the
         * largest means the meter works whichever of them a given build fills
         * in, and costs nothing to do.
         */
        for (const value of channel) loudest = Math.max(loudest, Number(value) || 0);
      }

      this.peaks.set(name, Math.max(this.peaks.get(name) ?? 0, loudest));
    }
  }

  /** Hands the held peaks to the keys, and starts holding again from nothing. */
  private publishLevels(): void {
    let changed = false;

    for (const name of this.metered) {
      const level = levelOf(this.peaks.get(name) ?? 0);
      // Rounded before comparing: a bar is a hundred pixels wide at most, and
      // the fourth decimal place of a level is a repaint for nobody.
      const shown = Math.round(level * 100) / 100;

      if (this.levels.get(name) !== shown) {
        this.levels.set(name, shown);
        changed = true;
      }
    }

    this.peaks.clear();
    if (changed) this.host?.redraw();
  }

  private meter(request: SurfaceRequest): SurfaceFrame | undefined {
    const inputs = readList(request.params['inputs']);
    // Nothing until the first levels have arrived, which is a key showing
    // whatever it was given to show meanwhile.
    if (inputs.length === 0 || !inputs.some((name) => this.levels.has(name))) return undefined;

    const levels = inputs.map((name) => this.levels.get(name) ?? 0);

    const colour = (key: string, fallback: string): string =>
      typeof request.params[key] === 'string' && request.params[key] !== ''
        ? (request.params[key] as string)
        : fallback;

    const background = colour('background', '');
    const track =
      request.params['track'] === undefined ? '#ffffff20' : String(request.params['track']);

    const source = drawMeter(
      levels,
      {
        vertical: request.params['direction'] === 'side',
        thickness: (Number(request.params['thickness']) || 100) / 100,
        calm: colour('calm', '#3fb950'),
        loud: colour('loud', '#d29922'),
        hot: colour('hot', '#f85149'),
        /*
         * Absent is a different thing from empty, and this is the line that
         * keeps them apart: nobody has chosen means the default trough, and
         * somebody clearing the field means no trough at all.
         */
        ...(track === '' ? {} : { track }),
        ...(background ? { background } : {}),
        warnAt: WARN_AT,
        hotAt: HOT_AT,
      },
      request.cols,
      request.rows,
    );

    return { source };
  }

  /**
   * A beat as often as the most impatient thumbnail on screen.
   *
   * The beat is the plugin's and the interval is the key's, so this is the
   * shortest of them: a page holding a one-second key and a one-minute key
   * beats every second, and the minute one is simply not due most of the time.
   */
  private retime(): void {
    const soonest = this.wanted.reduce(
      (least, one) => Math.min(least, one.everyMs),
      Number.POSITIVE_INFINITY,
    );

    this.ticker?.every(Number.isFinite(soonest) ? soonest : 0);
  }

  /** Takes a new picture of everything that is due, and asks for a repaint. */
  private async refresh(): Promise<void> {
    const connection = this.connection;
    if (!connection?.connected || this.wanted.length === 0) return;

    const now = Date.now();
    const due = new Map<string, number>();
    for (const one of this.wanted) {
      const taken = this.shots.get(one.source)?.at ?? 0;
      // The shortest interval wins where two keys show the same source: they
      // share one picture, and the impatient key is the one to satisfy.
      if (now - taken >= one.everyMs) due.set(one.source, one.everyMs);
    }

    if (due.size === 0) return;

    let changed = false;
    for (const source of due.keys()) {
      const picture = await this.shoot(connection, source);
      if (picture === undefined) continue;

      const before = this.shots.get(source)?.source;
      this.shots.set(source, { source: picture, at: now });
      if (picture !== before) changed = true;
    }

    // Only when something actually looks different. A still scene photographed
    // every second produces the same bytes, and asking every deck to paint
    // over that would be work for nothing.
    if (changed) this.host?.redraw();
  }

  /**
   * One screenshot, with the two standing answers resolved first.
   *
   * `@program` and `@preview` are looked up on every shot rather than
   * remembered: a key showing what is on air has to follow the switch, and
   * that is the whole reason it does not name a scene.
   */
  private async shoot(connection: ObsConnection, source: string): Promise<string | undefined> {
    try {
      let name = source;

      if (source === PROGRAM || source === PREVIEW) {
        const scenes = await connection.request<{
          currentProgramSceneName?: string;
          currentPreviewSceneName?: string;
        }>('GetSceneList');

        name = String(
          (source === PROGRAM ? scenes.currentProgramSceneName : scenes.currentPreviewSceneName) ?? '',
        );

        // Studio mode is off, so there is no preview scene to photograph.
        if (name === '') return undefined;
      }

      const shot = await connection.request<{ imageData?: string }>('GetSourceScreenshot', {
        sourceName: name,
        imageFormat: SHOT_FORMAT,
        imageWidth: SHOT_SIZE,
        imageHeight: SHOT_SIZE,
        imageCompressionQuality: SHOT_QUALITY,
      });

      // Already a data URL, which is exactly what a frame wants.
      return typeof shot.imageData === 'string' && shot.imageData !== '' ? shot.imageData : undefined;
    } catch (cause) {
      // A scene that has been renamed or deleted since the key named it, or a
      // source that cannot be photographed. The key shows its last picture, or
      // none; saying so once in the log is the whole of what is useful.
      this.host?.log('warn', `Cannot photograph '${source}': ${describe(cause)}`);
      return undefined;
    }
  }

  /** Used by the settings window's Reconnect button. */
  reconnect(): void {
    this.connect();
  }

  /**
   * Drops whatever connection there is and opens one from current settings.
   *
   * Every setting here is worth a reconnect — address, port and password are
   * all part of the handshake — so the plugin does not try to be clever about
   * which changed.
   */
  private connect(): void {
    const host = this.host;
    if (!host) return;

    this.connection?.stop();
    this.connection = undefined;
    this.clearVariables();

    const settings = host.settings();

    if (settings['enabled'] !== true) {
      host.setStatus('off');
      return;
    }

    this.connection = new ObsConnection({
      ...(this.options.retryDelaysMs ? { retryDelaysMs: this.options.retryDelaysMs } : {}),
      host: String(settings['host'] ?? '127.0.0.1'),
      port: Number(settings['port'] ?? 4455),
      password: String(settings['password'] ?? ''),
      onEvent: (type, data) => this.onEvent(type, data),
      onState: (state, message) => {
        host.setStatus(state, message ? { en: message } : undefined);
        host.setVariable('ed.obs.connected', state === 'ready');
        if (state === 'ready') {
          void this.readEverything();
          // Whatever was photographed belongs to the OBS that has just gone;
          // taking new pictures at once is what makes a key come back to life
          // rather than show a scene from before the restart.
          void this.refresh();
        } else {
          this.clearVariables();
        }
      },
      log: (level, message) => host.log(level, message),
    });

    // A fresh connection knows nothing of what the last one was asked for, and
    // the meters on screen did not go anywhere while it was being replaced.
    this.connection.subscribeExtra(this.metered.size > 0 ? VOLUME_METERS : 0);

    this.registerOptions(host);
    this.connection.start();
  }

  /**
   * The lists a configurator offers while OBS is running.
   *
   * Registered once rather than per connection: the loader runs when somebody
   * opens the parameter, and answering "none" while disconnected is exactly
   * what the field falls back to a plain box for.
   */
  private registerOptions(host: PluginHost): void {
    host.provideOptions('scenes', async () => {
      const data = await this.require().request<{ scenes?: { sceneName?: string }[] }>('GetSceneList');
      // OBS lists them top-first as they appear in its own panel, which is
      // upside down compared to how anybody describes their scenes.
      return [...(data.scenes ?? [])]
        .reverse()
        .map((scene) => String(scene.sceneName ?? ''))
        .filter((name) => name !== '')
        .map((name) => ({ value: name, label: { en: name } }));
    });

    /*
     * Everything OBS will let you mute, asked of OBS rather than guessed.
     *
     * This used to keep a list of the input *kinds* that carry sound —
     * `wasapi_input_capture` and its cousins — which is a list of the audio
     * devices somebody plugs in, and quietly left out every other source that
     * has audio: a media source, a browser source, application audio capture.
     * They sit in OBS's own mixer and were missing from every mute, volume and
     * monitoring field here, and from `obs.mute(…)` with them.
     *
     * A kind list can only ever be as current as the day it was written, and
     * OBS gains source kinds. So each input is asked whether it has audio at
     * all, and the ones that say no are the ones left out. That is one small
     * request per input, paid only when somebody opens the field.
     */
    /*
     * Everything a thumbnail can be taken of, with the two standing answers
     * first because they are what most keys want.
     *
     * Scenes and sources in one list rather than two fields. A key showing a
     * picture does not care which kind of thing it is a picture of, and asking
     * would be a field whose only purpose is to shorten the next one.
     */
    host.provideOptions('shootable', async () => {
      const connection = this.require();

      const scenes = await connection.request<{ scenes?: { sceneName?: string }[] }>('GetSceneList');
      const inputs = await connection.request<{ inputs?: { inputName?: string }[] }>('GetInputList');

      const named = (name: string, prefix: string): ParamOption => ({
        value: name,
        label: { en: `${prefix} ${name}` },
      });

      return [
        { value: PROGRAM, label: { en: 'What is on air', ru: 'Что в эфире' } },
        { value: PREVIEW, label: { en: 'What is queued (studio mode)', ru: 'Что на превью (студийный режим)' } },
        ...[...(scenes.scenes ?? [])]
          .reverse()
          .map((scene) => String(scene.sceneName ?? ''))
          .filter((name) => name !== '')
          .map((name) => named(name, '🎬')),
        ...(inputs.inputs ?? [])
          .map((input) => String(input.inputName ?? ''))
          .filter((name) => name !== '')
          .map((name) => named(name, '▪')),
      ];
    });

    host.provideOptions('audio-inputs', async () => {
      const connection = this.require();
      const data = await connection.request<{ inputs?: { inputName?: string }[] }>('GetInputList');

      const names = (data.inputs ?? [])
        .map((input) => String(input.inputName ?? ''))
        .filter((name) => name !== '');

      const audible = await Promise.all(
        names.map(async (name) => {
          try {
            // A source with no audio is refused, which is the answer being
            // asked for. Not logged: it is the ordinary case, not a fault.
            await connection.request('GetInputAudioTracks', { inputName: name });
            return name;
          } catch {
            return undefined;
          }
        }),
      );

      return audible
        .filter((name): name is string => name !== undefined)
        .map((name) => ({ value: name, label: { en: name } }));
    });

    /*
     * The sources of one scene, for the second half of `obs.visible(…)`.
     *
     * Takes its scene from whichever the caller has: an action names its
     * parameters, a variable's argument is simply "the one before this".
     */
    host.provideOptions('scene-sources', async (params) => {
      const sceneName = String(params['scene'] ?? params['argument'] ?? '');
      if (sceneName === '') return [];

      const data = await this.require().request<{ sceneItems?: { sourceName?: string }[] }>(
        'GetSceneItemList',
        { sceneName },
      );
      return (data.sceneItems ?? [])
        .map((item) => String(item.sourceName ?? ''))
        .filter((name) => name !== '')
        .map((name) => ({ value: name, label: { en: name } }));
    });

    host.provideOptions('filters', async (params) => {
      const sourceName = String(params['source'] ?? params['argument'] ?? '');
      if (sourceName === '') return [];

      const data = await this.require().request<{ filters?: { filterName?: string }[] }>(
        'GetSourceFilterList',
        { sourceName },
      );
      return (data.filters ?? [])
        .map((filter) => String(filter.filterName ?? ''))
        .filter((name) => name !== '')
        .map((name) => ({ value: name, label: { en: name } }));
    });

    host.provideOptions('sources', async () => {
      const data = await this.require().request<{ inputs?: { inputName?: string }[] }>('GetInputList');
      return (data.inputs ?? [])
        .map((input) => String(input.inputName ?? ''))
        .filter((name) => name !== '')
        .map((name) => ({ value: name, label: { en: name } }));
    });
  }

  /**
   * Asks OBS for everything a key might be showing.
   *
   * On connect only. Afterwards events carry the changes, and asking again
   * would be both slower and less correct — an answer in flight while
   * something changes is an answer that arrives already stale.
   */
  private async readEverything(): Promise<void> {
    const host = this.host;
    const connection = this.connection;
    if (!host || !connection) return;

    try {
      const scenes = await connection.request<{ currentProgramSceneName?: string }>('GetSceneList');
      host.setVariable('ed.obs.scene', String(scenes.currentProgramSceneName ?? ''));

      const stream = await connection.request<{ outputActive?: boolean }>('GetStreamStatus');
      host.setVariable('ed.obs.streaming', stream.outputActive === true);

      const record = await connection.request<{ outputActive?: boolean; outputPaused?: boolean }>(
        'GetRecordStatus',
      );
      host.setVariable('ed.obs.recording', record.outputActive === true);
      host.setVariable('ed.obs.recording-paused', record.outputPaused === true);

      const replay = await connection.request<{ outputActive?: boolean }>('GetReplayBufferStatus');
      host.setVariable('ed.obs.replay-buffer', replay.outputActive === true);

      const camera = await connection.request<{ outputActive?: boolean }>('GetVirtualCamStatus');
      host.setVariable('ed.obs.virtual-cam', camera.outputActive === true);

      const transition = await connection.request<{
        transitionName?: string;
        transitionDuration?: number;
      }>('GetCurrentSceneTransition');
      host.setVariable('ed.obs.transition-name', String(transition.transitionName ?? ''));
      host.setVariable('ed.obs.transition-duration', Number(transition.transitionDuration ?? 0));
      host.setVariable('ed.obs.transitioning', false);

      await this.readWatched();
    } catch (cause) {
      // A refused status request is not worth dropping the connection over:
      // the replay buffer is absent on some builds, and the rest still works.
      host.log('warn', `Could not read the whole of OBS's state: ${describe(cause)}`);
    }
  }

  /**
   * Asks OBS about exactly what some profile reads, and nothing else.
   *
   * One request per key: there is no bulk form for "the mute state of these
   * six inputs", and six requests on connect is a price worth paying for not
   * making sixty.
   */
  private async readWatched(): Promise<void> {
    const host = this.host;
    const connection = this.connection;
    if (!host || !connection?.connected) return;

    for (const watch of this.watching) {
      try {
        await this.readOne(connection, host, watch);
      } catch (cause) {
        // A source that has been renamed or deleted since the profile was
        // written. Cleared rather than left at its last value, and reported
        // once — the key it feeds simply shows nothing.
        host.setFamily(watch.family, argumentOf(watch), undefined);
        host.log('warn', `Cannot read ${watch.family} for '${argumentOf(watch)}': ${describe(cause)}`);
      }
    }
  }

  private async readOne(
    connection: ObsConnection,
    host: PluginHost,
    watch: Watch,
  ): Promise<void> {
    const argument = argumentOf(watch);

    switch (watch.family) {
      case 'ed.obs.mute': {
        const data = await connection.request<{ inputMuted?: boolean }>('GetInputMute', {
          inputName: watch.first,
        });
        host.setFamily(watch.family, argument, data.inputMuted === true);
        return;
      }

      case 'ed.obs.volume': {
        const data = await connection.request<{ inputVolumeDb?: number }>('GetInputVolume', {
          inputName: watch.first,
        });
        // Rounded to a tenth: the mixer moves in small steps and a key that
        // repaints over the fourth decimal place is a key that flickers.
        host.setFamily(watch.family, argument, round(Number(data.inputVolumeDb ?? 0)));
        return;
      }

      case 'ed.obs.monitor': {
        const data = await connection.request<{ monitorType?: string }>('GetInputAudioMonitorType', {
          inputName: watch.first,
        });
        host.setFamily(watch.family, argument, monitorName(String(data.monitorType ?? '')));
        return;
      }

      case 'ed.obs.filter': {
        if (!watch.second) return;
        const data = await connection.request<{ filterEnabled?: boolean }>('GetSourceFilter', {
          sourceName: watch.first,
          filterName: watch.second,
        });
        host.setFamily(watch.family, argument, data.filterEnabled === true);
        return;
      }

      case 'ed.obs.visible': {
        if (!watch.second) return;
        const found = await connection.request<{ sceneItemId?: number }>('GetSceneItemId', {
          sceneName: watch.first,
          sourceName: watch.second,
        });
        const data = await connection.request<{ sceneItemEnabled?: boolean }>('GetSceneItemEnabled', {
          sceneName: watch.first,
          sceneItemId: Number(found.sceneItemId),
        });
        host.setFamily(watch.family, argument, data.sceneItemEnabled === true);
        return;
      }

      default:
        return;
    }
  }

  private onEvent(type: string, data: Record<string, unknown>): void {
    const host = this.host;
    if (!host) return;

    switch (type) {
      case 'CurrentProgramSceneChanged':
        host.setVariable('ed.obs.scene', String(data['sceneName'] ?? ''));
        return;
      case 'StreamStateChanged':
        host.setVariable('ed.obs.streaming', data['outputActive'] === true);
        return;
      case 'RecordStateChanged':
        host.setVariable('ed.obs.recording', data['outputActive'] === true);
        // Stopping clears the pause: OBS does not send a separate event for it.
        if (data['outputActive'] !== true) host.setVariable('ed.obs.recording-paused', false);
        return;
      case 'RecordStateChangedPaused':
      case 'RecordPauseStateChanged':
        host.setVariable('ed.obs.recording-paused', data['outputPaused'] === true);
        return;
      case 'ReplayBufferStateChanged':
        host.setVariable('ed.obs.replay-buffer', data['outputActive'] === true);
        return;
      case 'VirtualcamStateChanged':
        host.setVariable('ed.obs.virtual-cam', data['outputActive'] === true);
        return;

      case 'SceneTransitionStarted':
        host.setVariable('ed.obs.transitioning', true);
        host.setVariable('ed.obs.transition-name', String(data['transitionName'] ?? ''));
        return;

      /*
       * Ended, not VideoEnded: the video part of a stinger finishes before
       * the transition does, and a key that lit up again mid-stinger would be
       * lying for the rest of it.
       */
      case 'SceneTransitionEnded':
        host.setVariable('ed.obs.transitioning', false);
        return;

      case 'CurrentSceneTransitionChanged':
        host.setVariable('ed.obs.transition-name', String(data['transitionName'] ?? ''));
        return;

      case 'CurrentSceneTransitionDurationChanged':
        host.setVariable('ed.obs.transition-duration', Number(data['transitionDuration'] ?? 0));
        return;

      /*
       * The mixer and the scene, as they change.
       *
       * Only keys somebody is watching are written: OBS reports every input
       * it has, and publishing the lot would put back exactly the flood that
       * watching was meant to avoid.
       */
      // Twenty a second while a meter is on screen, and never otherwise. Not
      // published here: see `publishLevels` for why it is held instead.
      case 'InputVolumeMeters':
        this.onMeters(data);
        return;

      case 'InputMuteStateChanged':
        this.publishIfWatched('ed.obs.mute', String(data['inputName'] ?? ''), data['inputMuted'] === true);
        return;

      case 'InputVolumeChanged':
        this.publishIfWatched(
          'ed.obs.volume',
          String(data['inputName'] ?? ''),
          round(Number(data['inputVolumeDb'] ?? 0)),
        );
        return;

      case 'InputAudioMonitorTypeChanged':
        this.publishIfWatched(
          'ed.obs.monitor',
          String(data['inputName'] ?? ''),
          monitorName(String(data['monitorType'] ?? '')),
        );
        return;

      case 'SourceFilterEnableStateChanged':
        this.publishIfWatched(
          'ed.obs.filter',
          `${String(data['sourceName'] ?? '')}, ${String(data['filterName'] ?? '')}`,
          data['filterEnabled'] === true,
        );
        return;

      /*
       * A scene item is identified by a number, and the event carries only
       * that — so the source's name is looked up, once, against the keys we
       * are already watching in that scene.
       */
      case 'SceneItemEnableStateChanged':
        void this.publishSceneItem(
          String(data['sceneName'] ?? ''),
          Number(data['sceneItemId']),
          data['sceneItemEnabled'] === true,
        );
        return;

      /*
       * Sources and scenes get renamed, and a watched key then names
       * something that no longer exists. Re-reading settles both halves: the
       * old key clears, the new one starts reporting if a profile reads it.
       */
      case 'InputNameChanged':
      case 'SceneNameChanged':
      case 'SceneListChanged':
        void this.readWatched();
        return;
      default:
        return;
    }
  }

  /** Writes a family value only where some profile reads it. */
  private publishIfWatched(family: string, argument: string, value: VariableValue): void {
    const watched = this.watching.some(
      (watch) => watch.family === family && argumentOf(watch) === argument,
    );
    if (watched) this.host?.setFamily(family, argument, value);
  }

  /** Turns a scene item's number back into the name a profile would use. */
  private async publishSceneItem(
    sceneName: string,
    sceneItemId: number,
    enabled: boolean,
  ): Promise<void> {
    const connection = this.connection;
    if (!connection?.connected || !Number.isFinite(sceneItemId)) return;

    for (const watch of this.watching) {
      if (watch.family !== 'ed.obs.visible' || watch.first !== sceneName || !watch.second) continue;

      try {
        const found = await connection.request<{ sceneItemId?: number }>('GetSceneItemId', {
          sceneName,
          sourceName: watch.second,
        });
        if (Number(found.sceneItemId) === sceneItemId) {
          this.host?.setFamily(watch.family, argumentOf(watch), enabled);
        }
      } catch {
        // The item went away between the event and the question. The next
        // read settles it.
      }
    }
  }

  /** Clears what is no longer known, rather than leaving it looking current. */
  private clearVariables(): void {
    const host = this.host;
    if (!host) return;

    host.setVariable('ed.obs.connected', false);
    host.setVariable('ed.obs.scene', '');
    host.setVariable('ed.obs.streaming', false);
    host.setVariable('ed.obs.recording', false);
    host.setVariable('ed.obs.recording-paused', false);
    host.setVariable('ed.obs.replay-buffer', false);
    host.setVariable('ed.obs.virtual-cam', false);
    host.setVariable('ed.obs.transitioning', false);
    host.setVariable('ed.obs.transition-name', '');
    host.setVariable('ed.obs.transition-duration', 0);
  }

  private require(): ObsConnection {
    const connection = this.connection;
    if (!connection || !connection.connected) throw new Error('OBS is not connected');
    return connection;
  }

  /** The code behind the actions, bound to this instance's connection. */
  handlers(): Record<string, ActionHandler> {
    const send = (requestType: string, requestData?: Record<string, unknown>) => async () => {
      await this.require().request(requestType, requestData);
    };

    return {
      'ed.obs.set-scene': async (params) =>
        void (await this.require().request('SetCurrentProgramScene', {
          sceneName: stringParam(params, 'scene'),
        })),

      'ed.obs.preview-scene': async (params) =>
        void (await this.require().request('SetCurrentPreviewScene', {
          sceneName: stringParam(params, 'scene'),
        })),

      'ed.obs.transition': send('TriggerStudioModeTransition'),
      'ed.obs.toggle-stream': send('ToggleStream'),
      'ed.obs.toggle-record': send('ToggleRecord'),
      'ed.obs.toggle-record-pause': send('ToggleRecordPause'),
      'ed.obs.toggle-replay-buffer': send('ToggleReplayBuffer'),
      'ed.obs.save-replay': send('SaveReplayBuffer'),
      'ed.obs.toggle-virtual-cam': send('ToggleVirtualCam'),

      /**
       * Volume in decibels, which is what OBS's own mixer shows.
       *
       * The alternative is a multiplier from zero to one, where the numbers
       * on screen and the numbers in the profile would disagree.
       */
      'ed.obs.set-volume': async (params) =>
        void (await this.require().request('SetInputVolume', {
          inputName: stringParam(params, 'input'),
          inputVolumeDb: numberParam(params, 'db', 0),
        })),

      /** Reads first, because "quieter" only means something relative. */
      'ed.obs.adjust-volume': async (params) => {
        const inputName = stringParam(params, 'input');
        const connection = this.require();

        const current = await connection.request<{ inputVolumeDb?: number }>('GetInputVolume', {
          inputName,
        });
        // Clamped to what OBS accepts: a key pressed a dozen times must not
        // wander off the end of the scale and start failing.
        const next = Math.min(
          26,
          Math.max(-100, Number(current.inputVolumeDb ?? 0) + numberParam(params, 'db', 0)),
        );

        await connection.request('SetInputVolume', { inputName, inputVolumeDb: next });
      },

      'ed.obs.set-monitor': async (params) =>
        void (await this.require().request('SetInputAudioMonitorType', {
          inputName: stringParam(params, 'input'),
          monitorType: monitorType(stringParam(params, 'monitor')),
        })),

      /**
       * Filters are one kind of thing to OBS.
       *
       * Its window sorts them into audio and visual for the eye, but the
       * protocol lists them together per source, so one action covers both —
       * a noise gate and a colour correction are toggled the same way.
       */
      'ed.obs.toggle-filter': async (params) => {
        const sourceName = stringParam(params, 'source');
        const filterName = stringParam(params, 'filter');
        const connection = this.require();

        const state = await connection.request<{ filterEnabled?: boolean }>('GetSourceFilter', {
          sourceName,
          filterName,
        });

        await connection.request('SetSourceFilterEnabled', {
          sourceName,
          filterName,
          filterEnabled: state.filterEnabled !== true,
        });
      },

      'ed.obs.toggle-mute': async (params) =>
        void (await this.require().request('ToggleInputMute', {
          inputName: stringParam(params, 'input'),
        })),

      /**
       * Shows or hides a source, which takes two requests.
       *
       * OBS identifies an item by a number that is only meaningful inside its
       * scene, so the name has to be resolved first. Toggling rather than
       * setting: a key that hides a source and cannot show it again would be
       * half a key.
       */
      'ed.obs.toggle-source': async (params) => {
        const sceneName = stringParam(params, 'scene');
        const sourceName = stringParam(params, 'source');
        const connection = this.require();

        const found = await connection.request<{ sceneItemId?: number }>('GetSceneItemId', {
          sceneName,
          sourceName,
        });
        const sceneItemId = Number(found.sceneItemId);

        const state = await connection.request<{ sceneItemEnabled?: boolean }>('GetSceneItemEnabled', {
          sceneName,
          sceneItemId,
        });

        await connection.request('SetSceneItemEnabled', {
          sceneName,
          sceneItemId,
          sceneItemEnabled: state.sceneItemEnabled !== true,
        });
      },
    };
  }
}

/**
 * Builds the running parts.
 *
 * Exported apart from the default so the tests can pass options — short
 * retry delays, a fake to connect to. The host always takes the defaults.
 */
export function activateWith(options: ObsPluginOptions = {}): PluginActivation {
  const plugin = new ObsPlugin(options);

  return {
    plugin,
    handlers: plugin.handlers(),
    commands: { reconnect: () => plugin.reconnect() },
  };
}

export default definePlugin({ manifest: obsManifest, activate: () => activateWith() });

/**
 * `obs.mute(Микрофон)` and `obs.visible(Игра, Веб-камера)`.
 *
 * A comma separates the two halves of a pair, which is the one shape a source
 * name is unlikely to contain and the one a person would write anyway.
 */
function parseWatch(key: string): Watch | undefined {
  const { family, argument } = parseVariableKey(key);
  if (argument === undefined || argument === '') return undefined;

  const comma = argument.indexOf(',');
  if (comma < 0) return { family, first: argument.trim() };

  return {
    family,
    first: argument.slice(0, comma).trim(),
    second: argument.slice(comma + 1).trim(),
  };
}

const argumentOf = (watch: Watch): string =>
  watch.second === undefined ? watch.first : `${watch.first}, ${watch.second}`;

/** Back the other way, for the action that sets it. */
function monitorType(name: string): string {
  if (name === 'both') return 'OBS_MONITORING_TYPE_MONITOR_AND_OUTPUT';
  if (name === 'monitor') return 'OBS_MONITORING_TYPE_MONITOR_ONLY';
  return 'OBS_MONITORING_TYPE_NONE';
}

/** OBS's own names for monitoring, as something a person would bind to. */
function monitorName(type: string): string {
  if (type.endsWith('MONITOR_AND_OUTPUT')) return 'both';
  if (type.endsWith('MONITOR_ONLY')) return 'monitor';
  return 'off';
}

/** A tenth of a decibel: the mixer's own resolution, and no flicker below it. */
const round = (db: number): number => Math.round(db * 10) / 10;

function describe(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}
