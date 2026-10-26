// Usage (inside the production container):
//   node dist/maintenance/run-repurpose.js                                  dry run: prints the plan
//   node dist/maintenance/run-repurpose.js --apply --archive-global=<uuid,uuid>  applies it
import { createDb } from '../db/client.js';
import { applyRepurpose, formatPlan, planRepurpose } from './repurpose.js';

const args = process.argv.slice(2);
const apply = args.includes('--apply');
const idsArg = args.find((a) => a.startsWith('--archive-global='));
const ids = idsArg ? idsArg.slice('--archive-global='.length).split(',') : [];
const url = process.env.DATABASE_URL;
if (!url) {
  console.error('DATABASE_URL is required');
  process.exit(1);
}

const { db, close } = createDb(url);
try {
  const plan = await planRepurpose(db, ids);
  console.log(formatPlan(plan));
  if (!apply) {
    console.log('\nDry run: nothing changed. Re-run with --apply (and --archive-global=<uuid,uuid,…> for the confirmed global records).');
  } else {
    const r = await applyRepurpose(db, plan);
    console.log(`\nApplied: ${r.archived} memories archived, ${r.movedNotes} notes moved into the notebook.`);
  }
} catch (e) {
  console.error((e as Error).message);
  process.exitCode = 1;
} finally {
  await close();
}
