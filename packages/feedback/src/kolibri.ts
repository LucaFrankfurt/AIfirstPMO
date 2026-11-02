// @kolibri-day/feedback/kolibri — Kolibri as a feedback target. Runs anywhere fetch does.
export {
  KolibriFeedbackTarget,
  KOLIBRI_TARGET,
  UUID_PATTERN,
  isPermanentStatus,
  type KolibriConfig,
} from './adapters/kolibri/target.ts';
export { kolibriConfigFromEnv, KOLIBRI_ENV_VARS, type Env, type KolibriEnvResult } from './adapters/kolibri/env.ts';
