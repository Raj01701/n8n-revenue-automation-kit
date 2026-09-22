/**
 * Workflow 02 waits 24 then 48 hours between sends. That is the correct
 * interval and it is also three days per recorded execution, so
 * scripts/make-dunning-demo.mjs imports a copy of that exact file with the two
 * Wait nodes set to 10 seconds and its own webhook path. Everything else in it -
 * the invoice re-check before each send, the branches, the SQL - is unchanged,
 * and the name is long so a screenshot of it cannot be mistaken for the
 * production workflow.
 */
export const DUNNING_DEMO_NAME =
  '02 - Failed Payment Recovery (Dunning) - demo run, waits shortened to 10s';
