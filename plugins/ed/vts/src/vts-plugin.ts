import { PLUGIN_API_VERSION,
  definePlugin, parseVariableKey, stringParam } from '@easydeck/plugin-sdk';
import type {
  PluginActivation,
  ActionHandler,
  ParamOption,
  Plugin,
  PluginHost,
  PluginManifest,
} from '@easydeck/plugin-sdk';

import { VtsConnection, isDenial } from './vts-connection.js';

/**
 * VTube Studio: hotkeys, expressions and which model is on screen.
 *
 * The three things a streamer reaches for mid-stream, and the three that are
 * worst to reach for with a mouse while talking. Everything here is bound to
 * something the user already set up in VTube Studio — a hotkey they named, an
 * expression file they made — so the plugin offers lists rather than asking
 * anybody to type an id.
 *
 * Authorising is the one unusual part, and it is unusual in VTube Studio
 * rather than here: asking for a token throws a dialog in front of whoever is
 * live, so it happens when the button in the settings window is pressed and
 * never on its own. See vts-connection.ts.
 */

export const VTS_PLUGIN_ID = 'ed.vts';

/** What VTube Studio shows the user in its allow-this-plugin dialog. */
const PLUGIN_NAME = 'EasyDeck';
const PLUGIN_DEVELOPER = 'EasyDeck';

