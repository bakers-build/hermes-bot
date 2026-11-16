// @bakers-schema-version 1
// The project's bakers.build configuration — committed and identical for
// everyone. A conductor is this machine (machine.config.js) + this project +
// the variant (project.<name>.config.js). Connections are private files.
//
// The slots are `{ use, export?, with? }` descriptors naming the published
// package; the loader resolves each name (config dir → cwd → CLI install).
// `@bakers-build/addon-herdr` default-exports the executor, so the worktree
// slot names `export: 'herdrWorkspace'`.

/** @type {import('@bakers-build/core').ProjectConfig} */
export default {
  schema_version: 1,
  project: { name: "Hermes Bot" },
  // The run budget (max_parallel) is set on the machine in the backend.
  // Transcripts upload only where the server's run-log storage allows it.
  // Set to false to keep this conductor's transcripts local even then.
  // Metrics are unaffected either way.
  capture_logs: true,
  server: { use: '@bakers-build/addon-remote-drupal' },
  executor: { use: '@bakers-build/addon-herdr' },
  // Agent addons (addon-claude, …) belong to ~/.bakers/machine.config.js.
  addons: [{ use: '@bakers-build/addon-herdr' }],
  worktree: { use: '@bakers-build/addon-herdr', export: 'herdrWorkspace' },
};
