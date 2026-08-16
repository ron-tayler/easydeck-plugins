import {
  PLUGIN_API_VERSION,
  definePlugin,
  numberParam,
  parseVariableKey,
  stringParam,
} from '@easydeck/plugin-sdk';
import type {
  ActionHandler,
  ParamOption,
  Plugin,
  PluginActivation,
  PluginHost,
  PluginManifest,
} from '@easydeck/plugin-sdk';

import { authenticate, authorize, REDIRECT_URI, SCOPES } from './discord-auth.js';
import { DiscordIpc } from './discord-ipc.js';

/**
 * Discord, as a deck sees it.
 *
 * The three keys anybody actually wants — mute, deafen, leave — and the
 * awkward thing about all three is that they are *client* state. No bot can
 * see them and no server is told about them; they exist in the Discord window
 * on this machine, which is why this plugin talks to a pipe rather than to an
 * API.
 *
 * **Everybody registers their own application.** Discord does not allow
 * unapproved apps to use RPC except for their owner and fifty invited
 * testers, so an application shipped inside this plugin would work for its
 * author and nobody else. Two fields in the settings, once, and the person is
 * the owner of the app they are using. See discord-auth.ts.
 *
 * **Voice settings are held exclusively.** While this plugin has changed
 * them, other RPC clients cannot — Discord grants them to one app at a time
 * and resets them when it disconnects. That is Discord's rule and not
 * something to work around, but it is worth knowing before running this
 * beside another deck program.
 */

export const DISCORD_PLUGIN_ID = 'ed.discord';

/**
 * How often the channel is looked at again.
 *
 * Voice state events say who joined and left, and are subscribed to — this is
 * the safety net for the cases they miss: a channel changed while the socket
 * was down, or a subscription that failed quietly. Slow on purpose.
 */
const POLL_INTERVAL_MS = 15_000;

/**
 * The argument that means "whichever channel you are in".
 *
 * An empty one, because `variableKey` gives a family with no argument its
 * bare name — which is what makes `{{ed.discord.members}}` a key somebody can
 * write beside `{{ed.discord.members(1234)}}`.
 */
const NO_CHANNEL = '';