export const vtsManifest: PluginManifest = {
  id: VTS_PLUGIN_ID,
  name: { en: 'VTube Studio', ru: 'VTube Studio' },
  cover: "plugin:ed.vts/assets/logo.png",
  description: {
    en: 'Hotkeys, expressions and models in VTube Studio',
    ru: 'Хоткеи, выражения и модели в VTube Studio',
  },
  version: '1.0.0',
  apiVersion: PLUGIN_API_VERSION,

  settings: [
    {
      // Off until asked, like OBS: a machine with no VTube Studio on it should
      // not have something knocking on port 8001 for ever.
      name: 'enabled',
      type: 'boolean',
      label: { en: 'Connect to VTube Studio', ru: 'Подключаться к VTube Studio' },
      default: false,
      required: false,
    },
    {
      name: 'host',
      type: 'string',
      label: { en: 'Address', ru: 'Адрес' },
      default: '127.0.0.1',
      description: {
        en: 'Leave as it is unless VTube Studio runs on another machine',
        ru: 'Оставьте как есть, если VTube Studio не на другом компьютере',
      },
    },
    {
      name: 'port',
      type: 'number',
      label: { en: 'Port', ru: 'Порт' },
      default: 8001,
      min: 1,
      max: 65535,
      description: {
        en: 'From the API section of VTube Studio settings, where it must also be switched on',
        ru: 'Из раздела API в настройках VTube Studio, там же его надо включить',
      },
    },
    {
      /*
       * Granted by VTube Studio, not typed by anybody.
       *
       * Kept as an ordinary secret setting so it is sealed and reported like
       * every other, and so a person who moved machines can see at a glance
       * whether this one is authorised. The plugin writes it itself through
       * `remember`.
       */
      name: 'token',
      type: 'string',
      secret: true,
      required: false,
      label: { en: 'Access token', ru: 'Токен доступа' },
      description: {
        en: 'Filled in by Authorise below; VTube Studio asks you to allow it once',
        ru: 'Заполняется кнопкой «Авторизовать»; VTube Studio один раз спросит разрешение',
      },
    },
  ],

  commands: [
    {
      name: 'authorise',
      label: { en: 'Authorise', ru: 'Авторизовать' },
      icon: 'link',
      description: {
        en: 'VTube Studio will ask you to allow EasyDeck — switch to it and press Allow',
        ru: 'VTube Studio попросит разрешить EasyDeck — переключитесь в него и нажмите «Разрешить»',
      },
    },
    { name: 'reconnect', label: { en: 'Reconnect', ru: 'Переподключиться' }, icon: 'link' },
  ],

  variables: [
    {
      name: 'ed.vts.connected',
      type: 'boolean',
      label: { en: 'VTube Studio connected', ru: 'VTube Studio подключён' },
      initial: false,
    },
    {
      name: 'ed.vts.model',
      type: 'string',
      label: { en: 'Current model', ru: 'Текущая модель' },
    },
    {
      name: 'ed.vts.tracking',
      type: 'boolean',
      label: { en: 'Face tracked', ru: 'Лицо в кадре' },
      initial: false,
      description: {
        en: 'Whether VTube Studio can see a face right now',
        ru: 'Видит ли VTube Studio лицо прямо сейчас',
      },
    },
    {
      /*
       * A family: one declaration, a key per expression.
       *
       * `vts.expression(Смущение.exp3.json)` is on or off, and only the
       * expressions some profile actually reads are kept up to date — a model
       * may have dozens.
       */
      name: 'ed.vts.expression',
      type: 'boolean',
      label: { en: 'Expression active', ru: 'Выражение включено' },
      argument: {
        label: { en: 'Expression', ru: 'Выражение' },
        optionsFrom: 'expressions',
      },
    },
    {
      name: 'ed.vts.animation',
      type: 'string',
      label: { en: 'Animation playing', ru: 'Играет анимация' },
      description: {
        en: 'The name of the animation running now, idle animations aside',
        ru: 'Название анимации, которая идёт сейчас; фоновая idle не в счёт',
      },
    },
    {
      /*
       * Whether one particular animation is running.
       *
       * An animation is not an expression: it starts, plays and ends, and
       * VTube Studio reports both ends of that. This is what a key binds to
       * when it should light up for as long as the wave lasts.
       */
      name: 'ed.vts.animation-active',
      type: 'boolean',
      label: { en: 'This animation playing', ru: 'Эта анимация играет' },
      argument: {
        label: { en: 'Animation', ru: 'Анимация' },
        optionsFrom: 'animations',
      },
    },
    {
      name: 'ed.vts.hotkey',
      type: 'string',
      label: { en: 'Last hotkey', ru: 'Последний хоткей' },
      description: {
        en: 'Whatever fired last, whoever fired it — you, a key press, or another plugin',
        ru: 'Что сработало последним, от кого угодно: от вас, с клавиатуры или из другого плагина',
      },
    },
  ],

  actions: [
    {
      type: 'ed.vts.trigger-hotkey',
      icon: 'star',
      label: { en: 'Trigger hotkey', ru: 'Запустить хоткей' },
      description: {
        en: 'Runs one of the current model\'s hotkeys: an animation, an outfit, anything you set up',
        ru: 'Запускает хоткей текущей модели: анимацию, одежду, что угодно из настроенного',
      },
      params: [
        {
          name: 'hotkey',
          type: 'select',
          label: { en: 'Hotkey', ru: 'Хоткей' },
          optionsFrom: 'hotkeys',
          description: {
            en: 'Named as in VTube Studio. A hotkey of a model that is not loaded does nothing',
            ru: 'Название как в VTube Studio. Хоткей незагруженной модели ничего не сделает',
          },
        },
      ],
    },
    {
      type: 'ed.vts.set-expression',
      icon: 'smile',
      label: { en: 'Expression', ru: 'Выражение' },
      params: [
        {
          name: 'expression',
          type: 'select',
          label: { en: 'Expression', ru: 'Выражение' },
          optionsFrom: 'expressions',
        },
        {
          name: 'mode',
          type: 'select',
          label: { en: 'What to do', ru: 'Что сделать' },
          default: 'toggle',
          options: [
            { value: 'toggle', label: { en: 'Toggle', ru: 'Переключить' } },
            { value: 'on', label: { en: 'Turn on', ru: 'Включить' } },
            { value: 'off', label: { en: 'Turn off', ru: 'Выключить' } },
          ],
        },
        {
          name: 'fade',
          type: 'number',
          label: { en: 'Fade, seconds', ru: 'Плавность, секунды' },
          default: 0.25,
          min: 0,
          max: 2,
          step: 0.05,
          required: false,
        },
      ],
    },
    {
      type: 'ed.vts.load-model',
      icon: 'person',
      label: { en: 'Load model', ru: 'Загрузить модель' },
      params: [
        {
          name: 'model',
          type: 'select',
          label: { en: 'Model', ru: 'Модель' },
          optionsFrom: 'models',
        },
      ],
    },
  ],

  presets: [
    {
      name: 'expression',
      label: { en: 'Expression', ru: 'Выражение' },
      description: {
        en: 'Toggles an expression and shows whether it is on. Choose which in the key editor',
        ru: 'Переключает выражение и показывает, включено ли оно. Какое — в редакторе кнопки',
      },
      button: {
        /*
         * Bound to the family, with the argument left out on purpose.
         *
         * A preset cannot know which expression somebody wants, and the key
         * editor draws a picker for exactly this: choosing the expression
         * fills in both the binding and the action below it.
         */
        stateFrom: 'ed.vts.expression',
        states: [
          {
            id: 'off',
            when: false,
            visual: { background: '#22303c', label: { text: 'Выражение', fontSize: 13 } },
            actions: { press: [{ type: 'ed.vts.set-expression', params: { mode: 'toggle' } }] },
          },
          {
            id: 'on',
            when: true,
            visual: { background: '#2f6f4f', label: { text: 'Выражение', fontSize: 13 } },
            actions: { press: [{ type: 'ed.vts.set-expression', params: { mode: 'toggle' } }] },
          },
        ],
      },
    },
    {
      name: 'animation',
      label: { en: 'Animation', ru: 'Анимация' },
      description: {
        en: 'Runs a hotkey and lights up while the animation it started is playing',
        ru: 'Запускает хоткей и подсвечивается, пока идёт запущенная им анимация',
      },
      button: {
        // Bound to the family with the argument left out, like the expression
        // preset: choosing the animation in the key editor fills it in.
        stateFrom: 'ed.vts.animation-active',
        states: [
          {
            id: 'idle',
            when: false,
            visual: { background: '#22303c', label: { text: 'Анимация', fontSize: 13 } },
            actions: { press: [{ type: 'ed.vts.trigger-hotkey' }] },
          },
          {
            id: 'playing',
            when: true,
            visual: { background: '#3d5a80', label: { text: 'Анимация', fontSize: 13 } },
            actions: { press: [{ type: 'ed.vts.trigger-hotkey' }] },
          },
        ],
      },
    },
    {
      name: 'model',
      label: { en: 'Current model', ru: 'Текущая модель' },
      description: {
        en: 'Shows which model is on screen',
        ru: 'Показывает, какая модель на экране',
      },
      button: {
        states: [
          {
            id: 'default',
            visual: { background: '#22303c', label: { text: '{{vts.model}}', fontSize: 12 } },
          },
        ],
      },
    },
  ],
};

