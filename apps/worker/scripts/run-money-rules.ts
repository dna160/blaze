/**
 * Run the T&C money-rules job once (PRD go-live 2 §10.3), optionally "as of"
 * another moment — for checking a rule before turning it on for a branch.
 *
 *   tsx scripts/run-money-rules.ts [ISO-datetime]
 */
import { runMoneyRules } from "../src/jobs/money-rules.job.js";

const at = process.argv[2] ? new Date(process.argv[2]) : new Date();
runMoneyRules(at)
  .then((summary) => {
    console.log(JSON.stringify(summary));
    process.exit(0);
  })
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
