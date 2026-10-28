/**
 * The setup the browser checks need before a meeting screen exists.
 *
 * The mail fixture explains why each of these files has to exist at all: a
 * seeded workspace has every switch **off**, so a feature-gated screen left out
 * of a fixture is not merely unchecked — it is unreachable, and every check
 * passes without ever rendering it.
 *
 * A meeting is worth its own because of what its detail carries: a numbered
 * point whose title is an input dressed as a heading, a status select beside
 * it, project chips with an icon button inside each, the notes field, the
 * tasks filed from the point, and a menu button with no visible label. That is
 * the name rule, the contrast floor and the 340px row in one card.
 *
 * Idempotent, for the reason the others are: CI runs the walkthroughs first and
 * somebody running a check by hand starts from nothing.
 */

/**
 * Switch meetings on for the signed-in person's first workspace and leave one
 * planned meeting with a worked agenda, and one closed one. Answers the id of
 * the planned meeting, which is the screen worth walking.
 *
 * Runs inside the page, which is what holds the session cookie.
 */
export async function switchOnMeetings(page) {
  return page.evaluate(async () => {
    const session = await (await fetch('/api/session')).json();
    const workspace = session.workspaces[0].id;
    const me = session.user.id;
    const post = async (path, body) => (await fetch(path, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })).json();

    await fetch(`/api/workspaces/${workspace}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ features: { meetings: true } }),
    });

    // The generic collection answers with a bare array — see the ballot fixture
    // for what reading the wrong shape here once cost.
    const answer = await (await fetch(`/api/workspaces/${workspace}/meetings`)).json();
    const planned = Array.isArray(answer) ? answer.find((row) => row.status === 'planned') : null;
    if (planned) return planned.id;

    const projects = await (await fetch(`/api/workspaces/${workspace}/projects`)).json();
    const project = (projects.projects ?? projects).find((row) => !row.is_container) ?? (projects.projects ?? projects)[0];
    const tomorrow = new Date();
    tomorrow.setDate(tomorrow.getDate() + 1);
    tomorrow.setHours(10, 0, 0, 0);

    const meeting = await post(`/api/workspaces/${workspace}/meetings`, {
      title: 'Weekly product sync',
      description: 'What shipped, what is stuck, and who picks it up.',
      starts_at: tomorrow.getTime(),
      location: 'Room 2 / https://meet.example.com/weekly',
      attendees: [me],
      status: 'planned',
    });

    const points = [
      {
        title: 'Release date for the onboarding redesign',
        description: 'Design is signed off; QA wants another two days.',
        projects: project ? [project.id] : [],
        status: 'discussed',
        notes: 'Agreed: ship on Friday. Ada writes the release note, QA checks the empty states first.',
      },
      {
        title: 'Pricing page copy',
        description: null,
        projects: project ? [project.id] : [],
        status: 'open',
        notes: null,
      },
      { title: 'Hiring: second backend engineer', description: null, projects: [], status: 'deferred', notes: null },
    ];
    // Three keys in base-62 order, which is all `orderKey` would have handed
    // out for three appends.
    const made = [];
    for (const [index, point] of points.entries()) {
      made.push(await post(`/api/workspaces/${workspace}/agenda-items`, { meeting_id: meeting.id, sort_order: 'VWX'[index], ...point }));
    }

    // A task filed from the first point, so the point's task list has a row.
    if (project) {
      const states = await (await fetch(`/api/workspaces/${workspace}/states?project_id=${project.id}`)).json();
      await post(`/api/workspaces/${workspace}/tasks`, {
        project_id: project.id,
        title: 'Write the release note',
        state_id: (states[0] ?? {}).id,
        assignees: [me],
        agenda_item_id: made[0].id,
      });
    }

    const last = new Date(tomorrow.getTime() - 7 * 86_400_000);
    await post(`/api/workspaces/${workspace}/meetings`, {
      title: 'Weekly product sync',
      starts_at: last.getTime(),
      attendees: [me],
      status: 'done',
    });
    return meeting.id;
  });
}