/** One expression, as both the list and the variables need it. */
interface Expression {
  readonly file: string;
  readonly name: string;
  readonly active: boolean;
}

export interface VtsPluginOptions {
  readonly retryDelaysMs?: readonly number[];
}

export class VtsPlugin implements Plugin {
  private connection?: VtsConnection;
  private host?: PluginHost;
  /** Expression files some profile reads, and therefore the ones kept current. */
  private watching: readonly string[] = [];
  /** True while this plugin is writing a setting itself; see reconnectIfNeeded. */
  private storingToken = false;
  /**
   * Animation names this connection has seen play.
   *
   * The only list there is: VTube Studio has no request for the animations a
   * model holds, so the names come from the events themselves. It fills as the
   * stream goes on, which is enough for the editor to offer something rather
   * than nothing — and a name may always be typed.
   */
  private readonly seenAnimations = new Set<string>();

  constructor(private readonly options: VtsPluginOptions = {}) {}

  start(host: PluginHost): void {
    this.host = host;
    this.connect();
    host.onSettingsChanged(() => this.reconnectIfNeeded());

    host.onWatched((keys) => {
      this.watching = keys
        .map((key) => parseVariableKey(key))
        .filter((parsed) => parsed.family === 'ed.vts.expression' && parsed.argument)
        .map((parsed) => parsed.argument!);

      // Read at once rather than at the next connect: a key added while VTube
      // Studio is running should start showing something immediately.
      if (this.connection?.connected) void this.readExpressions();
    });
  }

