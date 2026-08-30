/**
 * A text CRDT for page bodies.
 *
 * The problem it solves is the one thing last-writer-wins cannot: two people
 * typing in the same page at the same time. Per-field LWW picks one body and
 * files the other in history — nothing is *lost*, but somebody's paragraph
 * disappears from the page they were looking at, which is not a merge.
 *
 * ## Why a state-based one
 *
 * This app syncs *rows*, not operations. Every row reaches every device exactly
 * once, in any order, with per-field last-writer-wins — and that shape is a very
 * good fit for a **state-based** CRDT, where merging two states is a pure
 * function of the two. The whole document state lives in one column, the merge
 * replaces LWW for that one column, and the sync engine is untouched.
 *
 * The alternative — an operation per keystroke as its own row — would grow
 * without bound and need a compaction scheme nobody can make safe, because
 * "every device has certainly seen this" is not knowable in an offline-first
 * system. A page body is a few kilobytes; sending it whole on save is cheaper
 * than the machinery required to avoid it.
 *
 * ## The model
 *
 * RGA, stored as runs. Every character has an identity `(agent, clock)` that
 * never changes, and remembers the identity of the character that was to its
 * left when it was typed — its *origin*. The document order is then a
 * deterministic function of the set of characters:
 *
 *   walk the origin tree depth-first; among characters sharing an origin, the
 *   causally newer one comes first — a Lamport timestamp, with the agent id
 *   breaking a tie.
 *
 * Deterministic function of a set means convergence, with no ordering
 * assumptions about how the rows arrived. That is the whole proof.
 *
 * Runs are an encoding detail: a run of characters typed in sequence by one
 * agent is stored as one entry. Splitting is deterministic — the character at
 * offset `k` of a run starting at `clock` is `(agent, clock + k)` on every
 * replica — so two devices that split the same run at different points still
 * agree about every character.
 *
 * ## What it does not do
 *
 * Two people typing *at the same instant at the same position* can interleave
 * at run boundaries. RGA keeps each person's run together far better than a
 * position-key scheme does, but Fugue and Peritext handle the last cases
 * properly and this does not. It converges and never loses a character, which
 * is the promise being made.
 *
 * Cost is linear in the length of the document per merge, not per keystroke.
 * For a wiki page that is nothing; this is not the CRDT for a 200 MB log.
 */

/** One character, as it exists in the merged set. */
interface Char {
  agent: string;
  clock: number;
  origin: string | null;
  char: string;
  deleted: boolean;
}

/** A run of characters by one agent, stored and sent as a unit. */
interface Run {
  agent: string;
  clock: number;
  origin: string | null;
  text: string;
  deleted: boolean;
}

/** The state as it is stored: agents interned, runs as tuples. */
export interface CrdtState {
  /** Format marker, so a later shape can be told from this one. */
  v: 1;
  /** Agent ids, interned — they repeat on every run otherwise. */
  a: string[];
  /** `[agentIndex, clock, originAgentIndex, originClock, deleted, text]` */
  r: [number, number, number, number, 0 | 1, string][];
}

const EMPTY: CrdtState = { v: 1, a: [], r: [] };
export const empty = (): CrdtState => ({ v: 1, a: [], r: [] });

const idOf = (agent: string, clock: number): string => `${agent}:${clock}`;

/* ------------------------------------------------------------- decoding */

function toRuns(state: CrdtState | null | undefined): Run[] {
  if (!state || state.v !== 1 || !Array.isArray(state.r)) return [];
  const agents = Array.isArray(state.a) ? state.a : [];
  const runs: Run[] = [];
  for (const entry of state.r) {
    if (!Array.isArray(entry) || entry.length < 6) continue;
    const [ai, clock, oai, oclock, deleted, text] = entry;
    const agent = agents[ai];
    if (!agent || typeof text !== 'string' || !text.length) continue;
    runs.push({
      agent,
      clock: Number(clock),
      // -1 in the origin slot means "the start of the document".
      origin: oai < 0 ? null : idOf(agents[oai] ?? '', Number(oclock)),
      text,
      deleted: deleted === 1,
    });
  }
  return runs;
}

/**
 * Runs to characters.
 *
 * Every character in a run except the first has the previous one as its origin,
 * which is what makes a run a run — and what lets any replica split it at any
 * point and still agree with every other replica about the result.
 */
