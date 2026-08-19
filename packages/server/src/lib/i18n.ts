/**
 * Server-side translation.
 *
 * The server writes two kinds of text a person reads: notification titles
 * (stored per recipient, so they can be rendered in that person's language at
 * the moment they are created) and emails (rendered per recipient too).
 * Everything else — API error messages — stays English, because it is read by
 * developers and logs, not by the interface.
 *
 * Deliberately a separate catalogue from the web app's: these strings have no
 * counterpart in the UI, and coupling the two would mean the server importing
 * a React module.
 */
import { get, type Row } from '../db/index.ts';
import { env } from '../env.ts';

const en = {
  'notify.assigned': 'Assigned: {identifier} {title}',
  'notify.mentionedIn': 'You were mentioned in {context}',
  'notify.newComment': 'New comment on {identifier}',
  'notify.newPageComment': 'New comment on “{title}”',
  'notify.pageChanged': '“{title}” was edited',
  'notify.dueSoon': '{identifier} {title} is due {date}',
  'notify.overdue': '{identifier} {title} was due {date}',
  'notify.intake': 'Somebody reported something from outside',
  'notify.sharedNote': 'A note on the shared “{title}”',

  'mail.digestSubject': '{count} updates in Kolibri',
  'mail.greeting': 'Hello {name},',
  'mail.by': 'by {name}',
  'mail.openInbox': 'Open your inbox: {url}',
  'mail.turnOff': 'Turn these emails off: {url}',
  'mail.turnOffLabel': 'Turn these emails off',
  'mail.openKolibri': 'Open Kolibri',
  'mail.why': 'You are receiving this because you are involved in this work.',

  'mail.inviteSubject': '{inviter} invited you to {workspace} on Kolibri',
  'mail.inviteTitle': 'Join {workspace}',
  'mail.inviteBody': '{inviter} invited you to join "{workspace}" on Kolibri.',
  'mail.inviteAccept': 'Accept the invitation',
  'mail.inviteAcceptLink': 'Accept the invitation: {url}',
  'mail.inviteIgnore': 'If you were not expecting this, you can ignore this message.',

  'mail.testSubject': 'Kolibri test email',
  'mail.testTitle': 'SMTP is working',
  'mail.testText': 'This is a test message from Kolibri.\n\nIf you can read it, SMTP is configured correctly.',
  'mail.testBody': 'This is a test message from your Kolibri instance.',
  'mail.testRelay': 'Relay: {relay}',
  'mail.backToSettings': 'Back to settings',

  /* A new project's workflow and labels are seeded in the creator's language.
     They are ordinary editable rows afterwards — this only decides the first
     impression, which should not be in a language the team does not use. */
  'seed.stateBacklog': 'Backlog',
  'seed.stateTodo': 'Todo',
  'seed.stateInProgress': 'In Progress',
  'seed.stateInReview': 'In Review',
  'seed.stateDone': 'Done',
  'seed.stateCancelled': 'Cancelled',
  'seed.typeTask': 'Task',
  'seed.typeBug': 'Bug',
  'seed.typeFeature': 'Feature',
  'seed.labelBug': 'bug',
  'seed.labelFeature': 'feature',
  'seed.labelImprovement': 'improvement',
  'seed.labelDocumentation': 'documentation',

  /* The feedback template and rule every new project starts with. */
  'seed.feedbackTemplate': 'Feedback request',
  'seed.feedbackTitle': 'Feedback: {identifier} {title}',
  'seed.feedbackBody': '{identifier} **{title}** moved to *{state}* and is ready for a look.\n\nThe task: {url}\n\nLeave what you find as comments on that task, and close this one when you are done.',
  'seed.feedbackSub1': 'Does it do what the task asked for?',
  'seed.feedbackSub2': 'Anything here that will surprise somebody later?',
  'seed.feedbackSub3': 'Is it written down where the next person will look?',
  'seed.feedbackRule': 'Ask for feedback when a task enters review',
  'seed.starterProject': 'Getting started',
} as const;

type Catalogue = { readonly [K in keyof typeof en]: string };