  stop(): void {
    this.connection?.stop();
    this.connection = undefined;
  }

  reconnect(): void {
    this.connect();
  }

  /**
   * Asks VTube Studio to grant a token, which it does by asking the user.
   *
   * Kept to the moment the button is pressed. The connection may be up but
   * unauthenticated, which is the ordinary state before this has ever been
   * done; if it is not up at all, the settings say so already.
   */
  async authorise(): Promise<void> {
    const connection = this.connection;
    const host = this.host;
    if (!connection || !host) throw new Error('Switch the plugin on first');
    if (!connection.open) throw new Error('VTube Studio is not connected yet');

    host.setStatus('connecting', {
      en: 'Waiting for you to allow EasyDeck in VTube Studio',
      ru: 'Ждём разрешения в окне VTube Studio',
    });

    try {
      await connection.authorise();
    } catch (error) {
      const message = isDenial(error)
        ? 'VTube Studio refused: the request was denied'
        : (error as Error).message;
      host.setStatus('error', { en: message });
      throw new Error(message);
    }
  }

  /**
   * Reconnects when the user saves settings — but not when we do.
   *
   * Authorising ends by storing the token, and storing a setting notifies
   * every listener, this plugin included. Acting on that notification meant
   * tearing down the socket in the middle of the authorisation that was using
   * it: the token was granted, stored, and then handed to a connection that no
   * longer existed.
   *
   * Anything a person saves is still worth a reconnect, address and port
   * included, so nothing here tries to work out which field changed.
   */
  private reconnectIfNeeded(): void {
    if (this.storingToken) return;
    this.connect();
  }

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

    this.connection = new VtsConnection({
      ...(this.options.retryDelaysMs ? { retryDelaysMs: this.options.retryDelaysMs } : {}),
      host: String(settings['host'] ?? '127.0.0.1'),
      port: Number(settings['port'] ?? 8001),
      pluginName: PLUGIN_NAME,
      pluginDeveloper: PLUGIN_DEVELOPER,
      token: () => String(this.host?.settings()['token'] ?? ''),
      // Stored through the host so it is sealed like any other secret, and so
      // the settings window sees it as filled in. Awaited, so authorising
      // fails loudly if the token could not be kept.
      onToken: async (token) => {
        this.storingToken = true;
        try {
          await host.remember('token', token);
        } finally {
          this.storingToken = false;
        }
      },
      onEvent: (type, data) => this.onEvent(type, data),
      onState: (state, message) => {
        if (state === 'unauthorised') {
          host.setStatus('error', {
            en: 'Not authorised yet — press Authorise, then allow EasyDeck in VTube Studio',
            ru: 'Ещё не авторизован — нажмите «Авторизовать» и разрешите EasyDeck в VTube Studio',
          });
          host.setVariable('ed.vts.connected', false);
          return;
        }

        host.setStatus(state, message ? { en: message } : undefined);
        host.setVariable('ed.vts.connected', state === 'ready');

        if (state === 'ready') void this.readEverything();
        else this.clearVariables();
      },
      log: (level, text) => host.log(level, text),
    });

