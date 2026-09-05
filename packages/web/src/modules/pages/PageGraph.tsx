/**
 * The wiki, drawn.
 *
 * A graph view is the feature every note-taking tool demonstrates and almost
 * nobody navigates by, and it was left out of the first version of this for
 * exactly that reason. What earns it a place here is the second colour: a
 * hollow node is a title somebody linked to and nobody has written, so the
 * picture is not only "what is joined to what" but "where the holes are" — and
 * that is a question the tree and the backlink list genuinely cannot answer at
 * a glance.
 *
 * It is deliberately *not* the main way in. The tree above it is, and this sits
 * behind a toggle: an SVG of circles is a poor list, whatever it is a good
 * picture of. Every node is a real link, so the keyboard reaches all of them in
 * reading order and the browser's own focus ring says where it is.
 */
import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { layout, type GraphEdge, type GraphNode } from './pagegraph';
import { useT } from '../../kernel/i18n/i18n';

/** The side of the square the layout works in; the SVG scales from there. */
const SIZE = 600;

/** Big enough to see, small enough that a well-linked page does not eat its neighbours. */
const radiusFor = (degree: number): number => 4 + Math.min(degree, 12) * 0.9;

export function PageGraph({ nodes, edges }: { nodes: GraphNode[]; edges: GraphEdge[] }) {
  const t = useT();
  // Hovering a node is how you read a hairball: everything else goes quiet, so
  // the one question the picture is being asked — what is this joined to — has
  // an answer without clicking anything.
  const [active, setActive] = useState<string | null>(null);

  const placed = useMemo(() => layout(nodes, edges, SIZE), [nodes, edges]);
  const at = useMemo(() => new Map(placed.map((node) => [node.id, node])), [placed]);
  const neighbours = useMemo(() => {
    if (!active) return null;
    const near = new Set<string>([active]);
    for (const edge of edges) {
      if (edge.from === active) near.add(edge.to);
      if (edge.to === active) near.add(edge.from);
    }
    return near;
  }, [active, edges]);

  const dim = (id: string): boolean => !!neighbours && !neighbours.has(id);

  return (
    <svg
      className="page-graph"
      viewBox={`0 0 ${SIZE} ${SIZE}`}
      role="group"
      aria-label={t('page.graph')}
      onMouseLeave={() => setActive(null)}
    >
      {edges.map((edge, index) => {
        const from = at.get(edge.from);
        const to = at.get(edge.to);
        if (!from || !to) return null;
        const quiet = dim(edge.from) && dim(edge.to);
        return (
          <line
            key={`${edge.from}-${edge.to}-${index}`}
            x1={from.x} y1={from.y} x2={to.x} y2={to.y}
            className={quiet ? 'quiet' : undefined}
          />
        );
      })}
      {placed.map((node) => (
        // A page is a link to itself; an unwritten title is a link to writing
        // it, which is the same offer the faint `[[…]]` in a body makes.
        <Link
          key={node.id}
          to={node.kind === 'page' ? `/pages/${node.id}` : `/pages/new?title=${encodeURIComponent(node.label)}`}
          className={`page-graph-node${node.kind === 'unwritten' ? ' unwritten' : ''}${dim(node.id) ? ' quiet' : ''}`}
          onMouseEnter={() => setActive(node.id)}
          onFocus={() => setActive(node.id)}
          onBlur={() => setActive(null)}
        >
          <title>{node.label}</title>
          <circle cx={node.x} cy={node.y} r={radiusFor(node.degree)} />
          <text x={node.x} y={node.y - radiusFor(node.degree) - 5} textAnchor="middle">
            {node.label.length > 22 ? `${node.label.slice(0, 22)}…` : node.label}
          </text>
        </Link>
      ))}
    </svg>
  );
}
