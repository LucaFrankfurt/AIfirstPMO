/**
 * The setup the browser checks need before a support screen exists at all.
 *
 * A seeded workspace has support switched off, so `/support` is a screen that
 * says so and nothing else — and the inbox, the widget settings and the
 * visitor's window would all go unrendered by every check. The mail fixture
 * says the rest of this better; see `mail-fixture.mjs`.
 *
 * Idempotent, like that one: the walkthrough may already have left the switch
 * on and a widget behind.
 */

/**
 * Switch support on, leave an anonymous widget, and a conversation in it with
 * one line from a visitor. Returns the widget's and the conversation's ids.
 *
 * The conversation is opened the way a visitor opens one — through the
 * widget's own routes — because nothing else can make one: a member is not
 * allowed to.
 */
export async function switchOnSupport(page) {
  return page.evaluate(async () => {
    const json = { 'content-type': 'application/json' };
    const session = await (await fetch('/api/session')).json();
    const workspace = session.workspaces[0].id;
    await fetch(`/api/workspaces/${workspace}`, { method: 'PATCH', headers: json, body: JSON.stringify({ features: { support: true } }) });

    const widgets = await (await fetch(`/api/workspaces/${workspace}/widgets`)).json();
    let widget = (Array.isArray(widgets) ? widgets : []).find((row) => row.identity === 'anonymous');
    if (!widget) {
      const projects = await (await fetch(`/api/workspaces/${workspace}/projects`)).json();
      const project = (projects.projects ?? projects)[0];
      widget = await (await fetch(`/api/workspaces/${workspace}/widgets`, {
        method: 'POST',
        headers: json,
        body: JSON.stringify({
          project_id: project.id,
          name: 'Website visitors',
          identity: 'anonymous',
          origins: ['example.com'],
          greeting: 'Hi! How can we help?',
        }),
      })).json();
    }

    const conversations = await (await fetch(`/api/workspaces/${workspace}/conversations`)).json();
    let conversation = (Array.isArray(conversations) ? conversations : []).find((row) => row.widget_id === widget.id);
    if (!conversation) {
      const opened = await (await fetch(`/w/${widget.id}/session`, {
        method: 'POST',
        headers: json,
        body: JSON.stringify({ name: 'Grace Visitor', email: 'grace@example.com' }),
      })).json();
      await fetch(`/w/${widget.id}/messages`, {
        method: 'POST',
        headers: { ...json, 'x-widget-session': opened.session },
        body: JSON.stringify({ body: 'Hello — is there a way to export my invoices as a spreadsheet?' }),
      });
      conversation = opened.conversation;
    }
    return { widgetId: widget.id, conversationId: conversation.id };
  });
}
