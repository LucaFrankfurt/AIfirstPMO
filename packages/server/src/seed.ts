/** CLI entry point: `npm run seed`. */
import { seedDemoData } from './modules/operations/demo.ts';
import { installEffects } from './wiring.ts';

// Seeding writes through the same path the server does, so it gets the same
// things hanging off it. Nothing fires today — the demo data creates its rules
// after the tasks they would have matched — but a seed that quietly behaved
// differently from the running server would be a difference nobody could see.
installEffects();

if (!seedDemoData()) console.log('Database already contains a workspace — nothing to seed.');
