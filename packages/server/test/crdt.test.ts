/**
 * The text CRDT.
 *
 * These are property tests in the sense that matters: the claim is that merging
 * is commutative, associative and idempotent, and that a set of characters has
 * exactly one reading. Each of those is checked by *constructing* the awkward
 * case rather than by asserting the happy one — a merge function that only
 * works when the arguments arrive in the order you expected is not a merge
 * function, and an offline-first sync will find that out for you.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { crdt, type CrdtState } from '@kolibri/shared';

/** Type what an agent types, from whatever it currently believes. */
const type_ = (state: CrdtState, text: string, agent: string): CrdtState => crdt.edit(state, text, agent);

const text = crdt.textOf;

describe('reading and writing', () => {
  it('is empty until somebody types', () => {
    assert.equal(text(crdt.empty()), '');
    assert.equal(text(null), '', 'and a page that has never had one is not a crash');
    assert.equal(text({ v: 1, a: [], r: [] }), '');
  });

  it('round-trips what was typed', () => {
    assert.equal(text(type_(crdt.empty(), 'Hello, world', 'ada')), 'Hello, world');
  });

  it('reads the same after a merge with itself', () => {
    const one = type_(crdt.empty(), '# Handbook\n\nHow we work.', 'ada');
    assert.equal(text(crdt.merge(one, one)), '# Handbook\n\nHow we work.', 'idempotent');
  });

  it('takes plain text from an import or the API as a replacement', () => {
    const written = crdt.fromText('Written elsewhere', 'server');
    assert.equal(text(written), 'Written elsewhere');
  });
});

describe('one person editing', () => {
  it('inserts in the middle without disturbing the ends', () => {
    let state = type_(crdt.empty(), 'The quick fox', 'ada');
    state = crdt.edit(state, 'The quick brown fox', 'ada');
    assert.equal(text(state), 'The quick brown fox');
  });

  it('deletes, and the deletion survives a merge with the state before it', () => {
    const before = type_(crdt.empty(), 'Keep this. Drop this.', 'ada');
    const after = crdt.edit(before, 'Keep this.', 'ada');
    assert.equal(text(after), 'Keep this.');
    assert.equal(
      text(crdt.merge(before, after)), 'Keep this.',
      'delete wins over insert — resurrecting text somebody removed is what people file bugs about',
    );
    assert.equal(text(crdt.merge(after, before)), 'Keep this.', 'in either order');
  });

  it('replaces a word, which is a delete and an insert at one point', () => {
    let state = type_(crdt.empty(), 'ship it on Friday', 'ada');
    state = crdt.edit(state, 'ship it on Monday', 'ada');
    assert.equal(text(state), 'ship it on Monday');
  });

  it('empties a page without losing the ability to write in it again', () => {
    let state = type_(crdt.empty(), 'all of this goes', 'ada');
    state = crdt.edit(state, '', 'ada');
    assert.equal(text(state), '');
    state = crdt.edit(state, 'something else', 'ada');
    assert.equal(text(state), 'something else');
  });
});

