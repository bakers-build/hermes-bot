#!/bin/sh
# The conductor container's start: log in as the seeded conductor owner once per seed (the login
# stays in $HOME, which run.sh mounts) and pin the seeded machine; then run the conductor in the
# foreground, adopting the seeded conductor record.
set -eu
seed="$HOME/seed.json"
value() { node -p "require('$seed').$1"; }
export BAKERS_HOME="$HOME/.bakers" BAKERS_CLIENT_SECRET="$(value owner_client_secret)"
# Claude Code's model key in the ddev stack, which run.sh ddev-seed writes here.
if [ -f "$HOME/model.env" ]; then set -a; . "$HOME/model.env"; set +a; fi
cd /work/checkout
# Each seed issues a new key: a login with an older one starts over.
if [ "$(cat "$HOME/client-id" 2>/dev/null)" != "$(value owner_client_id)" ]; then
  rm -rf "$BAKERS_HOME"
  value owner_client_id >"$HOME/client-id"
fi
if [ ! -f "$BAKERS_HOME/connections/default.js" ]; then
  bakers init --scope all --yes --label e2e-machine --auth-type client_credentials \
    --client-id "$(value owner_client_id)" --secret-env BAKERS_CLIENT_SECRET --base-url "$BAKERS_URL"
  bakers auth login
  # init --scope project writes its own project.config.js; the test's stays.
  cp .bakers/project.config.js /tmp/project.config.js
  bakers init --scope project --yes --project "$(value project_name)" --workspace-id "$(value workspace_uuid)" --path . || true
  cp /tmp/project.config.js .bakers/project.config.js
  # The seeded conductor is adopted by its machine; the agent addon runs `claude`.
  node - "$BAKERS_HOME/machine.config.js" "$(value machine_id)" <<'NODE'
const fs = require('node:fs');
const [file, machine] = process.argv.slice(2);
let text = fs.readFileSync(file, 'utf8').replace(/machine_id: *"[^"]*"/, `machine_id: "${machine}"`);
if (!text.includes('addon-claude')) text = text.replace(/(\n\s*label:[^\n]*\n)/, `$1  addons: ["@bakers-build/addon-claude"],\n`);
fs.writeFileSync(file, text);
NODE
fi
# Claude Code takes the checkout's settings (the allowed bakers tools) only in a trusted project.
node - "$HOME/.claude.json" <<'NODE'
const fs = require('node:fs');
const file = process.argv[2];
let state = {};
try { state = JSON.parse(fs.readFileSync(file, 'utf8')); } catch {}
state.hasCompletedOnboarding = true;
state.projects ??= {};
state.projects['/work/checkout'] = { ...state.projects['/work/checkout'], hasTrustDialogAccepted: true };
fs.writeFileSync(file, JSON.stringify(state, null, 2), { mode: 0o600 });
NODE
exec bakers conductor start --foreground --adopt "$(value conductor_uuid)"
