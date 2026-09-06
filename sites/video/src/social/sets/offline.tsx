/**
 * How the offline promise is actually kept.
 *
 * The pitch carousel makes the claim; this one shows the machinery, because
 * "works offline" is a thing every tracker's landing page says and almost none
 * of them mean. The difference is legible in four facts — a mirror in the
 * browser, a queue, a clock, and a merge that is per field rather than per row —
 * and each of those is quoted from `docs/sync.md`, which is where somebody who
 * does not believe the slide should be sent.
 *
 * Slides three and four are the same widget at two frames. That is the carousel
 * equivalent of an animation: in the films the outbox drains over forty frames,
 * and here the reader's thumb is the clock.
 */
import { screen } from '../../assets';
import { Screenshot } from '../../components/Screenshot';
import { Outbox } from '../../components/Outbox';
import type { Carousel } from '../slide';

const W = 912;

export const offline: Carousel = {
  id: 'SocialOffline',
  about: 'the offline promise, and the four facts that keep it — mirror, queue, clock, per-field merge',
  slides: [
    {
      kind: 'cover',
      kicker: 'Offline-first',
      headline: 'It never waits for the network.',
      sub: 'Not “works offline”. Never waits — because nothing on screen was ever a request that might not come back.',
    },
    {
      kind: 'point',
      kicker: 'The mirror',
      headline: 'Every screen reads from your browser.',
      sub: 'A copy of the workspace lives on the device, in IndexedDB, and survives a reload. The board opens at the speed of the machine it is on.',
      visual: {
        height: 714,
        node: (
          <Screenshot
            screen={screen.board}
            crop={{ x: 420, y: 0, w: 1600, h: 1020 }}
            width={1120}
            height={714}
            style={{ left: -104, top: 0 }}
          />
        ),
      },
    },
    {
      kind: 'point',
      kicker: 'The wifi goes',
      headline: 'You keep typing.',
      sub: 'Search, filters, the board, a new task, a new page — all of it. The changes go into an outbox instead of onto the wire.',
      visual: {
        /* Frame 100: seventy frames after the connection dropped, before it comes back. */
        height: 292,
        node: <Outbox frame={100} scale={W / 566} style={{ left: 0, top: 0 }} />,
      },
    },
    {
      kind: 'point',
      kicker: 'The wifi comes back',
      headline: 'Three changes, merged.',
      sub: 'The queue drains in order, and what the screen then shows is what the server actually stored — not an optimistic guess nobody checked.',
      visual: {
        /* Frame 150: past the last row's merge at 130, so all three have settled. */
        height: 292,
        node: <Outbox frame={150} scale={W / 566} style={{ left: 0, top: 0 }} />,
      },
    },
    {
      kind: 'point',
      kicker: 'The merge',
      headline: 'Last writer wins — per field, not per row.',
      sub: 'You renamed a task on the train while a colleague changed its priority at their desk. Both survive, because a row stores a stamp per field and only the fields somebody touched are compared.',
    },
    {
      kind: 'point',
      kicker: 'The clock',
      headline: 'A device with the wrong time cannot win forever.',
      sub: 'Every change carries a hybrid logical clock: wall time, a counter that breaks ties inside a millisecond, and the device that wrote it. Seeing somebody else’s stamp advances your own, so two clocks converge after one exchange.',
      /*
       * Drawn in ASCII rather than in box-drawing characters, and the rules
       * are counted rather than eyeballed: 10 for the millis, 4 for the
       * counter, 8 for the node, with the two dashes between. The first
       * version used `└──┘` and did not line up, because `@fontsource` splits
       * JetBrains Mono by unicode range and U+2500 is in no subset this build
       * loads — so those three characters came from whatever mono the renderer
       * had, at whatever width it liked. Everything here is basic latin, which
       * is the subset `fonts.ts` already holds frame 0 for.
       */
      code: '0mfk2p8x1c-0000-a3f9d201\n|________| |__| |______|\nwall clock tick  device',
    },
    {
      kind: 'point',
      kicker: 'Deleting',
      headline: 'A delete is a field too.',
      sub: 'So an edit stamped after one brings the row back — which is what everybody expects when somebody deletes a task a colleague is still working on, and what almost nothing does.',
    },
    {
      kind: 'close',
      kicker: 'Offline-first',
      headline: 'On a train, on a plane, on hotel wifi.',
      sub: 'And on your own server, which is the other half of the same promise.',
    },
  ],
};