function toChars(runs: Run[]): Map<string, Char> {
  const chars = new Map<string, Char>();
  for (const run of runs) {
    for (let i = 0; i < run.text.length; i++) {
      const clock = run.clock + i;
      chars.set(idOf(run.agent, clock), {
        agent: run.agent,
        clock,
        origin: i === 0 ? run.origin : idOf(run.agent, clock - 1),
        char: run.text[i],
        deleted: run.deleted,
      });
    }
  }
  return chars;
}

/* -------------------------------------------------------------- ordering */

/**
 * The document order: a pure function of the character set.
 *
 * Depth-first through the origin tree, newest first among siblings. "Newest"
 * is the clock, with the agent id breaking ties — any total order works as long
 * as every replica uses the same one, and this one is stable and needs no
 * clock synchronisation.
 *
 * Iterative rather than recursive because a page is a long chain of characters
 * each originating on the last, and that is exactly the shape that overflows a
 * call stack.
 */
function order(chars: Map<string, Char>): Char[] {
  const children = new Map<string | null, Char[]>();
  for (const char of chars.values()) {
    // A character whose origin has not arrived yet hangs off the root rather
    // than disappearing: half a merge is better than a missing sentence, and
    // the ordering repairs itself when the rest turns up.
    const parent = char.origin !== null && chars.has(char.origin) ? char.origin : null;
    const list = children.get(parent);
    if (list) list.push(char);
    else children.set(parent, [char]);
  }
  for (const list of children.values()) {
    list.sort((a, b) => (b.clock - a.clock) || (a.agent < b.agent ? 1 : a.agent > b.agent ? -1 : 0));
  }

  const out: Char[] = [];
  const stack: Char[] = [...(children.get(null) ?? [])].reverse();
  while (stack.length) {
    const char = stack.pop()!;
    out.push(char);
    const kids = children.get(idOf(char.agent, char.clock));
    if (kids) for (let i = kids.length - 1; i >= 0; i--) stack.push(kids[i]);
  }
  return out;
}

/** Characters back into runs, coalescing whatever can be. */
function toRunsAgain(ordered: Char[]): Run[] {
  const runs: Run[] = [];
  for (const char of ordered) {
    const last = runs[runs.length - 1];
    const continues = last
      && last.agent === char.agent
      && last.deleted === char.deleted
      && last.clock + last.text.length === char.clock
      && char.origin === idOf(char.agent, char.clock - 1);
    if (continues) last.text += char.char;
    else runs.push({ agent: char.agent, clock: char.clock, origin: char.origin, text: char.char, deleted: char.deleted });
  }
  return runs;
}

function encode(runs: Run[]): CrdtState {
  const agents: string[] = [];
  const index = new Map<string, number>();
  const intern = (agent: string): number => {
    let at = index.get(agent);
    if (at === undefined) {
      at = agents.length;
      agents.push(agent);
      index.set(agent, at);
    }
    return at;
  };

  const rows = runs.map((run) => {
    const [oa, oc] = run.origin ? splitId(run.origin) : ['', -1];
    return [
      intern(run.agent), run.clock,
      run.origin ? intern(oa) : -1, oc,
      run.deleted ? 1 : 0,
      run.text,
    ] as [number, number, number, number, 0 | 1, string];
  });
  return { v: 1, a: agents, r: rows };
}

const splitId = (id: string): [string, number] => {
  const at = id.lastIndexOf(':');
  return [id.slice(0, at), Number(id.slice(at + 1))];
};

/* ---------------------------------------------------------------- the API */

/** The text a state reads as. */
export function textOf(state: CrdtState | null | undefined): string {
  const chars = order(toChars(toRuns(state)));
  let out = '';
  for (const char of chars) if (!char.deleted) out += char.char;
  return out;
}

/**
 * Merge two states.
 *
 * Commutative, associative and idempotent, which is what makes it safe to apply
 * in any order, twice, or against a state that already contains it — all three
 * of which happen routinely in an offline-first sync.
 *
 * A character deleted on either side is deleted in the result. Delete wins over
 * insert because the alternative — resurrecting text somebody removed — is the
 * behaviour people file bugs about.
 */