export const discordManifest: PluginManifest = {
  id: DISCORD_PLUGIN_ID,
  name: { en: 'Discord', ru: 'Discord' },
  author: { en: 'EasyDeck', ru: 'EasyDeck' },
  cover: "plugin:ed.discord/assets/logo.webp",
  description: {
    en: 'Mute, deafen, voice channels and who is talking',
    ru: 'Микрофон, наушники, голосовые каналы и кто говорит',
  },
  version: '1.2.0',
  apiVersion: PLUGIN_API_VERSION,

  settings: [
    {
      // Off until asked, like every plugin that holds a socket: a machine
      // with no Discord on it should not be knocking on ten pipes for ever.
      name: 'enabled',
      type: 'boolean',
      label: { en: 'Connect to Discord', ru: 'Подключаться к Discord' },
      default: false,
      required: false,
    },
    {
      name: 'clientId',
      type: 'string',
      required: false,
      label: { en: 'Application ID', ru: 'ID приложения' },
      description: {
        en: `From discord.com/developers — make an application, and add ${REDIRECT_URI} to its OAuth2 redirects. Discord only allows RPC for an app's own owner, which is why this is yours rather than ours`,
        ru: `С discord.com/developers — создайте приложение и добавьте ${REDIRECT_URI} в его OAuth2-редиректы. Discord пускает в RPC только владельца приложения, поэтому оно ваше, а не наше`,
      },
    },
    {
      /*
       * A secret because it is one, and because the exchange needs it.
       *
       * The code Discord hands back over the pipe is worthless on its own:
       * turning it into a token is an HTTPS call signed with this.
       */
      name: 'clientSecret',
      type: 'string',
      secret: true,
      required: false,
      label: { en: 'Client secret', ru: 'Client secret' },
      description: {
        en: 'From the OAuth2 page of the same application',
        ru: 'Со страницы OAuth2 того же приложения',
      },
    },
    {
      /*
       * Granted by the dialog, not typed by anybody.
       *
       * Kept as an ordinary secret setting so it is sealed like the rest and
       * so somebody can see at a glance whether they are authorised. The
       * plugin writes it itself through `remember`.
       */
      name: 'token',
      type: 'string',
      secret: true,
      internal: true,
      required: false,
      label: { en: 'Access token', ru: 'Токен доступа' },
    },
  ],

  commands: [
    {
      name: 'authorise',
      label: { en: 'Authorise', ru: 'Авторизовать' },
      icon: 'link',
      description: {
        en: 'Discord will ask you to allow the application — switch to it and press Authorize',
        ru: 'Discord попросит разрешить приложение — переключитесь в него и нажмите «Авторизовать»',
      },
    },
    { name: 'reconnect', label: { en: 'Reconnect', ru: 'Переподключиться' }, icon: 'link' },
  ],

  variables: [
    {
      name: 'ed.discord.connected',
      type: 'boolean',
      label: { en: 'Discord connected', ru: 'Discord подключён' },
      initial: false,
    },
    {
      name: 'ed.discord.muted',
      type: 'boolean',
      label: { en: 'Microphone muted', ru: 'Микрофон выключен' },
      initial: false,
    },
    {
      name: 'ed.discord.deafened',
      type: 'boolean',
      label: { en: 'Deafened', ru: 'Звук выключен' },
      initial: false,
    },
    {
      name: 'ed.discord.input-volume',
      type: 'number',
      label: { en: 'Microphone volume, %', ru: 'Громкость микрофона, %' },
    },
    {
      name: 'ed.discord.output-volume',
      type: 'number',
      label: { en: 'Output volume, %', ru: 'Громкость звука, %' },
    },
    {
      /*
       * What a channel is called — and which channel is a question.
       *
       * With no argument it is the one you are in, and empty when you are in
       * none, which is how a key knows to offer "join". With a channel named
       * it is that channel's name as it is right now: a key labelled from
       * this follows a rename instead of quietly lying about where it sends
       * you.
       */
      name: 'ed.discord.channel',
      type: 'string',
      label: { en: 'Voice channel', ru: 'Голосовой канал' },
      argument: {
        label: { en: 'Channel', ru: 'Канал' },
        description: {
          en: 'Leave empty for the channel you are in',
          ru: 'Оставьте пустым для того канала, где вы сейчас',
        },
        optionsFrom: 'channels',
      },
    },
    {
      /*
       * How many people are in a channel — and which channel is a question.
       *
       * With no argument it is the one you are in, which is what a key beside
       * the mute button wants. With a channel named, it is that channel
       * whether or not you are in it, which is what a key that says "eight
       * people are in Общий" wants — the one you press to go and join them.
       *
       * Only the channels a key actually asks about are watched: see
       * `onWatched`. Otherwise every channel of every server would be polled
       * so that one number could be shown.
       */
      name: 'ed.discord.members',
      type: 'number',
      label: { en: 'People in the channel', ru: 'Человек в канале' },
      initial: 0,
      argument: {
        label: { en: 'Channel', ru: 'Канал' },
        description: {
          en: 'Leave empty for the channel you are in',
          ru: 'Оставьте пустым для того канала, где вы сейчас',
        },
        optionsFrom: 'channels',
      },
    },
    {
      name: 'ed.discord.speaking',
      type: 'string',
      label: { en: 'Who is talking', ru: 'Кто говорит' },
      description: {
        en: 'The names of everyone talking right now, or empty when the channel is quiet',
        ru: 'Имена всех, кто говорит сейчас; пусто, когда в канале тихо',
      },
    },
    {
      /*
       * Whether *you* are talking, which is not the same question.
       *
       * A key that lights up while you hold push-to-talk binds to this; a key
       * showing the room binds to the one above.
       */
      name: 'ed.discord.talking',
      type: 'boolean',
      label: { en: 'You are talking', ru: 'Вы говорите' },
      initial: false,
    },
  ],

  actions: [
    {
      type: 'ed.discord.mute',
      icon: 'mute',
      label: { en: 'Microphone', ru: 'Микрофон' },
      params: [
        {
          name: 'mode',
          type: 'select',
          default: 'toggle',
          label: { en: 'What to do', ru: 'Что сделать' },
          options: [
            { value: 'toggle', label: { en: 'Toggle', ru: 'Переключить' } },
            { value: 'on', label: { en: 'Mute', ru: 'Выключить' } },
            { value: 'off', label: { en: 'Unmute', ru: 'Включить' } },
          ],
        },
      ],
    },
    {
      type: 'ed.discord.deafen',
      icon: 'speaker',
      label: { en: 'Deafen', ru: 'Оглушить' },
      description: {
        en: 'Turns your own sound off. Discord mutes the microphone with it, and this reports that',
        ru: 'Выключает звук у вас. Discord заодно выключает микрофон, и плагин это показывает',
      },
      params: [
        {
          name: 'mode',
          type: 'select',
          default: 'toggle',
          label: { en: 'What to do', ru: 'Что сделать' },
          options: [
            { value: 'toggle', label: { en: 'Toggle', ru: 'Переключить' } },
            { value: 'on', label: { en: 'Deafen', ru: 'Оглушить' } },
            { value: 'off', label: { en: 'Undeafen', ru: 'Вернуть звук' } },
          ],
        },
      ],
    },
    {
      type: 'ed.discord.volume',
      icon: 'increment',
      label: { en: 'Volume', ru: 'Громкость' },
      params: [
        {
          name: 'which',
          type: 'select',
          default: 'input',
          label: { en: 'Which', ru: 'Чего' },
          options: [
            { value: 'input', label: { en: 'Microphone', ru: 'Микрофона' } },
            { value: 'output', label: { en: 'Sound', ru: 'Звука' } },
          ],
        },
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
          max: 200,
          label: { en: 'Per cent', ru: 'Проценты' },
          description: {
            en: 'Discord allows up to 200 for output, and 100 for the microphone',
            ru: 'Discord разрешает до 200 для звука и до 100 для микрофона',
          },
        },
      ],
    },
    {
      type: 'ed.discord.join',
      icon: 'app',
      label: { en: 'Join a voice channel', ru: 'Войти в голосовой канал' },
      description: {
        en: 'Pick a channel you can see. Leaving is the same action with nothing chosen',
        ru: 'Выберите канал из доступных. Выход — это же действие с пустым выбором',
      },
      params: [
        {
          name: 'channel',
          type: 'select',
          required: false,
          label: { en: 'Channel', ru: 'Канал' },
          optionsFrom: 'channels',
          emptyNote: {
            en: 'No voice channels — authorise first, and be in a server that has some',
            ru: 'Голосовых каналов нет — сначала авторизуйтесь и будьте на сервере, где они есть',
          },
          description: {
            en: 'Empty means leave whichever channel you are in',
            ru: 'Пусто — выйти из того канала, где вы сейчас',
          },
        },
      ],
    },
    {
      type: 'ed.discord.user-volume',
      icon: 'variable',
      label: { en: "Someone's volume", ru: 'Громкость собеседника' },
      description: {
        en: 'Turns one person up, down, or off — for you only',
        ru: 'Делает одного человека громче, тише или беззвучным — только у вас',
      },
      params: [
        {
          name: 'user',
          type: 'select',
          label: { en: 'Who', ru: 'Кто' },
          optionsFrom: 'members',
          emptyNote: {
            en: 'Nobody to list — this offers the people in your channel right now',
            ru: 'Некого перечислять — здесь те, кто сейчас в вашем канале',
          },
        },
        {
          name: 'mode',
          type: 'select',
          default: 'set',
          label: { en: 'What to do', ru: 'Что сделать' },
          options: [
            { value: 'set', label: { en: 'Set volume', ru: 'Задать громкость' } },
            { value: 'mute', label: { en: 'Mute them', ru: 'Заглушить' } },
            { value: 'unmute', label: { en: 'Unmute them', ru: 'Вернуть звук' } },
          ],
        },
        {
          name: 'value',
          type: 'number',
          default: 100,
          min: 0,
          max: 200,
          required: false,
          label: { en: 'Per cent', ru: 'Проценты' },
        },
      ],
    },
  ],

  presets: [
    {
      name: 'mute',
      label: { en: 'Microphone', ru: 'Микрофон' },
      button: {
        stateFrom: 'ed.discord.muted',
        states: [
          {
            id: 'live',
            when: false,
            visual: { background: '#2f6f4f', label: { text: 'Микрофон', fontSize: 13, position: 'center' } },
            actions: { press: [{ type: 'ed.discord.mute', params: { mode: 'toggle' } }] },
          },
          {
            id: 'muted',
            when: true,
            visual: { background: '#6f3535', label: { text: 'Выключен', fontSize: 13, position: 'center' } },
            actions: { press: [{ type: 'ed.discord.mute', params: { mode: 'toggle' } }] },
          },
        ],
      },
    },
    {
      name: 'deafen',
      label: { en: 'Deafen', ru: 'Оглушить' },
      button: {
        stateFrom: 'ed.discord.deafened',
        states: [
          {
            id: 'hearing',
            when: false,
            visual: { background: '#22303c', label: { text: 'Звук', fontSize: 13, position: 'center' } },
            actions: { press: [{ type: 'ed.discord.deafen', params: { mode: 'toggle' } }] },
          },
          {
            id: 'deafened',
            when: true,
            visual: { background: '#6f3535', label: { text: 'Оглушён', fontSize: 13, position: 'center' } },
            actions: { press: [{ type: 'ed.discord.deafen', params: { mode: 'toggle' } }] },
          },
        ],
      },
    },
    {
      name: 'channel',
      label: { en: 'Channel and who is in it', ru: 'Канал и кто в нём' },
      description: {
        en: 'The channel you are in and how many people are there',
        ru: 'Канал, в котором вы сидите, и сколько в нём человек',
      },
      button: {
        states: [
          {
            id: 'default',
            visual: {
              background: '#1a1c22',
              label: {
                text: '{{ed.discord.channel}}\n{{ed.discord.members}}',
                fontSize: 12,
                position: 'center',
              },
            },
          },
        ],
      },
    },
    {
      name: 'talking',
      label: { en: 'Who is talking', ru: 'Кто говорит' },
      button: {
        states: [
          {
            id: 'default',
            visual: {
              background: '#1a1c22',
              label: { text: '{{ed.discord.speaking}}', fontSize: 11, position: 'center' },
            },
          },
        ],
      },
    },
  ],
};

