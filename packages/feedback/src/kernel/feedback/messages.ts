// Every user- and operator-facing string the package produces, per language.
//
// English is the default; German ships alongside, because the first app to use this
// speaks it. An app that needs different wording overrides single entries by
// spreading:
//
//     const messages = { ...en, notice: { ...en.notice, selfHosted: (l) => `…${l}…` } };
//
// Parameterised strings are functions rather than templates with placeholders: the
// compiler then checks every call site passes what the sentence needs.

export interface FeedbackMessages {
  /** BCP 47 tag, informational. */
  locale: string;
  /** Labels for the default kinds (BUG/IDEA/OTHER). An app with its own kinds passes `kindLabels`. */
  kinds: Readonly<Record<string, string>>;
  /** The Markdown report body (target side). */
  report: {
    untitled: string;
    description: string;
    serverContext: string;
    clientContext: string;
    field: string;
    value: string;
    reportedBy: string;
    userId: string;
    reportedAtServer: string;
    reportId: string;
    url: string;
    pageTitle: string;
    viewport: string;
    screen: string;
    devicePixelRatio: string;
    userAgent: string;
    language: string;
    timezone: string;
    online: string;
    connection: string;
    clientTime: string;
    yes: string;
    no: string;
    openReport: string;
  };
  /** The privacy notice next to the screenshot toggle. */
  notice: {
    selfHosted: (targetLabel: string) => string;
    thirdParty: (targetLabel: string) => string;
  };
  /** Display names of the built-in non-tracker targets. */
  targets: {
    fake: string;
    unconfigured: string;
  };
  /** Errors from the Kolibri target. They end up in an operator-visible "last error". */
  kolibri: {
    unreachable: (path: string, detail: string) => string;
    createRejected: (status: number, body: string) => string;
    uploadRejected: (status: number, body: string) => string;
  };
  /** Configuration problems found while resolving the target from the environment. */
  config: {
    targetUnset: string;
    fakeInProduction: string;
    missingVariables: (target: string, names: readonly string[]) => string;
    notUuid: (variable: string, expected: 'workspace' | 'project', value: string) => string;
    unknownTarget: (value: string, known: readonly string[]) => string;
  };
  /** Validation errors for an incoming report (server side, shown to the reporter). */
  input: {
    messageRequired: string;
    messageTooLong: (max: number) => string;
    unknownKind: string;
    screenshotTooLarge: string;
    unsupportedImage: string;
    bodyTooLarge: string;
    invalidRequest: string;
  };
}

export const de: FeedbackMessages = {
  locale: 'de',
  kinds: { BUG: 'Bug', IDEA: 'Idee', OTHER: 'Sonstiges' },
  report: {
    untitled: '(ohne Beschreibung)',
    description: 'Beschreibung',
    serverContext: 'Kontext (serverseitig ermittelt)',
    clientContext: 'Kontext (clientseitig gemeldet — nicht verifiziert)',
    field: 'Feld',
    value: 'Wert',
    reportedBy: 'Gemeldet von',
    userId: 'Nutzer-ID',
    reportedAtServer: 'Gemeldet am (Server)',
    reportId: 'Report-ID',
    url: 'URL',
    pageTitle: 'Seitentitel',
    viewport: 'Viewport',
    screen: 'Bildschirm',
    devicePixelRatio: 'Device Pixel Ratio',
    userAgent: 'Browser (User-Agent)',
    language: 'Sprache',
    timezone: 'Zeitzone',
    online: 'Online',
    connection: 'Verbindung',
    clientTime: 'Uhrzeit (Client)',
    yes: 'ja',
    no: 'nein',
    openReport: 'Report in der App öffnen',
  },
  notice: {
    selfHosted: (label) =>
      `Der Screenshot zeigt diese Ansicht inkl. aller darin sichtbaren Daten und wird in eurem selbst-betriebenen ${label} gespeichert.`,
    thirdParty: (label) =>
      `Achtung: Der Screenshot zeigt diese Ansicht inkl. aller darin sichtbaren Daten und wird an ${label} übertragen — ein externes System außerhalb eurer eigenen Infrastruktur.`,
  },
  targets: {
    fake: 'Test-Ziel (lokal)',
    unconfigured: 'kein Zielsystem',
  },
  kolibri: {
    unreachable: (path, detail) => `Kolibri nicht erreichbar (${path}): ${detail}`,
    createRejected: (status, body) => `Kolibri hat die Task-Erstellung abgelehnt (HTTP ${status}): ${body}`,
    uploadRejected: (status, body) => `Kolibri hat den Datei-Upload abgelehnt (HTTP ${status}): ${body}`,
  },
  config: {
    targetUnset: 'FEEDBACK_TARGET ist nicht gesetzt — Reports werden gespeichert, aber an kein Zielsystem übermittelt.',
    fakeInProduction: 'FEEDBACK_TARGET=fake in production — Reports gehen an kein echtes Zielsystem.',
    missingVariables: (target, names) =>
      `FEEDBACK_TARGET=${target}, aber folgende Variablen fehlen: ${names.join(', ')}.`,
    notUuid: (variable, expected, value) =>
      expected === 'workspace'
        ? `${variable} muss eine UUID sein, kein Slug (ist: "${value}").`
        : `${variable} muss eine UUID sein, kein Projekt-Key (ist: "${value}").`,
    unknownTarget: (value, known) =>
      `FEEDBACK_TARGET="${value}" ist unbekannt (erwartet: ${known.map((k) => `"${k}"`).join(' oder ')}).`,
  },
  input: {
    messageRequired: 'Bitte beschreiben Sie kurz, worum es geht.',
    messageTooLong: (max) => `Die Beschreibung ist zu lang (max. ${max} Zeichen).`,
    unknownKind: 'Unbekannte Art der Rückmeldung.',
    screenshotTooLarge: 'Der Screenshot ist zu groß.',
    unsupportedImage: 'Nicht unterstütztes Bildformat.',
    bodyTooLarge: 'Die Rückmeldung ist zu groß.',
    invalidRequest: 'Ungültige Anfrage.',
  },
};

