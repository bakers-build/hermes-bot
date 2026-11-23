# The end-to-end test's conductor: the bakers.build CLI, whose package ships every addon it uses,
# in a plain container. No Docker, no terminal multiplexer: executor.mjs starts each run's launch
# command as a process. The agent is `claude` on PATH: the stub (claude-stub.mjs), or Claude Code
# with AGENT=claude (tests/e2e/run.sh --real).
FROM node:22
ARG AGENT=stub
RUN npm i -g @bakers-build/bakers@0.11.0 \
 && if [ "$AGENT" = claude ]; then npm i -g @anthropic-ai/claude-code; fi \
 && bakers --version
COPY claude-stub.mjs /e2e/stub/claude
RUN chmod 755 /e2e/stub/claude \
 && if [ "$AGENT" = stub ]; then ln -s /e2e/stub/claude /usr/local/bin/claude; fi
# The project checkout the conductor works in: run worktrees branch off its HEAD; no remote needed.
COPY project.config.js executor.mjs /work/checkout/.bakers/
COPY WORKFLOW.md /work/checkout/
# The project's entry skill, which WORKFLOW.md names and Claude Code finds in the run's worktree,
# and its settings: a run has no one to approve a tool, so the bakers tools are allowed outright.
COPY skills/ /work/checkout/.claude/skills/
COPY claude-settings.json /work/checkout/.claude/settings.json
# The conductor runs as the host's user (compose.yaml), so the files it leaves in tests/e2e/out are
# the user's: the checkout is writable and trusted by anyone.
RUN git config --system user.email conductor@e2e.test && git config --system user.name conductor \
 && git config --system --add safe.directory '*' \
 && cd /work/checkout && git init -q -b main \
 && printf '.bakers-worktrees/\n.bakers/log.txt\n.bakers/*.local.*\n' >.gitignore \
 && git add -A && git commit -qm 'The end-to-end test project' \
 && chmod -R a+rwX /work/checkout
COPY start.sh /e2e/start.sh
WORKDIR /work/checkout
ENTRYPOINT ["sh", "/e2e/start.sh"]