/** One person in the voice channel, as much of them as anything here needs. */
interface Member {
  readonly id: string;
  readonly name: string;
}

export interface DiscordPluginOptions {
  readonly retryDelaysMs?: readonly number[];
  /** Overridden by tests, which listen on a socket of their own. */
  readonly path?: string;
  /** Overridden by tests, which must not call Discord's token endpoint. */
  readonly fetcher?: typeof fetch;
}

export class DiscordPlugin implements Plugin {
  private ipc?: DiscordIpc;
  private host?: PluginHost;

  /** Who we are, once authenticated — needed to tell your own voice apart. */
  private me = '';
  /** The voice channel this person is in, and who is in it with them. */
  private channelId = '';
  private members: Member[] = [];
  /** Ids talking right now. A set because two people talk at once. */
  private readonly talking = new Set<string>();
  /** Channels offered by the picker, gathered from the servers we can see. */
  private channels: ParamOption[] = [];
  /**
   * Channels some key is showing a headcount for, and therefore the only ones
   * asked about.
   *
   * The bargain `onWatched` exists for: without it, showing one number would
   * mean polling every voice channel of every server this person is in.
   */
  private watching: readonly string[] = [];

  /** True while this plugin is writing a setting itself; see `connect`. */
  private storingToken = false;

  constructor(private readonly options: DiscordPluginOptions = {}) {}

