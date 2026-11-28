/**
 * The numbers behind a chart, as text.
 *
 * Required rather than a nicety: colour is never the only channel a figure is
 * carried in. It lived beside the insights charts, which meant the budget and
 * KPI screens imported a planning component to get at it — the same
 * cross-capability reach `docs/modules.md` describes. It is furniture.
 */
import { DataTable, Td, Th, Tr } from './data-table';

/** The same numbers as text. Required, not a nicety: colour is never the only channel. */
export function Table({ caption, head, rows }: { caption: string; head: string[]; rows: string[][] }) {
  return (
    <details className="mt-2.5">
      <summary className="cursor-pointer text-label text-muted">{caption}</summary>
      <div className="table-wrap">
        <DataTable className="mt-1.5">
          <thead><tr>{head.map((cell) => <Th key={cell}>{cell}</Th>)}</tr></thead>
          <tbody>
            {rows.map((row, index) => (
              <Tr key={index}>{row.map((cell, cellIndex) => <Td key={cellIndex}>{cell}</Td>)}</Tr>
            ))}
          </tbody>
        </DataTable>
      </div>
    </details>
  );
}
