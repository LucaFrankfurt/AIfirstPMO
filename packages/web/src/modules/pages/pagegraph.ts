/**
 * The link graph, given somewhere to be.
 *
 * Apart from the component for the reason `pagetree.ts` is: this is arithmetic
 * with edge cases — a wiki with one page, a wiki with two pages nothing joins,
 * a page linked to by everything — and arithmetic is worth proving without a
 * browser. The component reads the pages out of the store and draws what comes
 * back.
 *
 * It is **deterministic**. A force layout is usually seeded at random, which
 * means the same wiki draws differently every time the screen is opened and a
 * reader who learned where their handbook sits has to learn it again. Positions
 * start from the node's own id, so the picture is the same picture until the
 * links change — and a test can assert about it.
 *
 * No library, because the server has no runtime dependencies and the client
 * should not grow one for a screen. What is here is the whole of a spring
 * layout: things push apart, links pull together, and the middle pulls
 * everything in so nothing drifts off the canvas.
 */

/** A page in the picture, or a title somebody has linked to and not written. */
export interface GraphNode {
  id: string;
  label: string;
  kind: 'page' | 'unwritten';
}

export interface GraphEdge {
  from: string;
  to: string;
}

export interface Placed extends GraphNode {
  x: number;
  y: number;
  /** How many edges touch it — what the drawing sizes a node by. */
  degree: number;
}

/**
 * A number between 0 and 1 from a string, stable across runs.
 *
 * `Math.random` would do, and would be wrong: see the note at the top. This is
 * FNV-1a, which is four lines and spreads ids that differ in one character —
 * the case that matters, because ids here are uuids sharing a prefix.
 */
function hashed(text: string, salt: number): number {
  let hash = 0x811c9dc5 ^ salt;
  for (let at = 0; at < text.length; at += 1) {
    hash ^= text.charCodeAt(at);
    hash = Math.imul(hash, 0x01000193);
  }
  return ((hash >>> 0) % 100_000) / 100_000;
}

/**
 * How many rounds of the simulation this graph gets.
 *
 * A round costs a pass over every pair, so the work is `nodes² × rounds` and a
 * fixed number of rounds means a big wiki freezes the tab. The budget is on the
 * *work* rather than on how many pages somebody is allowed to have, which is
 * the honest way round: a small graph gets a settled layout, a large one gets a
 * rougher one drawn in about the same time, and neither is refused.
 */
const roundsFor = (count: number): number =>
  Math.max(40, Math.min(300, Math.round(150_000 / Math.max(count * count, 1))));

/**
 * Where each node goes, inside a `size × size` box.
 *
 * The three forces are the usual three and the constants are tuned by looking
 * at real wikis rather than derived from anything: repulsion falls off with
 * distance so distant clusters stop shoving each other, springs pull along
 * links, and a weak pull to the middle keeps a component that nothing links to
 * from wandering off. Cooling stops the whole thing oscillating around a
 * minimum it has already found.
 */