  start(host: PluginHost): void {
    this.host = host;
    this.connect();
    host.onSettingsChanged(() => {
      if (this.storingToken) return;
      this.connect();
    });

    host.onWatched((keys) => {
      // Both families ask about a channel, and one question answers both, so
      // what is collected is the set of channels rather than of keys.
      this.watching = [
        ...new Set(
          keys
            .map((key) => parseVariableKey(key))
            .filter(
              (parsed) =>
                (parsed.family === 'ed.discord.members' ||
                  parsed.family === 'ed.discord.channel') &&
                parsed.argument,
            )
            .map((parsed) => parsed.argument!),
        ),
      ];

      // Read at once rather than at the next tick: a key added while Discord
      // is running should start showing something immediately.
      if (this.ipc?.connected) void this.readWatched();
    });

    host.provideOptions('channels', async () => this.channels);
    host.provideOptions('members', async () =>
      this.members.map<ParamOption>((member) => ({ value: member.id, label: { en: member.name } })),
    );

    /*
     * A slow beat behind the events.
     *
     * Voice state events cover joining and leaving; this catches what they
     * miss — a channel changed while the socket was down, a subscription that
     * failed quietly — without asking Discord anything most of the time.
     */
    host.update(POLL_INTERVAL_MS, async () => {
      if (!this.ipc?.connected) return;
      await this.readChannel();
      await this.readWatched();
    });
  }

