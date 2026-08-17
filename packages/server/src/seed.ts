/** CLI entry point: `npm run seed`. */
import { seedDemoData } from './lib/demo.ts';

if (!seedDemoData()) console.log('Database already contains a workspace — nothing to seed.');
