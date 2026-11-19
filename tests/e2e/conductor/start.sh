#!/bin/sh
# The conductor container's start: on the first start, log in as the seeded conductor owner (the
# login stays in $HOME, which run.sh mounts) and pin the seeded machine; then run the conductor in
# the foreground, adopting the seeded conductor record.
set -eu
seed="$HOME/seed.json"
value() { node -p "require('$seed').$1"; }
export BAKERS_HOME="$HOME/.bakers" BAKERS_CLIENT_SECRET="$(value owner_client_secret)"
cd /work/checkout
if [ ! -f "$BAKERS_HOME/connections/default.js" ]; then
  bakers init --scope all --yes --label e2e-machine --auth-type client_credentials \
    --client-id "$(value owner_client_id)" --secret-env BAKERS_CLIENT_SECRET --base-url http://nginx
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
exec bakers conductor start --foreground --adopt "$(value conductor_uuid)"