  stop(): void {
    this.ipc?.stop();
    this.ipc = undefined;
  }

  reconnect(): void {
    this.connect();
  }

  /**
   * Asks Discord to ask the person, and keeps what comes back.
   *
   * Only from the button in the settings window: this puts a dialog in front
   * of whoever is at the keyboard, and a plugin that did it on its own would
   * do it in the middle of a stream.
   */
  async authorise(): Promise<void> {
    const host = this.require();
    const ipc = this.ipc;
    if (!ipc?.connected) throw new Error('Connect to Discord first');

    const clientId = String(host.settings()['clientId'] ?? '');
    const clientSecret = String(host.settings()['clientSecret'] ?? '');
    if (clientId === '' || clientSecret === '') {
      throw new Error('Fill in the application id and secret first');
    }

    host.setStatus('connecting', {
      en: 'Waiting for you to allow the application in Discord',
      ru: 'Ждём разрешения в окне Discord',
    });

    const token = await authorize(ipc, { clientId, clientSecret }, this.options.fetcher);

    this.storingToken = true;
    try {
      await host.remember('token', token);
    } finally {
      this.storingToken = false;
    }

    await this.authenticate(token);
  }

  // --- the connection -------------------------------------------------------

  private connect(): void {
    const host = this.host;
    if (!host) return;

    this.ipc?.stop();
    this.ipc = undefined;
    this.clearVariables();

    const settings = host.settings();
    if (settings['enabled'] !== true) {
      host.setStatus('off');
      return;
    }

    if (String(settings['clientId'] ?? '') === '') {
      host.setStatus('error', {
        en: 'No application id — make one at discord.com/developers and paste it above',
        ru: 'Нет ID приложения — создайте его на discord.com/developers и впишите выше',
      });
      return;
    }

    this.ipc = new DiscordIpc({
      ...(this.options.retryDelaysMs ? { retryDelaysMs: this.options.retryDelaysMs } : {}),
      ...(this.options.path ? { path: this.options.path } : {}),
      clientId: () => String(this.host?.settings()['clientId'] ?? ''),
      onEvent: (event, data) => this.onEvent(event, data),
      onState: (state, message) => this.onState(state, message),
      log: (level, text) => host.log(level, text),
    });

    this.ipc.start();
  }

  private onState(state: 'connecting' | 'ready' | 'error', message?: string): void {
    const host = this.require();

    if (state !== 'ready') {
      host.setStatus(state === 'error' ? 'error' : 'connecting', message ? { en: message } : undefined);
      host.setVariable('ed.discord.connected', false);
      if (state === 'error') this.clearVariables();
      return;
    }

    const token = String(host.settings()['token'] ?? '');
    if (token === '') {
      // Connected, and allowed to do nothing until somebody presses the
      // button. Which is the ordinary state before this has ever been done.
      host.setStatus('error', {
        en: 'Not authorised yet — press Authorise, then allow it in Discord',
        ru: 'Ещё не авторизован — нажмите «Авторизовать» и разрешите в Discord',
      });
      return;
    }

    void this.authenticate(token);
  }

  private async authenticate(token: string): Promise<void> {
    const host = this.require();
    const ipc = this.ipc;
    if (!ipc) return;

    try {
      const who = await authenticate(ipc, token);
      this.me = who.userId;

      host.setStatus('ready', who.name ? { en: who.name } : undefined);
      host.setVariable('ed.discord.connected', true);

      await this.watch();
      await this.readVoiceSettings();
      await this.readChannel();
      await this.readChannels();
      // Keys watching a channel by name were told to us before there was a
      // connection to ask through. Without this they show nothing until the
      // slow tick comes round, which on a deck that has just started is a
      // quarter of a minute of blank keys.
      await this.readWatched();
    } catch (cause) {
      // A token that stopped working is the common case here — revoked in
      // Discord's settings, or the application's secret changed.
      host.setStatus('error', {
        en: `Discord refused the token: ${describe(cause)} — press Authorise again`,
        ru: `Discord отклонил токен: ${describe(cause)} — нажмите «Авторизовать» ещё раз`,
      });
      host.setVariable('ed.discord.connected', false);
    }
  }

