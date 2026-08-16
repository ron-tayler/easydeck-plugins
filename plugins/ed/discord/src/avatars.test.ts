import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { Avatars, avatarAddress } from './avatars.js';

/** A fetcher that answers with a picture and counts who asked. */
function cdn(answer: () => Response) {
  const asked: string[] = [];
  const fetcher = (async (input: string | URL | Request) => {
    asked.push(String(input));
    return answer();
  }) as unknown as typeof fetch;

  return { asked, fetcher };
}

function picture(): Response {
  return new Response(Buffer.from([1, 2, 3]), { headers: { 'content-type': 'image/png' } });
}

/** Waits for the fetch the cache started, which nothing hands back a promise for. */
async function settle(): Promise<void> {
  for (let turn = 0; turn < 20; turn += 1) await Promise.resolve();
}

describe('where a face lives', () => {
  it('builds the address from the hash Discord gives out', () => {
    assert.equal(
      avatarAddress({ id: '1', avatar: 'abc123' }),
      'https://cdn.discordapp.com/avatars/1/abc123.png?size=256',
    );
  });

  it('asks for the still frame of an animated one', () => {
    // A key redrawn on speech has no use for an animation it would have to
    // drive itself, and `.png` is what the CDN answers a still with.
    assert.match(avatarAddress({ id: '1', avatar: 'a_moving' }), /a_moving\.png/);
  });

  it('falls back to the default Discord would show', () => {
    // The old accounts, where the discriminator picks one of five.
    assert.equal(
      avatarAddress({ id: '1', discriminator: '1234' }),
      'https://cdn.discordapp.com/embed/avatars/4.png',
    );

    /*
     * And the new ones, where it is gone and reads as `0`.
     *
     * The default then comes from the id: the top bits of a snowflake are a
     * timestamp, and Discord takes the number from them. 175928847299117063
     * shifted right 22 is 41944705796, and that modulo six is 2.
     */
    assert.equal(
      avatarAddress({ id: '175928847299117063', discriminator: '0' }),
      'https://cdn.discordapp.com/embed/avatars/2.png',
    );
  });

  it('does not throw over an id that is not a number', () => {
    // Nothing real hands out one — but this runs inside the read of who is in
    // the call, where throwing would lose the whole room rather than one face.
    assert.equal(avatarAddress({ id: 'me' }), 'https://cdn.discordapp.com/embed/avatars/0.png');
  });

  it('answers with nothing for somebody with no id at all', () => {
    assert.equal(avatarAddress({}), '');
  });
});

describe('the face cache', () => {
  it('answers nothing at first, fetches, and rings back', async () => {
    const { asked, fetcher } = cdn(picture);
    let rang = 0;
    const avatars = new Avatars({ fetcher, onArrived: () => (rang += 1) });

    // Nothing waits on a network call: the key draws a stand-in and is asked
    // again once the picture is here.
    assert.equal(avatars.picture('https://cdn/one.png'), undefined);
    await settle();

    assert.equal(rang, 1);
    assert.equal(avatars.picture('https://cdn/one.png'), 'data:image/png;base64,AQID');
    assert.deepEqual(asked, ['https://cdn/one.png']);
  });

  it('fetches one face once, however often it is drawn', async () => {
    const { asked, fetcher } = cdn(picture);
    const avatars = new Avatars({ fetcher });

    // Three repaints inside one round trip, which is what happens when three
    // people start talking at once.
    avatars.picture('https://cdn/one.png');
    avatars.picture('https://cdn/one.png');
    await settle();
    avatars.picture('https://cdn/one.png');

    assert.equal(asked.length, 1);
  });

  it('remembers a failure rather than asking again on every repaint', async () => {
    const { asked, fetcher } = cdn(() => new Response('no', { status: 404 }));
    const messages: string[] = [];
    const avatars = new Avatars({ fetcher, log: (message) => messages.push(message) });

    avatars.picture('https://cdn/gone.png');
    await settle();

    assert.equal(avatars.picture('https://cdn/gone.png'), undefined);
    await settle();
    assert.equal(asked.length, 1, 'a CDN that is down was asked twice');
    assert.match(messages[0] ?? '', /404/);

    // Until something reconnects, which is the usual reason it failed: the
    // machine was not on the network yet.
    avatars.forgetFailures();
    avatars.picture('https://cdn/gone.png');
    await settle();
    assert.equal(asked.length, 2);
  });

  it('keeps the type the CDN answered with', async () => {
    const { fetcher } = cdn(
      () => new Response(Buffer.from([9]), { headers: { 'content-type': 'image/webp' } }),
    );
    const avatars = new Avatars({ fetcher });

    avatars.picture('https://cdn/one.webp');
    await settle();
    assert.match(String(avatars.picture('https://cdn/one.webp')), /^data:image\/webp;base64,/);
  });
});
