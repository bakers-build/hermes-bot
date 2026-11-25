#!/usr/bin/env bash
# Once per site: points webui/.env at the end-to-end test's bakers.build (tests/e2e/run.sh --keep)
# and registers the web UI's sign-in there.
#
#   webui/register-client.sh
#
# Creates webui/.env from webui/.env.example when it is missing, then writes into it: BAKERS_URL,
# the bot's API key, project and conductor from tests/e2e/out/seed.json, a new OAuth client
# (POST /oauth/register, redirect http://127.0.0.1:8787/oauth2/callback), a cookie secret, and
# HERMES_WEBUI_GROUP_PROFILE_MAP: WEBUI_USERS by bakers.build user ID, which the site's ID token
# carries instead of the e-mail address. Every other value stays. Run it again after changing
# WEBUI_USERS, and after `tests/e2e/run.sh down`: a new site knows no client.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
ENV="$ROOT/webui/.env"
SEED="$ROOT/tests/e2e/out/seed.json"

[ -f "$SEED" ] || { echo "register-client: $SEED is missing: start the site with tests/e2e/run.sh <image> --keep" >&2; exit 1; }
port="$(docker port pm-bot-e2e-nginx-1 80 | head -n1 | sed 's/.*://')"
[ -n "$port" ] || { echo "register-client: the site's nginx (pm-bot-e2e-nginx-1) is not running" >&2; exit 1; }
[ -f "$ENV" ] || { cp "$ROOT/webui/.env.example" "$ENV"; chmod 600 "$ENV"; }

# WEBUI_USERS's e-mail addresses by user ID, from the site.
users="$(sed -n 's/^WEBUI_USERS=//p' "$ENV" | tr -d "'\"")"
ids=""
for entry in ${users//,/ }; do
  uid="$(docker exec pm-bot-e2e-php-1 /var/www/html/vendor/bin/drush user:information --mail="${entry%=*}" --fields=uid --format=string 2>/dev/null || true)"
  [ -n "$uid" ] || { echo "register-client: the site has no user ${entry%=*}" >&2; exit 1; }
  ids="$ids${ids:+,}$uid=${entry##*=}"
done

client="$(curl -fsS -H 'Host: nginx' -H 'Content-Type: application/json' "http://127.0.0.1:$port/oauth/register" \
  -d '{"client_name":"Hermes WebUI (local)","redirect_uris":["http://127.0.0.1:8787/oauth2/callback"],"grant_types":["authorization_code","refresh_token"],"response_types":["code"],"token_endpoint_auth_method":"client_secret_post","scope":"openid profile email"}')"

python3 - "$ENV" "$SEED" "$client" "$ids" <<'PY'
import base64, json, os, re, sys

env_path, seed_path, client, ids = sys.argv[1:]
seed, client = json.load(open(seed_path)), json.loads(client)
values = {
    "BAKERS_URL": "http://nginx",
    "BAKERS_API_KEY": seed["bot_api_key"],
    "PM_BOT_PROJECT": seed["project_uuid"],
    "PM_BOT_CONDUCTOR": seed["conductor_uuid"],
    "OAUTH2_PROXY_CLIENT_ID": client["client_id"],
    "OAUTH2_PROXY_CLIENT_SECRET": client["client_secret"],
    "OAUTH2_PROXY_COOKIE_SECRET": base64.urlsafe_b64encode(os.urandom(32)).decode(),
    "HERMES_WEBUI_GROUP_PROFILE_MAP": "'" + json.dumps(dict(e.split("=", 1) for e in ids.split(",") if e)) + "'",
}
text = open(env_path).read()
for key, value in values.items():
    line = f"{key}={value}"
    text, n = re.subn(rf"^{key}=.*$", lambda _: line, text, flags=re.M)
    if not n:
        text = text.rstrip("\n") + f"\n{line}\n"
open(env_path, "w").write(text)
print(f"register-client: {env_path} points at http://nginx, client {client['client_id']}")
PY
