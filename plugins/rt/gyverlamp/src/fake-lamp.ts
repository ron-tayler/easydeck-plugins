import dgram from 'node:dgram';

/**
 * A lamp made of a socket, answering the way the firmware answers.
 *
 * The behaviours the tests lean on are copied from the real one, including
 * the awkward ones: every command answers with the `CURR` line, `BRI` and
 * `SPD` belong to the current effect, and switching effects loads that
 * effect's own stored values rather than keeping the ones on screen — which
 * is precisely the behaviour the plugin promises to mirror rather than
 * assume.
 */
export interface FakeLampState {
  effect: number;
  brightness: number;
  speed: number;
  scale: number;
  on: boolean;
}

export class FakeLamp {
  state: FakeLampState = { effect: 42, brightness: 145, speed: 203, scale: 1, on: true };

  /** Every datagram received, in order, for the tests to read. */
  readonly commands: string[] = [];

  /** A lamp that is unplugged: hears everything, answers nothing. */
  silent = false;

  /**
   * Holds the *next* reply back this long, once. What the real lamp did
   * after a discovery storm: the answer came, but after the asker had
   * given up — and a late reply must not be taken for the next command's.
   */
  delayOnceMs = 0;

  /** Set to make LIST answer; left unset, the lamp has no registry to give. */
  effects?: readonly string[];

  private readonly socket = dgram.createSocket('udp4');

  listen(): Promise<number> {
    return new Promise((resolve) => {
      this.socket.on('message', (message, rinfo) => this.receive(message.toString('utf8'), rinfo));
      this.socket.bind(0, '127.0.0.1', () => resolve(this.socket.address().port));
    });
  }

  close(): Promise<void> {
    return new Promise((resolve) => this.socket.close(() => resolve()));
  }

  private receive(command: string, rinfo: dgram.RemoteInfo): void {
    this.commands.push(command);
    if (this.silent) return;

    const reply = this.answer(command);
    if (reply === undefined) return;

    const send = () => this.socket.send(Buffer.from(reply, 'utf8'), rinfo.port, rinfo.address);
    if (this.delayOnceMs > 0) {
      setTimeout(send, this.delayOnceMs);
      this.delayOnceMs = 0;
    } else {
      send();
    }
  }

  private answer(command: string): string | undefined {
    if (command === 'GET') return this.curr();
    if (command === 'P_ON') {
      this.state.on = true;
      return this.curr();
    }
    if (command === 'P_OFF') {
      this.state.on = false;
      return this.curr();
    }

    const effect = /^EFF(\d+)$/.exec(command);
    if (effect) {
      this.state.effect = Number(effect[1]);
      // The stored settings of the effect just switched to, not the values
      // last sent — the real firmware does this, and the plugin must mirror.
      this.state.brightness = 10 + (this.state.effect % 50);
      this.state.speed = 20 + (this.state.effect % 50);
      return this.curr();
    }

    const brightness = /^BRI(\d+)$/.exec(command);
    if (brightness) {
      this.state.brightness = Number(brightness[1]);
      return this.curr();
    }

    const speed = /^SPD(\d+)$/.exec(command);
    if (speed) {
      this.state.speed = Number(speed[1]);
      return this.curr();
    }

    const scale = /^SCA(\d+)$/.exec(command);
    if (scale) {
      this.state.scale = Number(scale[1]);
      return this.curr();
    }

    const list = /^LIST([123])$/.exec(command);
    if (list && this.effects) {
      const line = Number(list[1]);
      const third = Math.ceil(this.effects.length / 3);
      const from = (line - 1) * third;
      const entries = this.effects
        .slice(from, from + third)
        .map((name, at) => `${from + at}. ${name},1,255,1,100,0`);
      return [`LIST${line}`, ...entries, ''].join(';');
    }

    if (command === 'DISCOVER') {
      return `IP 127.0.0.1:${this.socket.address().port}`;
    }

    return undefined; // The firmware clears an unknown buffer and says nothing.
  }

  private curr(): string {
    const { effect, brightness, speed, scale, on } = this.state;
    return `CURR ${effect} ${brightness} ${speed} ${scale} ${on ? 1 : 0} 1 1 0 1 12:00:00`;
  }
}
