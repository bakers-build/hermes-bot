"""One Hermes profile per web UI user, from the bot's home that `prepare` rendered.

WEBUI_USERS names each user's e-mail address and profile (`email=profile,…`); the web UI binds a
signed-in user to theirs through HERMES_WEBUI_GROUP_PROFILE_MAP (webui/register-client.sh). Each
profile gets the bot's config, skills and plugin, the env values its config refers to, and its
persona plus the trusted line of a request channel naming that user as the requester, so a ticket
the bot opens from their session names them as the reviewer. Run on every start: the copies follow the
bot's home; sessions and memory stay.
"""
import os
import pathlib
import re
import shutil
import sys

HOME = pathlib.Path(os.environ.get("HERMES_HOME", "/opt/data"))
sys.path.insert(0, str(HOME / "plugins" / "bot-channels"))
from channels import language_prompt  # noqa: E402  the bot's own plugin, as prepare rendered it

PROFILE = re.compile(r"[a-z0-9][a-z0-9_-]{0,63}")  # the web UI's profile names


def trusted_line(profile, email, link, code):
    """The request channel's trusted line (channels.channel_prompt), for a web UI user."""
    return (
        f"This is the request channel webui-{profile}. Its conversation link is {link}. "
        f"Its ticket: none yet. Its requester's e-mail address: {email}. {language_prompt(code)}"
    )


def main():
    users = dict(entry.strip().rsplit("=", 1) for entry in os.environ.get("WEBUI_USERS", "").split(",") if entry.strip())
    link = os.environ.get("WEBUI_URL", "http://127.0.0.1:8787")
    code = os.environ.get("PM_BOT_LANGUAGE") or "de"
    for email, profile in users.items():
        if not PROFILE.fullmatch(profile) or profile == "default" or "@" not in email:
            sys.exit(f"profiles: {email!r} → {profile!r} is no e-mail address and profile name")
        target = HOME / "profiles" / profile
        target.mkdir(parents=True, exist_ok=True)
        config = (HOME / "config.yaml").read_text(encoding="utf-8")
        (target / "config.yaml").write_text(config, encoding="utf-8")
        # A profile resolves the config's ${env:…} references (the bakers API key) from its own
        # .env, not from the process env.
        names = sorted(set(re.findall(r"\$\{env:([A-Z0-9_]+)\}", config)))
        env = target / ".env"
        env.write_text("".join(f"{n}={os.environ.get(n, '')}\n" for n in names), encoding="utf-8")
        env.chmod(0o600)
        for name in ("skills", "plugins"):
            shutil.rmtree(target / name, ignore_errors=True)
            shutil.copytree(HOME / name, target / name, symlinks=True)
        soul = (HOME / "SOUL.md").read_text(encoding="utf-8")
        (target / "SOUL.md").write_text(f"{soul.rstrip()}\n\n{trusted_line(profile, email, link, code)}\n", encoding="utf-8")
        print(f"profiles: {profile} for {email}")


if __name__ == "__main__":
    main()
