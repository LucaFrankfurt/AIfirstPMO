/**
 * The numbers behind a chart, as text.
 *
 * Required rather than a nicety: colour is never the only channel a figure is
 * carried in. It lived beside the insights charts, which meant the budget and
 * KPI screens imported a planning component to get at it — the same
 * cross-capability reach `docs/modules.md` describes. It is furniture.
 */

/** The same numbers as text. Required, not a nicety: colour is never the only channel. */
export function Table({ caption, head, rows }: { caption: string; head: string[]; rows: string[][] }) {
  return (
    <details className="chart-table">
      <summary>{caption}</summary>
      <div className="table-wrap">
        <table className="task-table">
          <thead><tr>{head.map((cell) => <th key={cell}>{cell}</th>)}</tr></thead>
          <tbody>
            {rows.map((row, index) => (
              <tr key={index}>{row.map((cell, cellIndex) => <td key={cellIndex}>{cell}</td>)}</tr>
            ))}
          </tbody>
        </table>
      </div>
    </details>
  );
}