describe('two people at once', () => {
  it('keeps both edits when they touch different places', () => {
    const base = type_(crdt.empty(), 'One.\n\nTwo.\n', 'ada');
    // Both start from `base` and neither sees the other.
    const ada = crdt.edit(base, 'One, edited.\n\nTwo.\n', 'ada');
    const lin = crdt.edit(base, 'One.\n\nTwo, edited.\n', 'lin');

    const merged = crdt.merge(ada, lin);
    assert.equal(text(merged), 'One, edited.\n\nTwo, edited.\n');
    assert.equal(text(crdt.merge(lin, ada)), text(merged), 'commutative');
  });

  it('is what last-writer-wins could not do: neither paragraph disappears', () => {
    const base = crdt.fromText('Intro.\n', 'seed');
    const ada = crdt.edit(base, 'Intro.\n\nAda’s paragraph.\n', 'ada');
    const lin = crdt.edit(base, 'Intro.\n\nLin’s paragraph.\n', 'lin');
    const both = text(crdt.merge(ada, lin));

    assert.match(both, /Ada’s paragraph/);
    assert.match(both, /Lin’s paragraph/);
    assert.match(both, /^Intro\./);
  });

  it('agrees whichever order the rows arrive in — that is the whole point', () => {
    const base = crdt.fromText('a\nb\nc\n', 'seed');
    const one = crdt.edit(base, 'a\nb1\nc\n', 'one');
    const two = crdt.edit(base, 'a\nb\nc2\n', 'two');
    const three = crdt.edit(base, 'a3\nb\nc\n', 'three');

    const orders: CrdtState[][] = [
      [one, two, three], [one, three, two], [two, one, three],
      [two, three, one], [three, one, two], [three, two, one],
    ];
    const readings = new Set(orders.map((states) => text(states.reduce((left, right) => crdt.merge(left, right)))));
    assert.equal(readings.size, 1, `six orderings produced ${readings.size} readings: ${[...readings].join(' | ')}`);
    const only = [...readings][0];
    assert.match(only, /a3/);
    assert.match(only, /b1/);
    assert.match(only, /c2/);
  });

  it('is associative, so a device that merged two before the third gets the same answer', () => {
    const base = crdt.fromText('x\n', 'seed');
    const a = crdt.edit(base, 'x\nA\n', 'a');
    const b = crdt.edit(base, 'x\nB\n', 'b');
    const c = crdt.edit(base, 'x\nC\n', 'c');
    assert.equal(
      text(crdt.merge(crdt.merge(a, b), c)),
      text(crdt.merge(a, crdt.merge(b, c))),
    );
  });

  it('does not lose one person’s delete to the other person’s edit elsewhere', () => {
    const base = crdt.fromText('keep\ndrop\nkeep\n', 'seed');
    const remover = crdt.edit(base, 'keep\nkeep\n', 'ada');
    const writer = crdt.edit(base, 'keep\ndrop\nkeep\nand more\n', 'lin');
    const merged = text(crdt.merge(remover, writer));
    assert.equal(merged.includes('drop'), false, 'the deletion holds');
    assert.match(merged, /and more/, 'and so does the other person’s addition');
  });

  it('keeps each person’s run together rather than shuffling their letters', () => {
    // The classic failure of a position-key CRDT: two people typing a word at
    // the same spot get "hweolrllod". RGA keeps runs together.
    const base = crdt.fromText('><', 'seed');
    const ada = crdt.edit(base, '>hello<', 'ada');
    const lin = crdt.edit(base, '>world<', 'lin');
    const merged = text(crdt.merge(ada, lin));
    assert.ok(
      merged === '>helloworld<' || merged === '>worldhello<',
      `expected the two words side by side, got ${merged}`,
    );
  });
});

describe('the encoding', () => {
  it('interns the agent rather than repeating it on every run', () => {
    const state = type_(crdt.empty(), 'abc', 'a-rather-long-device-identifier');
    assert.deepEqual(state.a, ['a-rather-long-device-identifier']);
    assert.equal(state.r.length, 1, 'and a run typed in one go is one entry');
  });

  it('survives a trip through JSON, which is how it is stored and sent', () => {
    const state = type_(crdt.empty(), 'Written on one device', 'ada');
    const parsed = JSON.parse(JSON.stringify(state)) as CrdtState;
    assert.equal(text(parsed), 'Written on one device');
    assert.equal(text(crdt.merge(parsed, state)), 'Written on one device');
  });

  it('ignores a row it cannot read instead of throwing', () => {
    const damaged = { v: 1, a: ['ada'], r: [[0, 0, -1, -1, 0, 'good'], ['nonsense'], [9, 0, -1, -1, 0, 'no such agent']] };
    assert.equal(text(damaged as any), 'good', 'a half-readable state is better than a broken page');
  });

  it('stays proportional to the text rather than to the typing', () => {
    let state = crdt.empty();
    // Three hundred keystrokes, one character each, the way somebody types.
    for (let i = 0; i < 300; i++) state = crdt.edit(state, 'x'.repeat(i + 1), 'ada');
    assert.equal(text(state).length, 300);
    assert.ok(state.r.length <= 3, `300 keystrokes should coalesce, got ${state.r.length} runs`);
  });
});