  /** The events worth hearing about, subscribed once per connection. */
  private async watch(): Promise<void> {
    const ipc = this.ipc;
    if (!ipc) return;

    for (const event of ['VOICE_SETTINGS_UPDATE', 'VOICE_CHANNEL_SELECT']) {
      await ipc.subscribe(event).catch((cause: unknown) => {
        this.host?.log('warn', `Could not watch ${event}: ${describe(cause)}`);
      });
    }
  }

  /**
   * Watches one channel: who is in it and who is talking.
   *
   * These need a channel id, so they are renewed whenever the person moves —
   * and the old ones are dropped, or Discord goes on reporting a room nobody
   * is in.
   */
  private async watchChannel(channelId: string, previous: string): Promise<void> {
    const ipc = this.ipc;
    if (!ipc) return;

    const events = ['SPEAKING_START', 'SPEAKING_STOP', 'VOICE_STATE_CREATE', 'VOICE_STATE_DELETE'];

    if (previous !== '') {
      for (const event of events) await ipc.unsubscribe(event, { channel_id: previous });
    }
    if (channelId === '') return;

    for (const event of events) {
      await ipc.subscribe(event, { channel_id: channelId }).catch((cause: unknown) => {
        this.host?.log('warn', `Could not watch ${event}: ${describe(cause)}`);
      });
    }
  }

  // --- what Discord says ----------------------------------------------------

  private onEvent(event: string, data: Record<string, unknown>): void {
    switch (event) {
      case 'VOICE_SETTINGS_UPDATE':
        this.publishVoiceSettings(data);
        return;

      case 'VOICE_CHANNEL_SELECT':
        // Moving between channels, and leaving: the id is null for the latter.
        void this.readChannel(String(data['channel_id'] ?? ''));
        return;

      case 'VOICE_STATE_CREATE':
      case 'VOICE_STATE_DELETE':
        // Somebody came or went. Read the room rather than patching the list:
        // the two events do not carry enough to keep a count honest.
        void this.readChannel();
        return;

      case 'SPEAKING_START':
        this.setTalking(String(data['user_id'] ?? ''), true);
        return;

      case 'SPEAKING_STOP':
        this.setTalking(String(data['user_id'] ?? ''), false);
        return;

      default:
        return;
    }
  }

  private async readVoiceSettings(): Promise<void> {
    try {
      this.publishVoiceSettings(await this.require4().command('GET_VOICE_SETTINGS'));
    } catch (cause) {
      this.host?.log('warn', `Could not read voice settings: ${describe(cause)}`);
    }
  }

  private publishVoiceSettings(data: Record<string, unknown>): void {
    const host = this.require();
    const input = data['input'] as { volume?: number } | undefined;
    const output = data['output'] as { volume?: number } | undefined;

    host.setVariable('ed.discord.muted', data['mute'] === true);
    host.setVariable('ed.discord.deafened', data['deaf'] === true);
    if (input?.volume !== undefined) host.setVariable('ed.discord.input-volume', Math.round(input.volume));
    if (output?.volume !== undefined) {
      host.setVariable('ed.discord.output-volume', Math.round(output.volume));
    }
  }

  /**
   * Which channel this person is in, and who is in it with them.
   *
   * Answers nothing when they are in no channel, which is not an error — it
   * is most of the day.
   */
  private async readChannel(known?: string): Promise<void> {
    const host = this.require();
    const ipc = this.ipc;
    if (!ipc?.connected) return;

    try {
      const channel = await ipc.command<{
        id?: string;
        name?: string;
        voice_states?: { user?: { id?: string; username?: string; global_name?: string }; nick?: string }[];
      }>('GET_SELECTED_VOICE_CHANNEL');

      const id = String(channel?.id ?? known ?? '');
      const previous = this.channelId;
      this.channelId = id;

      this.members = (channel?.voice_states ?? []).map<Member>((state) => ({
        id: String(state.user?.id ?? ''),
        // What this person is called here: the server nickname first, because
        // that is the name on screen in Discord itself.
        name: String(state.nick ?? state.user?.global_name ?? state.user?.username ?? ''),
      }));

      // No argument means "the channel you are in", which `variableKey` gives
      // a family its bare name for.
      host.setFamily('ed.discord.channel', NO_CHANNEL, String(channel?.name ?? ''));
      // No argument means "the channel you are in", which `variableKey` gives
      // a family its bare name for.
      host.setFamily('ed.discord.members', NO_CHANNEL, this.members.length);

      // And if a key happens to be watching this very channel by name, it is
      // the same answer and should not wait for the next tick.
      if (id !== '') {
        host.setFamily('ed.discord.members', id, this.members.length);
        host.setFamily('ed.discord.channel', id, String(channel?.name ?? ''));
      }

      if (id !== previous) {
        // Talking is about a room, and the room changed.
        this.talking.clear();
        this.publishTalking();
        await this.watchChannel(id, previous);
      }
    } catch (cause) {
      this.host?.log('warn', `Could not read the voice channel: ${describe(cause)}`);
    }
  }

