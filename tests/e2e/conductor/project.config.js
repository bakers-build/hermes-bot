// @bakers-schema-version 1
// The end-to-end test's project: plain git worktrees and the test's own executor (executor.mjs,
// loaded relative to this file). The seed limits the conductor to working runs.
/** @type {import('@bakers-build/core').ProjectConfig} */
export default {
  schema_version: 1,
  project: { name: 'E2E Project' },
  capture_logs: false,
  addons: ['@bakers-build/addon-workspace-git'],
  executor: { use: './executor.mjs' },
  poll_interval_ms: 2000,
};
