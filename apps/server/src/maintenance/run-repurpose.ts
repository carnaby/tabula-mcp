// Usage (inside the production container):
//   node dist/maintenance/run-repurpose.js                                  dry run: prints the plan
//   node dist/maintenance/run-repurpose.js --apply --archive-global=<uuid,uuid>  applies it
import { createDb } from '../db/client.js';
import { applyRepurpose, formatPlan, parseArgs, planRepurpose } from './repurpose.js';

let parsed: ReturnType<typeof parseArgs>;
try {
  parsed = parseArgs(process.argv.slice(2));
} catch (e) {
  console.error((e as Error).message);
  process.exit(2);
}
const { apply, archiveGlobal: ids } = parsed;
const url = process.env.DATABASE_URL;
if (!url) {
  console.error('DATABASE_URL is required');
  process.exit(1);
}

const { db, close } = createDb(url);
try {
  const plan = await planRepurpose(db, ids);
  console.log(formatPlan(plan));
  if (plan.unknownIds.length) {
    console.error(`\nNot active global memories: ${plan.unknownIds.join(', ')}. Nothing changed.`);
    process.exitCode = 2;
  } else if (!apply) {
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