export function merge(a: CrdtState | null | undefined, b: CrdtState | null | undefined): CrdtState {
  const left = toChars(toRuns(a));
  const right = toChars(toRuns(b));
  if (!left.size) return b ? normalise(right) : EMPTY;
  if (!right.size) return normalise(left);

  for (const [id, char] of right) {
    const mine = left.get(id);
    if (!mine) left.set(id, char);
    else if (char.deleted) mine.deleted = true;
  }
  return normalise(left);
}

const normalise = (chars: Map<string, Char>): CrdtState => encode(toRunsAgain(order(chars)));

/**
 * The state that says exactly `text`, as though one agent had typed it.
 *
 * Used when text arrives with no CRDT behind it — an import, the API, a page
 * written before this existed. It is a *replacement*, not a merge: whoever sent
 * plain text meant the text they sent.
 */
export function fromText(text: string, agent: string): CrdtState {
  if (!text) return empty();
  return encode([{ agent, clock: 0, origin: null, text, deleted: false }]);
}

/**
 * Rewrite a state so that it reads as `next`.
 *
 * The editor is an ordinary textarea, so what is known is the text before and
 * the text after — not the keystrokes. The common prefix and suffix are found,
 * everything between them is deleted, and the new middle is inserted at that
 * point. For real typing the changed middle is a character or two, which is
 * exactly the granularity the operations would have had anyway.
 *
 * The clock is a **Lamport timestamp** taken from the state: one more than the
 * highest this replica has seen from anybody. That is not a detail. Ordering
 * siblings by "newer first" is only meaningful if newer means *causally* newer,
 * and two agents counting their own keystrokes produce numbers that cannot be
 * compared — somebody who has typed ten characters today would outrank somebody
 * who has typed three, including on text they wrote after reading it.
 *
 * It is taken from the state rather than from the caller for the same reason a
 * counter is not passed in: the state already contains everything this replica
 * knows, and asking a caller to keep a monotonic counter forever is asking it
 * to introduce a bug that reorders text silently instead of failing.
 */
export function edit(
  state: CrdtState | null | undefined,
  next: string,
  agent: string,
): CrdtState {
  const chars = toChars(toRuns(state));
  const ordered = order(chars);
  const visible = ordered.filter((char) => !char.deleted);
  const previous = visible.map((char) => char.char).join('');
  if (previous === next) return state && state.v === 1 ? state : empty();

  let clock = 0;
  for (const char of chars.values()) if (char.clock >= clock) clock = char.clock + 1;

  let head = 0;
  while (head < previous.length && head < next.length && previous[head] === next[head]) head++;
  let tail = 0;
  while (
    tail < previous.length - head
    && tail < next.length - head
    && previous[previous.length - 1 - tail] === next[next.length - 1 - tail]
  ) tail++;

  // Everything between the shared ends is gone.
  for (let i = head; i < previous.length - tail; i++) visible[i].deleted = true;

  // The insertion hangs off the last surviving character before the change —
  // the *visible* one, since a tombstone is not a place anybody typed.
  const inserted = next.slice(head, next.length - tail);
  let originId = head > 0 ? idOf(visible[head - 1].agent, visible[head - 1].clock) : null;
  let at = clock;
  for (const character of inserted) {
    const id = idOf(agent, at);
    chars.set(id, { agent, clock: at, origin: originId, char: character, deleted: false });
    originId = id;
    at++;
  }

  return normalise(chars);
}

/** Roughly how much the state costs to carry, for the caller that has to care. */
export const sizeOf = (state: CrdtState | null | undefined): number =>
  (state?.r ?? []).reduce((total, run) => total + (typeof run[5] === 'string' ? run[5].length : 0), 0);

/**
 * Drop tombstones nobody can still be referring to.
 *
 * A tombstone is only needed while another replica might still send an insert
 * that hangs off it. There is no way to know that for certain in an
 * offline-first system, so this is deliberately **not** run automatically: it
 * is offered to `kolibri doctor`, where a person decides, and it keeps any
 * tombstone that something visible still points at.
 */
export function compact(state: CrdtState | null | undefined): CrdtState {
  const chars = toChars(toRuns(state));
  const needed = new Set<string>();
  for (const char of chars.values()) if (char.origin) needed.add(char.origin);
  for (const [id, char] of chars) {
    if (char.deleted && !needed.has(id)) chars.delete(id);
  }
  return normalise(chars);
}
