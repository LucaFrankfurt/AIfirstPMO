/**
 * The setup the browser checks need before an incident screen exists.
 *
 * The mail fixture explains why each of these files has to exist at all: a
 * seeded workspace has every switch **off**, so a feature-gated screen left out
 * of a fixture is not merely unchecked — it is unreachable, and every check
 * passes without ever rendering it.
 *
 * An incident is worth its own because of what its detail carries: a status
 * select in the header, a row of chips, four stat tiles, a timeline with both
 * kinds of line, a composer with three selects and a button on one row, the
 * link pickers, and a form of three-column grids. That is the name rule, the
 * contrast floor and the 340px row in one screen. And it leaves one incident
 * active, so the start page draws its panel.
 *
 * Idempotent, for the reason the others are: CI runs the walkthroughs first and
 * somebody running a check by hand starts from nothing.
 */

/**
 * Switch incidents on for the signed-in person's first workspace and leave one
 * active P1 with a worked timeline, and one resolved incident. Answers the id
 * of the active one, which is the screen worth walking.
 *
 * Runs inside the page, which is what holds the session cookie.
 */
export async function switchOnIncidents(page) {
  return page.evaluate(async () => {
    const session = await (await fetch('/api/session')).json();
    const workspace = session.workspaces[0].id;
    const me = session.user.id;
    const send = async (method, path, body) => (await fetch(path, {
      method,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })).json();

    await send('PATCH', `/api/workspaces/${workspace}`, { features: { incidents: true } });

    // The generic collection answers with a bare array — see the ballot fixture
    // for what reading the wrong shape here once cost.
    const answer = await (await fetch(`/api/workspaces/${workspace}/incidents`)).json();
    const active = Array.isArray(answer)
      ? answer.find((row) => !['resolved', 'closed', 'cancelled'].includes(row.status))
      : null;
    if (active) return active.id;

    const shop = await send('POST', `/api/workspaces/${workspace}/applications`, { name: 'Web shop', criticality: 'critical' });
    const payments = await send('POST', `/api/workspaces/${workspace}/applications`, { name: 'Payments', criticality: 'high' });
    await send('POST', `/api/workspaces/${workspace}/applications`, { name: 'Intranet', criticality: 'low' });

    const hour = 3_600_000;
    const now = Date.now();
    const incident = await send('POST', `/api/workspaces/${workspace}/incidents`, {
      summary: 'Checkout returns an error for every card payment',
      description: 'Since the 14:00 deploy, every card payment ends on “Something went wrong”. PayPal works.',
      impact: 'high',
      urgency: 'high',
      category: 'application',
      applications: [shop.id, payments.id],
      manager_id: me,
      responders: [me],
      reported_by: 'Customer service',
      started_at: now - 2 * hour,
      detected_at: now - 2 * hour + 9 * 60_000,
      financial_impact: 1_250_000,
      currency: 'EUR',
      affected_users: 340,
    });
    await send('POST', `/api/workspaces/${workspace}/incident-updates`, {
      incident_id: incident.id, kind: 'update', body: 'Investigating: card payments fail at the provider step.', occurred_at: now - 90 * 60_000,
    });
    await send('POST', `/api/workspaces/${workspace}/incident-updates`, {
      incident_id: incident.id, kind: 'note', body: 'The new release changed the payment timeout from 30 s to 3 s.', occurred_at: now - 60 * 60_000,
    });
    await send('PATCH', `/api/incidents/${incident.id}`, { status: 'identified' });

    const earlier = await send('POST', `/api/workspaces/${workspace}/incidents`, {
      summary: 'VPN logins slow for the Berlin office',
      impact: 'medium',
      urgency: 'low',
      category: 'network',
      started_at: now - 30 * hour,
      detected_at: now - 29 * hour,
      ended_at: now - 26 * hour,
    });
    await send('PATCH', `/api/incidents/${earlier.id}`, {
      status: 'resolved',
      resolution_code: 'third_party',
      resolution: 'The provider replaced a failing line card.',
    });

    return incident.id;
  });
}
