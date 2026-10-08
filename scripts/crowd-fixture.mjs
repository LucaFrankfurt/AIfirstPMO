/**
 * A workspace with enough in it for the menus to be the question.
 *
 * `check:menus` against a seeded demo would certify nothing: three projects and
 * four labels fit any menu, flat or not. The screenshots that started this had
 * eight labels all called "Bug" — one per project — which is what an ordinary
 * workspace looks like after a year, and what no fixture here had ever built.
 *
 * So this crowds one: more projects than fit in a drawer-less menu, and labels
 * sharing names across them on purpose, because the same word eight times is
 * the case where a flat list stops being readable even when it fits.
 *
 * Written through the API rather than the database, so what it makes is what a
 * person makes — including the per-project workflow states a new project is
 * seeded with, which are themselves a list some menus pour out.
 */

/** Names that repeat across projects, because that is what really happens. */
const SHARED = ['Bug', 'Business', 'Improvement', 'Research'];

export async function crowd(page, base) {
  return page.evaluate(async ({ base: at, shared }) => {
    const workspace = localStorage.getItem('kolibri.workspace');
    const post = async (path, body) => {
      const response = await fetch(`${at}${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify(body),
      });
      return response.ok ? response.json() : null;
    };

    const existing = await (await fetch(`${at}/api/workspaces/${workspace}/projects`, { credentials: 'include' })).json();
    const already = (existing.projects ?? existing).length;

    // Eight is the number the report came from, and enough that a flat list of
    // anything per project runs past the bottom of a window.
    const made = [];
    for (let n = already; n < 8; n++) {
      const project = await post(`/api/workspaces/${workspace}/projects`, {
        name: `Crowd ${n}`, key: `CRW${n}`,
      });
      if (project?.id ?? project?.project?.id) made.push(project.id ?? project.project.id);
    }

    /*
     * Labels that share a name across projects: the exact shape that makes a
     * flat list unreadable, since the name alone identifies nothing.
     *
     * Skipped where the pair already exists, so running this twice crowds the
     * workspace once. It is not only tidiness — a fixture that doubles its own
     * output every run makes the check it feeds report a different number each
     * time, which is a check nobody can read.
     */
    const projects = await (await fetch(`${at}/api/workspaces/${workspace}/projects`, { credentials: 'include' })).json();
    const before = await (await fetch(`${at}/api/workspaces/${workspace}/labels`, { credentials: 'include' })).json();
    const have = new Set(((before.labels ?? before)).map((label) => `${label.project_id}:${label.name}`));
    for (const project of (projects.projects ?? projects).slice(0, 8)) {
      for (const name of shared) {
        if (have.has(`${project.id}:${name}`)) continue;
        await post(`/api/workspaces/${workspace}/labels`, {
          name, color: '#ef4444', project_id: project.id,
        });
      }
    }

    const labels = await (await fetch(`${at}/api/workspaces/${workspace}/labels`, { credentials: 'include' })).json();
    return {
      projects: (projects.projects ?? projects).length,
      labels: (labels.labels ?? labels).length,
      made: made.length,
    };
  }, { base, shared: SHARED });
}
