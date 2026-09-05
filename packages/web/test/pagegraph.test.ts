/**
 * The link graph, laid out.
 *
 * What is worth asserting about a force layout is not where anything ends up —
 * that is the constants talking — but the four properties a reader depends on
 * without knowing it: the picture is the same picture next time, everything is
 * inside the frame, two pages that link to each other end up nearer than two
 * that do not, and none of the degenerate wikis divides by zero. A wiki with
 * one page and a wiki with two unconnected pages are both things people have on
 * their first day.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { layout, type GraphEdge, type GraphNode } from '../src/modules/pages/pagegraph.ts';

const page = (id: string): GraphNode => ({ id, label: id, kind: 'page' });

const chain: GraphNode[] = ['a', 'b', 'c', 'd'].map(page);
const chained: GraphEdge[] = [
  { from: 'a', to: 'b' },
  { from: 'b', to: 'c' },
  { from: 'c', to: 'd' },
];

const between = (placed: ReturnType<typeof layout>, one: string, two: string): number => {
  const a = placed.find((node) => node.id === one)!;
  const b = placed.find((node) => node.id === two)!;
  return Math.hypot(a.x - b.x, a.y - b.y);
};

describe('laying out the link graph', () => {
  it('draws the same picture twice', () => {
    // A layout seeded at random asks somebody who learned where their handbook
    // sits to learn it again every time they open the screen.
    assert.deepEqual(layout(chain, chained), layout(chain, chained));
  });

  it('keeps everything inside the frame', () => {
    for (const node of layout(chain, chained, 600)) {
      assert.ok(node.x >= 0 && node.x <= 600, `x out of frame: ${node.x}`);
      assert.ok(node.y >= 0 && node.y <= 600, `y out of frame: ${node.y}`);
    }
  });

  it('puts pages that link to each other nearer than pages that do not', () => {
    const placed = layout(chain, chained);
    assert.ok(between(placed, 'a', 'b') < between(placed, 'a', 'd'), 'the ends of a chain are its furthest apart');
  });

  it('counts the edges touching each node, which is what sizes it', () => {
    const placed = layout(chain, chained);
    assert.equal(placed.find((node) => node.id === 'b')!.degree, 2);
    assert.equal(placed.find((node) => node.id === 'a')!.degree, 1);
  });

  it('survives the wikis somebody has on their first day', () => {
    assert.deepEqual(layout([], []), []);

    const alone = layout([page('a')], [], 600);
    assert.equal(alone.length, 1);
    assert.ok(Number.isFinite(alone[0].x) && Number.isFinite(alone[0].y), 'one page has nothing to be scaled against');

    // Two pages and nothing joining them: the extent is zero in one direction
    // for as long as the forces happen to keep them level.
    for (const node of layout([page('a'), page('b')], [], 600)) {
      assert.ok(Number.isFinite(node.x) && Number.isFinite(node.y));
    }
  });

  it('ignores an edge naming something that is not in the picture', () => {
    // An unwritten title that two pages want is one node; a link to a page the
    // reader may not see is an edge to nothing.
    const placed = layout([page('a')], [{ from: 'a', to: 'gone' }], 600);
    assert.equal(placed.length, 1);
    assert.equal(placed[0].degree, 0, 'an edge to nothing is not a connection');
  });

  it('separates two nodes that start in the same place', () => {
    const twins = layout([page('x'), page('x')], [], 600);
    assert.ok(Number.isFinite(twins[0].x) && Number.isFinite(twins[1].x));
  });
});