export function layout(nodes: GraphNode[], edges: GraphEdge[], size = 600): Placed[] {
  if (!nodes.length) return [];
  const at = new Map(nodes.map((node, index) => [node.id, index]));
  const degree = new Map<string, number>();
  for (const edge of edges) {
    if (!at.has(edge.from) || !at.has(edge.to)) continue;
    degree.set(edge.from, (degree.get(edge.from) ?? 0) + 1);
    degree.set(edge.to, (degree.get(edge.to) ?? 0) + 1);
  }

  // Seeded on a spiral rather than a circle: a circle puts every node the same
  // distance out, and a symmetric start is the one arrangement the forces
  // cannot break out of.
  const x = new Float64Array(nodes.length);
  const y = new Float64Array(nodes.length);
  for (let i = 0; i < nodes.length; i += 1) {
    const angle = hashed(nodes[i].id, 1) * Math.PI * 2;
    const radius = (0.15 + hashed(nodes[i].id, 2) * 0.85) * size * 0.4;
    x[i] = size / 2 + Math.cos(angle) * radius;
    y[i] = size / 2 + Math.sin(angle) * radius;
  }

  const pairs = edges
    .map((edge) => [at.get(edge.from), at.get(edge.to)] as const)
    .filter((pair): pair is readonly [number, number] => pair[0] !== undefined && pair[1] !== undefined);

  const rounds = roundsFor(nodes.length);
  const spread = size * size * 0.06;
  const dx = new Float64Array(nodes.length);
  const dy = new Float64Array(nodes.length);

  for (let round = 0; round < rounds; round += 1) {
    dx.fill(0);
    dy.fill(0);

    for (let i = 0; i < nodes.length; i += 1) {
      for (let j = i + 1; j < nodes.length; j += 1) {
        let ax = x[i] - x[j];
        let ay = y[i] - y[j];
        let distance = Math.hypot(ax, ay);
        if (distance < 0.01) {
          // Two nodes exactly on top of each other have no direction to push
          // in. Nudged apart by their ids, so it stays deterministic.
          ax = hashed(nodes[i].id, 3) - 0.5;
          ay = hashed(nodes[j].id, 4) - 0.5;
          distance = Math.hypot(ax, ay) || 1;
        }
        const push = spread / (distance * distance);
        dx[i] += (ax / distance) * push;
        dy[i] += (ay / distance) * push;
        dx[j] -= (ax / distance) * push;
        dy[j] -= (ay / distance) * push;
      }
    }

    for (const [i, j] of pairs) {
      const ax = x[j] - x[i];
      const ay = y[j] - y[i];
      const distance = Math.hypot(ax, ay) || 1;
      const pull = distance * 0.012;
      dx[i] += (ax / distance) * pull * distance;
      dy[i] += (ay / distance) * pull * distance;
      dx[j] -= (ax / distance) * pull * distance;
      dy[j] -= (ay / distance) * pull * distance;
    }

    const cooling = size * 0.06 * (1 - round / rounds);
    for (let i = 0; i < nodes.length; i += 1) {
      dx[i] += (size / 2 - x[i]) * 0.012;
      dy[i] += (size / 2 - y[i]) * 0.012;
      const step = Math.hypot(dx[i], dy[i]) || 1;
      const scale = Math.min(step, cooling) / step;
      x[i] += dx[i] * scale;
      y[i] += dy[i] * scale;
    }
  }

  return fit(nodes, x, y, size, degree);
}

/**
 * Scale what the simulation produced into the box the drawing has.
 *
 * The forces have no idea how big the canvas is — they settle at whatever
 * distance the constants imply — so the last step is to take the extent they
 * ended up with and stretch it to fit. A single node, or a row of nodes all at
 * the same height, has an extent of zero in one direction; those land in the
 * middle rather than dividing by it.
 */
function fit(
  nodes: GraphNode[],
  x: Float64Array,
  y: Float64Array,
  size: number,
  degree: Map<string, number>,
): Placed[] {
  // Room for the labels, which sit above their node and are wider than it: a
  // margin sized for the circles alone clipped every title near an edge.
  const margin = size * 0.12;
  const span = size - margin * 2;
  const lowX = Math.min(...x);
  const lowY = Math.min(...y);
  const wide = Math.max(...x) - lowX;
  const tall = Math.max(...y) - lowY;
  // One scale for both axes, so a graph does not come out stretched into the
  // shape of its container — the distances are the information here.
  const scale = Math.min(wide > 0 ? span / wide : Infinity, tall > 0 ? span / tall : Infinity);
  const factor = Number.isFinite(scale) ? scale : 1;
  const offsetX = margin + (span - wide * factor) / 2;
  const offsetY = margin + (span - tall * factor) / 2;

  return nodes.map((node, index) => ({
    ...node,
    x: wide > 0 || tall > 0 ? offsetX + (x[index] - lowX) * factor : size / 2,
    y: wide > 0 || tall > 0 ? offsetY + (y[index] - lowY) * factor : size / 2,
    degree: degree.get(node.id) ?? 0,
  }));
}