  /**
   * How many people are in each channel a key is asking about.
   *
   * One question per channel, and only for channels on screen. A channel that
   * cannot be read — no longer there, or not visible to this account — is
   * cleared rather than left showing yesterday's number, which is the one
   * thing worse than showing none.
   */
  private async readWatched(): Promise<void> {
    const host = this.require();
    const ipc = this.ipc;
    if (!ipc?.connected) return;

    for (const channelId of this.watching) {
      try {
        const channel = await ipc.command<{ name?: string; voice_states?: unknown[] }>(
          'GET_CHANNEL',
          { channel_id: channelId },
        );

        // The name as well as the count, from the one question: a key labelled
        // with a channel should follow a rename rather than keep the name it
        // was set up with.
        host.setFamily('ed.discord.members', channelId, (channel.voice_states ?? []).length);
        host.setFamily('ed.discord.channel', channelId, String(channel.name ?? ''));
      } catch {
        host.setFamily('ed.discord.members', channelId, undefined);
        host.setFamily('ed.discord.channel', channelId, undefined);
      }
    }
  }

  /** Every voice channel this person could be told to join. */
  private async readChannels(): Promise<void> {
    const ipc = this.ipc;
    if (!ipc?.connected) return;

    try {
      const guilds = await ipc.command<{ guilds?: { id?: string; name?: string }[] }>('GET_GUILDS');
      const found: ParamOption[] = [];

      for (const guild of guilds.guilds ?? []) {
        if (!guild.id) continue;

        const channels = await ipc.command<{
          channels?: { id?: string; name?: string; type?: number }[];
        }>('GET_CHANNELS', { guild_id: guild.id });

        for (const channel of channels.channels ?? []) {
          // Type 2 is a voice channel; everything else is text, a category or
          // a stage, and none of them can be joined by voice.
          if (channel.type !== 2 || !channel.id) continue;
          found.push({
            value: channel.id,
            label: { en: `${guild.name ?? '?'} · ${channel.name ?? channel.id}` },
          });
        }
      }

      this.channels = found;
    } catch (cause) {
      // A list nobody can offer is a field somebody types an id into, which
      // is the same fallback every dynamic parameter has.
      this.host?.log('warn', `Could not list channels: ${describe(cause)}`);
    }
  }

  private setTalking(userId: string, talking: boolean): void {
    if (userId === '') return;

    if (talking) this.talking.add(userId);
    else this.talking.delete(userId);

    this.publishTalking();
  }

  private publishTalking(): void {
    const host = this.require();
    const names = [...this.talking]
      .map((id) => this.members.find((member) => member.id === id)?.name ?? '')
      .filter((name) => name !== '');

    host.setVariable('ed.discord.speaking', names.join(', '));
    host.setVariable('ed.discord.talking', this.me !== '' && this.talking.has(this.me));
  }

  private clearVariables(): void {
    const host = this.host;
    if (!host) return;

    this.talking.clear();
    this.members = [];
    this.channelId = '';

    for (const name of [
      'ed.discord.connected',
      'ed.discord.muted',
      'ed.discord.deafened',
      'ed.discord.input-volume',
      'ed.discord.output-volume',
      'ed.discord.speaking',
      'ed.discord.talking',
    ]) {
      host.setVariable(name, undefined);
    }

    host.setFamily('ed.discord.members', NO_CHANNEL, 0);
    host.setFamily('ed.discord.channel', NO_CHANNEL, undefined);
    for (const channelId of this.watching) {
      host.setFamily('ed.discord.members', channelId, undefined);
      host.setFamily('ed.discord.channel', channelId, undefined);
    }
  }

  // --- acting ---------------------------------------------------------------

