/**
 * What the Sign-up explainer says.
 *
 * Every claim here is something `packages/server/src/kernel/identity/` does
 * rather than something a marketing page says: the first account is the one
 * `is_admin` lands on, an invite carries a role and refuses a second use, the
 * SSO-only switch closes the password door for accounts that still have one,
 * a recovery code is spent whether or not the sign-in finishes, and session
 * tokens are stored hashed.
 */
export const open = {
  section: 'Sign-up',
  tagline: 'The first account owns the instance. Everybody after that arrives on an invite.',
} as const;

export const beats = {
  account: {
    kicker: 'The first account',
    headline: 'Whoever signs up first owns the server.',
    sub: 'And gets a workspace with it, and a starter project inside that — so the first screen somebody sees is not an empty one.',
  },
  invite: {
    kicker: 'Invites',
    headline: 'One code, one use, one role.',
    sub: 'It carries the role the person will arrive at, it expires, and the moment somebody walks through it, it is nothing.',
  },
  sso: {
    kicker: 'Single sign-on',
    headline: 'Or through your own provider.',
    sub: 'OpenID Connect — and a switch that makes it the only door, not even for accounts that still carry a password from before.',
  },
  twoFactor: {
    kicker: 'Two-factor',
    headline: 'A code, and ten ways back in.',
    sub: 'Time-based codes from any authenticator, and recovery codes that are each spent the moment they are used.',
  },
  sessions: {
    kicker: 'Sessions',
    headline: 'Every device, and the button that ends one.',
    sub: 'Sign-in is rate limited in two directions at once, and what the database holds is a hash rather than a way in.',
  },
} as const;

export const close = {
  headline: 'Your instance, your accounts, and nobody else’s directory.',
} as const;
