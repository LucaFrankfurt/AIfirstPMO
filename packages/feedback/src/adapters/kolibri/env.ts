// Reading a Kolibri configuration from environment variables.
//
// The variable names are the package's convention (KOLIBRI_API_URL, KOLIBRI_TOKEN,
// KOLIBRI_WORKSPACE_ID, KOLIBRI_PROJECT_ID) so every app that adopts it is configured
// — and preflighted — the same way.
import { UUID_PATTERN, type KolibriConfig } from './target.ts';
import { en, type FeedbackMessages } from '../../kernel/feedback/messages.ts';

export type Env = Readonly<Record<string, string | undefined>>;

export const KOLIBRI_ENV_VARS = [
  'KOLIBRI_API_URL',
  'KOLIBRI_TOKEN',
  'KOLIBRI_WORKSPACE_ID',
  'KOLIBRI_PROJECT_ID',
] as const;

export type KolibriEnvResult =
  | { ok: true; config: Pick<KolibriConfig, 'apiUrl' | 'token' | 'workspaceId' | 'projectId'> }
  | { ok: false; reason: string };

/**
 * Read and validate the four variables. Never throws: a problem comes back as a
 * reason worded for an operator.
 */
export function kolibriConfigFromEnv(env: Env, messages: FeedbackMessages = en): KolibriEnvResult {
  const apiUrl = env.KOLIBRI_API_URL?.trim() ?? '';
  const token = env.KOLIBRI_TOKEN?.trim() ?? '';
  const workspaceId = env.KOLIBRI_WORKSPACE_ID?.trim() ?? '';
  const projectId = env.KOLIBRI_PROJECT_ID?.trim() ?? '';

  const missing = KOLIBRI_ENV_VARS.filter((name) => !env[name]?.trim());
  if (missing.length > 0) {
    return { ok: false, reason: messages.config.missingVariables('kolibri', missing) };
  }
  // The workspace is checked first because it is the one that decides WHO can see the
  // screenshots, so a typo in it is the more expensive of the two.
  if (!UUID_PATTERN.test(workspaceId)) {
    return { ok: false, reason: messages.config.notUuid('KOLIBRI_WORKSPACE_ID', 'workspace', workspaceId) };
  }
  if (!UUID_PATTERN.test(projectId)) {
    return { ok: false, reason: messages.config.notUuid('KOLIBRI_PROJECT_ID', 'project', projectId) };
  }
  return { ok: true, config: { apiUrl, token, workspaceId, projectId } };
}
