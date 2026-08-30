/**
 * The two rules that no end-to-end test could reach.
 *
 * A budget line, an actual, a scenario, a KPI target and a reading each belong
 * to the workspace of the *parent they name* rather than the one the write
 * arrived in. Those are the same thing on every path a client can take, because
 * `guardReferences` refuses a parent in another workspace one step earlier —
 * which is exactly why the rule had no test: through the API it cannot be told
 * apart from doing nothing.
 *
 * It is not doing nothing. The child rows are read by joining on `budget_id`
 * and `kpi_id`, so a row whose two answers disagree appears in one query and
 * not the next. The path where that can happen is the server's own: a `system`
 * write skips `guardReferences`, and imports, restores and transfers all take
 * it. So the rule is driven from there, where it is the only thing standing
 * between a mismatched id and a row that is half in one workspace.
 *
 * Written when these rules moved out of `repo.ts` into `lib/rules/`, because a
 * rule nothing checks is a rule a refactor can quietly drop — the other 29 in
 * that move announced themselves by failing, and these two did not.
 */
process.env.NODE_ENV = 'test';
process.env.KOLIBRI_DATA_DIR = `/tmp/kolibri-entity-rules-${process.pid}`;

import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { after, before, describe, it } from 'node:test';

const { installEffects } = await import('../src/wiring.ts');
const { writeEntity } = await import('../src/kernel/write-path/repo.ts');
const { createWorkspace } = await import('../src/kernel/write-path/bootstrap.ts');
const { get, run } = await import('../src/kernel/platform/db/index.ts');
const { uid } = await import('../src/kernel/platform/ids.ts');

let mine = '';
let theirs = '';
let actor = '';
let clock = 0;

/** A server write: the path that skips `guardReferences`. */
const system = (workspaceId: string) => ({
  workspaceId, actorId: actor, hlc: `${++clock}:0:test`, system: true,
});

before(() => {
  installEffects();
  actor = uid();
  run(`INSERT INTO users (id, email, name, created_at, updated_at) VALUES (?, ?, ?, ?, ?)`,
    actor, 'rules@example.test', 'Rules', Date.now(), Date.now());
  mine = String(createWorkspace('Mine', actor).id);
  theirs = String(createWorkspace('Theirs', actor).id);
});

after(() => rmSync(process.env.KOLIBRI_DATA_DIR!, { recursive: true, force: true }));

describe('a child row lives where its parent lives', () => {
  it('a budget line follows its budget, not the write', () => {
    const budgetId = uid();
    writeEntity('budget', budgetId, { workspace_id: mine, name: 'Platform', currency: 'EUR' }, system(mine));

    const lineId = uid();
    // The write says one workspace and the parent says another. Only one of
    // them can be right, and it is not the write.
    writeEntity('budgetLine', lineId,
      { workspace_id: theirs, budget_id: budgetId, name: 'Hosting', amount: 1000 }, system(theirs));

    const line = get<{ workspace_id: string }>(`SELECT workspace_id FROM budget_lines WHERE id = ?`, lineId);
    assert.equal(line?.workspace_id, mine, 'the line should have followed its budget');
  });

  it('a KPI reading follows its KPI, not the write', () => {
    const kpiId = uid();
    writeEntity('kpi', kpiId, { workspace_id: mine, name: 'Uptime', unit: 'percent' }, system(mine));

    const readingId = uid();
    writeEntity('kpiReading', readingId,
      { workspace_id: theirs, kpi_id: kpiId, value: 99, measured_on: '2026-01-01' }, system(theirs));

    const reading = get<{ workspace_id: string }>(`SELECT workspace_id FROM kpi_readings WHERE id = ?`, readingId);
    assert.equal(reading?.workspace_id, mine, 'the reading should have followed its KPI');
  });

  it('leaves a child whose parent does not exist where it was put', () => {
    // Nothing to follow is not the same as something to correct: the rule
    // returns rather than blanking a workspace it cannot improve on.
    const orphanId = uid();
    writeEntity('budgetLine', orphanId,
      { workspace_id: theirs, budget_id: uid(), name: 'Orphan', amount: 1 }, system(theirs));

    const line = get<{ workspace_id: string }>(`SELECT workspace_id FROM budget_lines WHERE id = ?`, orphanId);
    assert.equal(line?.workspace_id, theirs);
  });
});