  handlers(): Record<string, ActionHandler> {
    return {
      'ed.discord.mute': async (params) => {
        const current = await this.require4().command<{ mute?: boolean }>('GET_VOICE_SETTINGS');
        const mode = String(params['mode'] ?? 'toggle');
        const mute = mode === 'toggle' ? current.mute !== true : mode === 'on';

        await this.require4().command('SET_VOICE_SETTINGS', { mute });
        // Published at once rather than waited for: the update event follows,
        // but a key that took a round trip to change looks broken.
        this.require().setVariable('ed.discord.muted', mute);
      },

      'ed.discord.deafen': async (params) => {
        const current = await this.require4().command<{ deaf?: boolean }>('GET_VOICE_SETTINGS');
        const mode = String(params['mode'] ?? 'toggle');
        const deaf = mode === 'toggle' ? current.deaf !== true : mode === 'on';

        await this.require4().command('SET_VOICE_SETTINGS', { deaf });
        this.require().setVariable('ed.discord.deafened', deaf);

        // Discord mutes the microphone along with deafening, and says so in
        // the event that follows — but a key bound to the microphone should
        // not wait for it.
        if (deaf) this.require().setVariable('ed.discord.muted', true);
      },

      'ed.discord.volume': async (params) => {
        const which = String(params['which'] ?? 'input') === 'output' ? 'output' : 'input';
        const step = numberParam(params, 'value', 10);
        const mode = String(params['mode'] ?? 'up');

        const current = await this.require4().command<Record<string, { volume?: number }>>(
          'GET_VOICE_SETTINGS',
        );
        const now = current[which]?.volume ?? 100;

        // Discord's own ceilings: the microphone stops at 100, the output
        // goes to 200. Sending more is refused rather than clamped.
        const ceiling = which === 'output' ? 200 : 100;
        const wanted = mode === 'set' ? step : mode === 'down' ? now - step : now + step;
        const volume = Math.round(Math.max(0, Math.min(ceiling, wanted)));

        await this.require4().command('SET_VOICE_SETTINGS', { [which]: { volume } });
        this.require().setVariable(`ed.discord.${which}-volume`, volume);
      },

      'ed.discord.join': async (params) => {
        const channel = typeof params['channel'] === 'string' ? params['channel'] : '';

        /*
         * Nothing chosen means leave.
         *
         * `null` rather than an empty string: Discord reads the field for a
         * channel id, and an empty string is not one.
         */
        await this.require4().command('SELECT_VOICE_CHANNEL', {
          channel_id: channel === '' ? null : channel,
          /*
           * Move, rather than refuse to move.
           *
           * Without this Discord answers "User is already joined to a voice
           * channel" and does nothing — so the key worked from the lobby and
           * failed from anywhere else, which is the half of the time nobody
           * presses it. `force` is not force in the sense of overriding the
           * person: pressing a key that names a channel *is* the consent, and
           * the alternative is a key that only works when it is not needed.
           */
          force: true,
        });
        await this.readChannel();
      },

      'ed.discord.user-volume': async (params) => {
        const user = stringParam(params, 'user');
        const mode = String(params['mode'] ?? 'set');

        if (mode === 'mute' || mode === 'unmute') {
          await this.require4().command('SET_USER_VOICE_SETTINGS', {
            user_id: user,
            mute: mode === 'mute',
          });
          return;
        }

        await this.require4().command('SET_USER_VOICE_SETTINGS', {
          user_id: user,
          volume: Math.round(Math.max(0, Math.min(200, numberParam(params, 'value', 100)))),
        });
      },
    };
  }

  private require(): PluginHost {
    const host = this.host;
    if (!host) throw new Error('The plugin is not running');
    return host;
  }

  private require4(): DiscordIpc {
    const ipc = this.ipc;
    if (!ipc?.connected) throw new Error('Discord is not connected');
    return ipc;
  }
}

function describe(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

/**
 * Builds the running parts.
 *
 * Exported apart from the default so the tests can pass options — short retry
 * delays, a socket of their own. The host always takes the defaults.
 */
export function activateWith(options: DiscordPluginOptions = {}): PluginActivation {
  const plugin = new DiscordPlugin(options);

  return {
    plugin,
    handlers: plugin.handlers(),
    commands: {
      authorise: () => plugin.authorise(),
      reconnect: () => plugin.reconnect(),
    },
  };
}

export default definePlugin({ manifest: discordManifest, activate: () => activateWith() });

// Kept exported for the settings window's description, which names it.
export { REDIRECT_URI, SCOPES };