    this.registerOptions(host);
    this.connection.start();
  }

  /**
   * The lists a configurator offers while VTube Studio is running.
   *
   * Answering with nothing while disconnected is what turns the field into a
   * box a name can be typed into, which is how a key gets set up before the
   * program it drives is running.
   */
  private registerOptions(host: PluginHost): void {
    host.provideOptions('hotkeys', async () => {
      const data = await this.require().request<{
        availableHotkeys?: { name?: string; hotkeyID?: string; type?: string }[];
      }>('HotkeysInCurrentModelRequest');

      return (data['availableHotkeys'] ?? [])
        .filter((hotkey) => typeof hotkey.hotkeyID === 'string')
        .map<ParamOption>((hotkey) => ({
          // The id is what is stored: a hotkey renamed in VTube Studio keeps
          // working, which is not true the other way round.
          value: String(hotkey.hotkeyID),
          label: { en: hotkey.name?.trim() || String(hotkey.type ?? 'Hotkey') },
        }));
    });

    host.provideOptions('expressions', async () => {
      return (await this.readExpressionList()).map<ParamOption>((expression) => ({
        // The file is the id VTube Studio takes, and it is also what a person
        // recognises: they named the file.
        value: expression.file,
        label: { en: expression.name || expression.file },
      }));
    });

    /*
     * Whatever has played since the connection opened.
     *
     * VTube Studio has no request for the animations a model holds, so this is
     * the honest answer: names it has actually reported. Empty at first, which
     * leaves the field a box a name can be typed into — the same fallback
     * every dynamic parameter has.
     */
    host.provideOptions('animations', async () =>
      [...this.seenAnimations].sort().map<ParamOption>((name) => ({ value: name, label: { en: name } })),
    );

    host.provideOptions('models', async () => {
      const data = await this.require().request<{
        availableModels?: { modelName?: string; modelID?: string }[];
      }>('AvailableModelsRequest');

      return (data['availableModels'] ?? [])
        .filter((model) => typeof model.modelID === 'string')
        .map<ParamOption>((model) => ({
          value: String(model.modelID),
          label: { en: model.modelName?.trim() || String(model.modelID) },
        }));
    });
  }

  /** Everything worth showing, read once on connect. */
  private async readEverything(): Promise<void> {
    const connection = this.connection;
    const host = this.host;
    if (!connection || !host) return;

    try {
      // Subscribed before reading, so a change between the two is not missed.
      for (const event of [
        'ModelLoadedEvent',
        'TrackingStatusChangedEvent',
        // Fires for a hotkey pressed on the keyboard, triggered by a hand
        // gesture, or run by another plugin — a Twitch reward, say. Which is
        // the only way to know an expression changed: VTube Studio has no
        // event for expressions at all.
        'HotkeyTriggeredEvent',
        'ModelAnimationEvent',
      ]) {
        await connection.subscribe(event);
      }

      const model = await connection.request<{ modelLoaded?: boolean; modelName?: string }>(
        'CurrentModelRequest',
      );
      host.setVariable('ed.vts.model', model['modelLoaded'] === true ? String(model['modelName'] ?? '') : '');

      await this.readExpressions();
    } catch (cause) {
      host.log('warn', `Could not read VTube Studio: ${describe(cause)}`);
    }
  }

  /** The expressions a profile actually reads, and nothing else. */
  private async readExpressions(): Promise<void> {
    const host = this.host;
    if (!host || this.watching.length === 0) return;

    try {
      const expressions = await this.readExpressionList();
      const byFile = new Map(expressions.map((expression) => [expression.file, expression]));

      for (const file of this.watching) {
        // Cleared rather than left stale when the expression is not in this
        // model: a key showing "on" for something that no longer exists is the
        // deck stating something untrue.
        host.setFamily('ed.vts.expression', file, byFile.get(file)?.active);
      }
    } catch (cause) {
      host.log('warn', `Could not read expressions: ${describe(cause)}`);
    }
  }

  private async readExpressionList(): Promise<Expression[]> {
    const data = await this.require().request<{
      expressions?: { name?: string; file?: string; active?: boolean }[];
    }>('ExpressionStateRequest', { details: false });

    return (data['expressions'] ?? [])
      .filter((expression) => typeof expression.file === 'string')
      .map((expression) => ({
        file: String(expression.file),
        name: String(expression.name ?? '').trim(),
        active: expression.active === true,
      }));
  }

  private onEvent(type: string, data: Record<string, unknown>): void {
    const host = this.host;
    if (!host) return;

    switch (type) {
      case 'ModelLoadedEvent':
        host.setVariable(
          'ed.vts.model',
          data['modelLoaded'] === true ? String(data['modelName'] ?? '') : '',
        );
        // A different model has different expressions, and the ones a profile
        // watches may not exist in it.
        void this.readExpressions();
        return;

      case 'TrackingStatusChangedEvent':
        host.setVariable('ed.vts.tracking', data['faceFound'] === true);
        return;

      /*
       * Somebody ran a hotkey, and it was very likely not us.
       *
       * A hotkey may toggle an expression, and an expression changing is
       * reported by nothing else — VTube Studio has no event for them. So the
       * expressions a profile watches are read again, which is cheap because
       * that list is only the ones actually on a key.
       *
       * Ours are included rather than filtered out by `hotkeyTriggeredByAPI`:
       * another plugin's API calls look exactly the same, and a Twitch reward
       * firing a hotkey is precisely the case worth following.
       */
      case 'HotkeyTriggeredEvent': {
        const name = String(data['hotkeyName'] ?? '').trim();
        host.setVariable('ed.vts.hotkey', name || String(data['hotkeyID'] ?? ''));
        void this.readExpressions();
        return;
      }

      /*
       * An animation started or ended.
       *
       * Not an expression: an animation plays for a while and stops, and both
       * ends are reported. Idle animations are left out — they run for ever
       * by design, and a key lit up for the whole stream says nothing.
       */
      case 'ModelAnimationEvent': {
        if (data['isIdleAnimation'] === true) return;

        const name = String(data['animationName'] ?? '').trim();
        if (name === '') return;

        const started = String(data['animationEventType'] ?? '') === 'Start';
        this.seenAnimations.add(name);

        host.setVariable('ed.vts.animation', started ? name : '');
        host.setFamily('ed.vts.animation-active', name, started);
        return;
      }

      default:
        return;
    }
  }

  private clearVariables(): void {
    const host = this.host;
    if (!host) return;

    host.setVariable('ed.vts.connected', false);
    host.setVariable('ed.vts.model', undefined);
    host.setVariable('ed.vts.tracking', undefined);
    host.setVariable('ed.vts.animation', undefined);
    host.setVariable('ed.vts.hotkey', undefined);

    for (const file of this.watching) host.setFamily('ed.vts.expression', file, undefined);
    for (const name of this.seenAnimations) host.setFamily('ed.vts.animation-active', name, undefined);
    this.seenAnimations.clear();
  }

  private require(): VtsConnection {
    const connection = this.connection;
    if (!connection?.connected) throw new Error('Not connected to VTube Studio');
    return connection;
  }

  handlers(): Record<string, ActionHandler> {
    return {
      'ed.vts.trigger-hotkey': async (params) => {
        await this.require().request('HotkeyTriggerRequest', {
          hotkeyID: stringParam(params, 'hotkey'),
        });
      },

      'ed.vts.set-expression': async (params) => {
        const file = stringParam(params, 'expression');
        const mode = String(params['mode'] ?? 'toggle');
        const fade = Number(params['fade'] ?? 0.25);

        const active =
          mode === 'toggle'
            ? !(await this.readExpressionList()).find((each) => each.file === file)?.active
            : mode === 'on';

        await this.require().request('ExpressionActivationRequest', {
          expressionFile: file,
          active,
          fadeTime: Number.isFinite(fade) ? Math.min(2, Math.max(0, fade)) : 0.25,
        });

        // Published without waiting for anything to tell us: expressions have
        // no event of their own, so the key would otherwise stay wrong until
        // the next model change.
        if (this.watching.includes(file)) this.host?.setFamily('ed.vts.expression', file, active);
      },

      'ed.vts.load-model': async (params) => {
        await this.require().request('ModelLoadRequest', { modelID: stringParam(params, 'model') });
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
export function activateWith(options: VtsPluginOptions = {}): PluginActivation {
  const plugin = new VtsPlugin(options);

  return {
    plugin,
    handlers: plugin.handlers(),
    commands: {
      authorise: () => plugin.authorise(),
      reconnect: () => plugin.reconnect(),
    },
  };
}

export default definePlugin({ manifest: vtsManifest, activate: () => activateWith() });

function describe(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}