describe('compaction', () => {
  it('drops a tombstone nothing points at, and keeps one something does', () => {
    const base = crdt.fromText('hello world', 'ada');
    const trimmed = crdt.edit(base, 'hello', 'ada');
    const compacted = crdt.compact(trimmed);
    assert.equal(text(compacted), 'hello', 'the reading does not change');
    assert.ok(
      JSON.stringify(compacted).length < JSON.stringify(trimmed).length,
      'and it got smaller',
    );
  });

  it('leaves the reading alone when there is nothing to drop', () => {
    const state = crdt.fromText('nothing deleted here', 'ada');
    assert.equal(text(crdt.compact(state)), 'nothing deleted here');
  });
});

/**
 * The property, checked the only way a property can be: at random, many times,
 * from a seed that makes a failure reproducible.
 *
 * Three replicas edit their own copies without seeing each other, then gossip in
 * a random order — the shape of an offline-first sync, where nobody controls who
 * hears what when. Every replica must end up reading exactly the same thing.
 */
describe('convergence under random gossip', () => {
  /** A small deterministic generator, so a failure can be replayed. */
  function random(seed: number): () => number {
    let state = seed >>> 0;
    return () => {
      state = (state * 1664525 + 1013904223) >>> 0;
      return state / 0x100000000;
    };
  }

  const mutate = (text: string, roll: () => number): string => {
    const at = Math.floor(roll() * (text.length + 1));
    if (text.length && roll() < 0.4) {
      const to = Math.min(text.length, at + 1 + Math.floor(roll() * 6));
      return text.slice(0, at) + text.slice(to);
    }
    const word = ['alpha', 'beta ', 'gamma', '\n', 'delta ', '. '][Math.floor(roll() * 6)];
    return text.slice(0, at) + word + text.slice(at);
  };

  for (const seed of [1, 7, 42, 1234, 99991]) {
    it(`converges for seed ${seed}`, () => {
      const roll = random(seed);
      const start = crdt.fromText('# A page\n\nSome writing to start from.\n', 'seed');
      const agents = ['ada', 'lin', 'grace'];

      // Everybody starts in step, then edits alone for a few rounds.
      let replicas = agents.map(() => start);
      for (let round = 0; round < 6; round++) {
        replicas = replicas.map((state, i) => {
          let next = state;
          const edits = 1 + Math.floor(roll() * 3);
          for (let n = 0; n < edits; n++) next = crdt.edit(next, mutate(crdt.textOf(next), roll), agents[i]);
          return next;
        });

        // Then they gossip, in whatever order and however many times.
        const exchanges = 2 + Math.floor(roll() * 5);
        for (let n = 0; n < exchanges; n++) {
          const from = Math.floor(roll() * replicas.length);
          const to = Math.floor(roll() * replicas.length);
          replicas[to] = crdt.merge(replicas[to], replicas[from]);
        }
      }

      // Finally everybody hears everything, which is what sync guarantees.
      const everything = replicas.reduce((left, right) => crdt.merge(left, right));
      const readings = new Set(replicas.map((state) => crdt.textOf(crdt.merge(state, everything))));
      assert.equal(readings.size, 1, `replicas disagreed: ${[...readings].map((r) => JSON.stringify(r)).join(' | ')}`);
      assert.ok([...readings][0].length > 0, 'and there is still a page there');
    });
  }

  it('never invents a character nobody typed', () => {
    const roll = random(2026);
    let a = crdt.fromText('abc', 'seed');
    let b = a;
    for (let i = 0; i < 20; i++) {
      a = crdt.edit(a, mutate(crdt.textOf(a), roll), 'ada');
      b = crdt.edit(b, mutate(crdt.textOf(b), roll), 'lin');
    }
    const merged = crdt.textOf(crdt.merge(a, b));
    const allowed = new Set([...'abcalphbetgmdlx. \n']);
    for (const character of merged) {
      assert.ok(allowed.has(character), `merged text contains ${JSON.stringify(character)}, which nobody typed`);
    }
  });
});
