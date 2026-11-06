/**
 * Budgets, KPIs, the infrastructure register and the timesheet, switched on and
 * given a few rows each, so the browser checks render them instead of the
 * "switched off" notice a seeded workspace shows. Idempotent, like the others.
 */

/** Switch on budget, kpi, infrastructure and time; answers `{ budgetId, kpiId }`. */
export async function switchOnPlanning(page) {
  return page.evaluate(async () => {
    const session = await (await fetch('/api/session')).json();
    const workspace = session.workspaces[0].id;
    const me = session.user.id;
    const api = `/api/workspaces/${workspace}`;
    const list = async (path) => {
      const body = await (await fetch(`${api}/${path}`)).json();
      return Array.isArray(body) ? body : [];
    };
    const post = async (path, body) => {
      const response = await fetch(`${api}/${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!response.ok) throw new Error(`POST ${path} → ${response.status} ${await response.text()}`);
      return response.json();
    };
    const day = (offset) => new Date(Date.now() + offset * 86_400_000).toISOString().slice(0, 10);

    // Merged server-side, so the switches other fixtures set stay on.
    await fetch(api, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ features: { budget: true, kpi: true, infrastructure: true, time: true } }),
    });

    const projects = await (await fetch(`${api}/projects`)).json();
    const project = (projects.projects ?? projects).find((row) => !row.is_container) ?? (projects.projects ?? projects)[0];

    let budget = (await list('budgets'))[0];
    if (!budget) {
      const year = new Date().getUTCFullYear();
      budget = await post('budgets', {
        name: 'Platform operations',
        description: 'Hosting, licences and the people who keep it running.',
        currency: 'EUR',
        approved: 18_000_000,
        period_start: `${year}-01-01`,
        period_end: `${year}-12-31`,
        status: 'active',
        owner_id: me,
        projects: [],
      });
      const lines = [
        { name: 'Cloud servers', category: 'infrastructure', kind: 'opex', amount: 420_000, recurrence: 'monthly', vendor: 'Hetzner', confidence: 'committed' },
        { name: 'Source hosting and CI minutes', category: 'licences', kind: 'opex', amount: 2_100_000, recurrence: 'yearly', vendor: 'GitHub', confidence: 'committed' },
        { name: 'Security audit', category: 'services', kind: 'opex', amount: 3_500_000, recurrence: 'once', vendor: 'An external auditor', confidence: 'likely' },
        { name: 'Replacement build machine', category: 'investment', kind: 'capex', amount: 650_000, recurrence: 'once', vendor: null, confidence: 'possible' },
      ];
      const made = [];
      for (const [index, line] of lines.entries()) {
        made.push(await post('budget-lines', { budget_id: budget.id, starts_on: day(-200), ends_on: null, sort_order: 'VWXY'[index], ...line }));
      }
      for (const [offset, line, amount, stage] of [[-60, 0, 418_000, 'paid'], [-30, 0, 431_500, 'paid'], [-12, 1, 2_100_000, 'invoiced'], [-3, null, 89_900, 'committed']]) {
        await post('budget-actuals', {
          budget_id: budget.id,
          line_id: line === null ? null : made[line].id,
          description: line === null ? 'Conference tickets nobody planned for' : `${lines[line].name}, ${day(offset)}`,
          category: line === null ? 'travel' : lines[line].category,
          amount,
          spent_on: day(offset),
          stage,
        });
      }
    }

    let kpi = (await list('kpis'))[0];
    if (!kpi) {
      kpi = await post('kpis', {
        name: 'Weekly active teams',
        description: 'Teams with at least one task moved in the week.',
        unit: 'percent',
        decimals: 1,
        direction: 'up',
        baseline: 312,
        cadence: 'weekly',
        owner_id: me,
        project_id: project?.id ?? null,
      });
      for (const [weeks, value] of [[-8, 318], [-6, 335], [-4, 341], [-2, 366], [0, 384]]) {
        await post('kpi-readings', { kpi_id: kpi.id, measured_on: day(weeks * 7), value, source: 'Product analytics' });
      }
      await post('kpi-targets', { kpi_id: kpi.id, due_on: day(60), value: 450, note: 'Before the pricing change' });
    }

    if (!(await list('components')).length) {
      const cloud = await post('vendors', { name: 'Hetzner', kind: 'cloud', website: 'https://www.hetzner.com', contract_start: day(-400), notice_days: 30 });
      const saas = await post('vendors', { name: 'GitHub', kind: 'saas', website: 'https://github.com', contract_start: day(-700), contract_end: day(40), notice_days: 60 });
      const server = await post('components', {
        vendor_id: cloud.id, name: 'app-01', kind: 'server', environment: 'production', status: 'live',
        live_from: day(-300), location: 'Falkenstein', amount: 4_290, recurrence: 'monthly', currency: 'EUR', owner_id: me,
      });
      await post('components', { vendor_id: cloud.id, parent_id: server.id, name: 'Kolibri instance', kind: 'instance', environment: 'production', status: 'live', live_from: day(-300), owner_id: me });
      await post('components', { vendor_id: cloud.id, parent_id: server.id, name: 'Nightly snapshot volume', kind: 'storage', environment: 'production', status: 'retiring', live_from: day(-300), live_until: day(30), amount: 480, recurrence: 'monthly', currency: 'EUR' });
      await post('components', { vendor_id: cloud.id, name: 'staging-01', kind: 'server', environment: 'staging', status: 'planned', live_from: day(20), amount: 1_190, recurrence: 'monthly', currency: 'EUR' });
      await post('components', { vendor_id: saas.id, name: 'Organisation plan', kind: 'saas', environment: 'shared', status: 'live', live_from: day(-700), amount: 2_100_000, recurrence: 'yearly', currency: 'EUR', owner_id: me });
    }

    if (project && !(await list('time-entries')).some((row) => row.user_id === me)) {
      const tasks = (await list('tasks')).filter((row) => row.project_id === project.id);
      // Monday of this week up to today, so the week grid has a row with several days in it.
      const back = (new Date().getDay() + 6) % 7;
      for (let offset = -back; offset <= 0; offset++) {
        await post('time-entries', {
          project_id: project.id, task_id: tasks[0]?.id ?? null, user_id: me,
          minutes: 90 + 15 * (offset + back), spent_on: day(offset), billable: true, note: 'Review and fixes',
        });
      }
      if (tasks[1]) await post('time-entries', { project_id: project.id, task_id: tasks[1].id, user_id: me, minutes: 45, spent_on: day(0), billable: false });
    }

    return { budgetId: budget.id, kpiId: kpi.id };
  });
}