const de: Catalogue = {
  'notify.assigned': 'Zugewiesen: {identifier} {title}',
  'notify.mentionedIn': 'Du wurdest in {context} erwähnt',
  'notify.newComment': 'Neuer Kommentar zu {identifier}',
  'notify.newPageComment': 'Neuer Kommentar zu „{title}“',
  'notify.pageChanged': '„{title}“ wurde bearbeitet',
  'notify.dueSoon': '{identifier} {title} ist am {date} fällig',
  'notify.overdue': '{identifier} {title} war am {date} fällig',
  'notify.intake': 'Jemand von außerhalb hat etwas gemeldet',
  'notify.sharedNote': 'Eine Notiz zur geteilten Seite „{title}“',

  'mail.digestSubject': '{count} Neuigkeiten in Kolibri',
  'mail.greeting': 'Hallo {name},',
  'mail.by': 'von {name}',
  'mail.openInbox': 'Posteingang öffnen: {url}',
  'mail.turnOff': 'Diese E-Mails abbestellen: {url}',
  'mail.turnOffLabel': 'Diese E-Mails abbestellen',
  'mail.openKolibri': 'Kolibri öffnen',
  'mail.why': 'Du bekommst diese Nachricht, weil du an dieser Arbeit beteiligt bist.',

  'mail.inviteSubject': '{inviter} hat dich zu {workspace} auf Kolibri eingeladen',
  'mail.inviteTitle': '{workspace} beitreten',
  'mail.inviteBody': '{inviter} hat dich eingeladen, „{workspace}“ auf Kolibri beizutreten.',
  'mail.inviteAccept': 'Einladung annehmen',
  'mail.inviteAcceptLink': 'Einladung annehmen: {url}',
  'mail.inviteIgnore': 'Wenn du damit nicht gerechnet hast, kannst du diese Nachricht ignorieren.',

  'mail.testSubject': 'Kolibri-Testmail',
  'mail.testTitle': 'SMTP funktioniert',
  'mail.testText': 'Dies ist eine Testnachricht von Kolibri.\n\nWenn du sie lesen kannst, ist SMTP richtig konfiguriert.',
  'mail.testBody': 'Dies ist eine Testnachricht von deiner Kolibri-Instanz.',
  'mail.testRelay': 'Relay: {relay}',
  'mail.backToSettings': 'Zurück zu den Einstellungen',

  'seed.stateBacklog': 'Backlog',
  'seed.stateTodo': 'Zu erledigen',
  'seed.stateInProgress': 'In Arbeit',
  'seed.stateInReview': 'In Review',
  'seed.stateDone': 'Erledigt',
  'seed.stateCancelled': 'Abgebrochen',
  'seed.typeTask': 'Aufgabe',
  'seed.typeBug': 'Bug',
  'seed.typeFeature': 'Feature',
  // Bug and Feature are what German teams actually say; the other two are not.
  'seed.labelBug': 'Bug',
  'seed.labelFeature': 'Feature',
  'seed.labelImprovement': 'Verbesserung',
  'seed.labelDocumentation': 'Dokumentation',

  'seed.feedbackTemplate': 'Feedback anfordern',
  'seed.feedbackTitle': 'Feedback: {identifier} {title}',
  'seed.feedbackBody': '{identifier} **{title}** steht jetzt auf *{state}* und wartet auf einen Blick.\n\nZur Aufgabe: {url}\n\nSchreib deine Anmerkungen als Kommentare an diese Aufgabe und schließ die hier, wenn du fertig bist.',
  'seed.feedbackSub1': 'Tut es, was die Aufgabe verlangt hat?',
  'seed.feedbackSub2': 'Gibt es hier etwas, das später jemanden überrascht?',
  'seed.feedbackSub3': 'Steht es dort geschrieben, wo die nächste Person nachschaut?',
  'seed.feedbackRule': 'Feedback anfordern, wenn eine Aufgabe in Review geht',
  'seed.starterProject': 'Erste Schritte',
};

export const LOCALES = { en, de } as const;
export type Locale = keyof typeof LOCALES;
export type ServerKey = keyof typeof en;

export const isLocale = (value: unknown): value is Locale =>
  typeof value === 'string' && value in LOCALES;

/** The locale used when a user has not picked one. */
export const defaultLocale = (): Locale => (isLocale(env.defaultLocale) ? env.defaultLocale : 'en');

export function translate(locale: Locale, key: ServerKey, vars?: Record<string, string | number>): string {
  // A locale that is not compiled in can still reach here from a stale database
  // row; English is a better answer than a crash or a raw key.
  const catalogue = (LOCALES[locale] ?? en) as Record<string, string>;
  const template = catalogue[key] ?? en[key] ?? key;
  return vars
    ? template.replace(/\{(\w+)\}/g, (match, name: string) => (name in vars ? String(vars[name]) : match))
    : template;
}

/** The recipient's own language, falling back to the instance default. */
export function localeOf(userId: string | null | undefined): Locale {
  if (!userId) return defaultLocale();
  const row = get<Row>(`SELECT locale FROM users WHERE id = ?`, userId);
  return isLocale(row?.locale) ? row.locale : defaultLocale();
}

/** Bound translator for one recipient, so call sites stay readable. */
export const translatorFor = (userId: string | null | undefined) => {
  const locale = localeOf(userId);
  return (key: ServerKey, vars?: Record<string, string | number>) => translate(locale, key, vars);
};