export const en: FeedbackMessages = {
  locale: 'en',
  kinds: { BUG: 'Bug', IDEA: 'Idea', OTHER: 'Other' },
  report: {
    untitled: '(no description)',
    description: 'Description',
    serverContext: 'Context (determined server-side)',
    clientContext: 'Context (reported by the client — not verified)',
    field: 'Field',
    value: 'Value',
    reportedBy: 'Reported by',
    userId: 'User ID',
    reportedAtServer: 'Reported at (server)',
    reportId: 'Report ID',
    url: 'URL',
    pageTitle: 'Page title',
    viewport: 'Viewport',
    screen: 'Screen',
    devicePixelRatio: 'Device pixel ratio',
    userAgent: 'Browser (user agent)',
    language: 'Language',
    timezone: 'Time zone',
    online: 'Online',
    connection: 'Connection',
    clientTime: 'Time (client)',
    yes: 'yes',
    no: 'no',
    openReport: 'Open report in the app',
  },
  notice: {
    selfHosted: (label) =>
      `The screenshot shows this view, including any data visible in it, and is stored in your self-hosted ${label}.`,
    thirdParty: (label) =>
      `Attention: the screenshot shows this view, including any data visible in it, and is sent to ${label} — an external system outside your own infrastructure.`,
  },
  targets: {
    fake: 'Test target (local)',
    unconfigured: 'no target system',
  },
  kolibri: {
    unreachable: (path, detail) => `Kolibri unreachable (${path}): ${detail}`,
    createRejected: (status, body) => `Kolibri rejected the task creation (HTTP ${status}): ${body}`,
    uploadRejected: (status, body) => `Kolibri rejected the file upload (HTTP ${status}): ${body}`,
  },
  config: {
    targetUnset: 'FEEDBACK_TARGET is not set — reports are stored but delivered to no target system.',
    fakeInProduction: 'FEEDBACK_TARGET=fake in production — reports reach no real target system.',
    missingVariables: (target, names) =>
      `FEEDBACK_TARGET=${target}, but these variables are missing: ${names.join(', ')}.`,
    notUuid: (variable, expected, value) =>
      expected === 'workspace'
        ? `${variable} must be a UUID, not a slug (is: "${value}").`
        : `${variable} must be a UUID, not a project key (is: "${value}").`,
    unknownTarget: (value, known) =>
      `FEEDBACK_TARGET="${value}" is unknown (expected: ${known.map((k) => `"${k}"`).join(' or ')}).`,
  },
  input: {
    messageRequired: 'Please describe briefly what this is about.',
    messageTooLong: (max) => `The description is too long (max. ${max} characters).`,
    unknownKind: 'Unknown kind of feedback.',
    screenshotTooLarge: 'The screenshot is too large.',
    unsupportedImage: 'Unsupported image format.',
    bodyTooLarge: 'The feedback is too large.',
    invalidRequest: 'Invalid request.',
  },
};

export const messages = { en, de } as const;
export type FeedbackLocale = keyof typeof messages;

/** The kinds an app gets when it does not define its own. */
export const DEFAULT_FEEDBACK_KINDS = ['BUG', 'IDEA', 'OTHER'] as const;
