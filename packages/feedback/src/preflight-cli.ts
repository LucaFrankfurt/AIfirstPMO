#!/usr/bin/env node
// The `kolibri-feedback-preflight` command. All of it lives in
// adapters/kolibri/preflight.ts; this file only hands it the process.
import { runPreflight } from './adapters/kolibri/preflight.ts';

runPreflight(process.env, process.argv.slice(2)).then(
  (code) => process.exit(code),
  (error: unknown) => {
    console.error(error);
    process.exit(1);
  },
);
