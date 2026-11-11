/**
 * The visitor's words: thirty of them, in the three languages the app speaks.
 *
 * Not the app's catalogue, on purpose. That is three thousand strings for
 * screens a visitor will never see, and it was most of what this page
 * downloaded on the first click. The words a visitor shares with the app's own
 * threads are copies, and `widget-words.test.ts` holds them to the app's
 * wording, so a change to one that does not reach the other fails rather than
 * drifts.
 */
import type { ThreadWords } from '../../kernel/design-system/conversation';

const CATALOGUE = {
  en: {
    assistant: 'Assistant',
    sources: 'From',
    person: 'Talk to a person',
    personComing: 'A person from the team will answer here.',
    resolve: 'Mark as resolved',
    done: 'Done',
    resolvedNotice: 'This chat is resolved. Write again to reopen it.',
    newChat: 'Start a new chat',
    welcome: 'Hi! How can we help?',
    connecting: 'Connecting…',
    unavailable: 'This chat is not available right now.',
    notSignedIn: 'Sign in on the site to chat with us.',
    ended: 'The chat session ended. Reopen the chat to continue.',
    introduce: 'Tell us who you are — both optional — so we can answer by email if you leave.',
    name: 'Name',
    email: 'Email',
    start: 'Start chatting',
    replyByEmail: 'We answer here — and by email if you have left.',
    sendFailed: 'Not sent.',
    retry: 'Try again',
    uploadFailed: 'The picture could not be sent.',
    close: 'Close chat',
    team: 'Team',
    sending: 'Sending…',
    seen: 'Seen',
    typing: 'Somebody is typing',
    attach: 'Add a picture',
    placeholder: 'Write a message…',
    send: 'Send',
    today: 'Today',
    yesterday: 'Yesterday',
    actions: 'What to do with this message',
    typingNamed: '{name} is typing',
  },
  de: {
    assistant: 'Assistent',
    sources: 'Aus',
    person: 'Mit einem Menschen sprechen',
    personComing: 'Ein Mensch aus dem Team antwortet hier.',
    resolve: 'Als erledigt markieren',
    done: 'Erledigt',
    resolvedNotice: 'Dieser Chat ist erledigt. Schreib einfach weiter, um ihn wieder zu öffnen.',
    newChat: 'Neuen Chat starten',
    welcome: 'Hallo! Wie können wir helfen?',
    connecting: 'Verbinde…',
    unavailable: 'Dieser Chat ist gerade nicht verfügbar.',
    notSignedIn: 'Melde dich auf der Seite an, um mit uns zu chatten.',
    ended: 'Die Chat-Sitzung ist beendet. Öffne den Chat erneut, um weiterzuschreiben.',
    introduce: 'Sag uns, wer du bist — beides optional —, damit wir per E-Mail antworten können, falls du gehst.',
    name: 'Name',
    email: 'E-Mail',
    start: 'Chat starten',
    replyByEmail: 'Wir antworten hier — und per E-Mail, falls du schon weg bist.',
    sendFailed: 'Nicht gesendet.',
    retry: 'Erneut versuchen',
    uploadFailed: 'Das Bild konnte nicht gesendet werden.',
    close: 'Chat schließen',
    team: 'Team',
    sending: 'Wird gesendet…',
    seen: 'Gesehen',
    typing: 'Jemand schreibt',
    attach: 'Bild hinzufügen',
    placeholder: 'Nachricht schreiben…',
    send: 'Senden',
    today: 'Heute',
    yesterday: 'Gestern',
    actions: 'Was mit dieser Nachricht geschehen soll',
    typingNamed: '{name} schreibt',
  },
  fr: {
    assistant: 'Assistant',
    sources: 'Source',
    person: 'Parler à une personne',
    personComing: 'Une personne de l’équipe va répondre ici.',
    resolve: 'Marquer comme résolu',
    done: 'Terminé',
    resolvedNotice: 'Cette conversation est résolue. Écrivez à nouveau pour la rouvrir.',
    newChat: 'Nouvelle conversation',
    welcome: 'Bonjour ! Comment pouvons-nous aider ?',
    connecting: 'Connexion…',
    unavailable: 'Ce chat n’est pas disponible pour le moment.',
    notSignedIn: 'Connectez-vous sur le site pour discuter avec nous.',
    ended: 'La session de chat est terminée. Rouvrez le chat pour continuer.',
    introduce: 'Dites-nous qui vous êtes — facultatif — pour que nous puissions répondre par e-mail si vous partez.',
    name: 'Nom',
    email: 'E-mail',
    start: 'Commencer',
    replyByEmail: 'Nous répondons ici — et par e-mail si vous êtes parti.',
    sendFailed: 'Non envoyé.',
    retry: 'Réessayer',
    uploadFailed: 'L’image n’a pas pu être envoyée.',
    close: 'Fermer le chat',
    team: 'Équipe',
    sending: 'Envoi…',
    seen: 'Vu',
    typing: 'Quelqu’un écrit',
    attach: 'Ajouter une image',
    placeholder: 'Écrire un message…',
    send: 'Envoyer',
    today: 'Aujourd’hui',
    yesterday: 'Hier',
    actions: 'Que faire de ce message',
    typingNamed: '{name} écrit',
  },
} as const;

export type WidgetLocale = keyof typeof CATALOGUE;
type Words = { readonly [K in keyof (typeof CATALOGUE)['en']]: string };
export type WidgetWords = Omit<Words, 'typingNamed'> & ThreadWords;

/** The visitor's language, from what their browser asks for; English when it asks for nothing we speak. */
export function widgetLocale(languages: readonly string[] = navigator.languages ?? [navigator.language]): WidgetLocale {
  for (const candidate of languages) {
    const base = candidate.toLowerCase().split('-')[0];
    if (base in CATALOGUE) return base as WidgetLocale;
  }
  return 'en';
}

export function widgetWords(locale: WidgetLocale): WidgetWords {
  const words: Words = CATALOGUE[locale];
  const at = (timestamp: number) => new Date(timestamp);
  const sameYear = (timestamp: number) => at(timestamp).getFullYear() === new Date().getFullYear();
  return {
    ...words,
    typingNamed: (name: string) => words.typingNamed.replace('{name}', name),
    clock: (timestamp) => at(timestamp).toLocaleTimeString(locale, { hour: 'numeric', minute: '2-digit' }),
    exact: (timestamp) => at(timestamp).toLocaleString(locale, { dateStyle: 'medium', timeStyle: 'short' }),
    day: (timestamp) => at(timestamp).toLocaleDateString(locale, {
      weekday: 'long', day: 'numeric', month: 'long', ...(sameYear(timestamp) ? {} : { year: 'numeric' }),
    }),
  };
}

/**
 * The words shared with the app's own threads, and the key each copies.
 *
 * Only these are copies; the rest — the greeting, "start chatting" — exist
 * nowhere else. `widget-words.test.ts` holds the copies to the app's catalogue.
 */
export const COPIED_FROM = {
  sending: 'thread.sending',
  seen: 'thread.seen',
  typing: 'thread.typing',
  typingNamed: 'thread.typingNamed',
  attach: 'thread.attach',
  placeholder: 'thread.placeholder',
  send: 'thread.send',
  today: 'chat.today',
  yesterday: 'chat.yesterday',
  actions: 'chat.messageActions',
} as const;

export const WIDGET_CATALOGUE = CATALOGUE;
