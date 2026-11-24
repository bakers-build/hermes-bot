// The end-to-end test's bakers.build executor: starts a run's launch command with `sh -c` in its
// worktree, detached, output to $E2E_LOG_DIR/runs/<run id>.log, and kills it when the conductor
// stops or cleans up the run. No terminal multiplexer. The project config loads it as its executor.
// A script of the test (/e2e/agent/<identifier>.json) with `"launch": "fails"` makes the run's launch
// fail once, as a broken setup does: the conductor then marks the run failed.
import { spawn } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, openSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const LOG_DIR = process.env.E2E_LOG_DIR || '/e2e/log';
const RUN_DIR = join(LOG_DIR, 'runs');

function note(event, data) {
  try {
    mkdirSync(LOG_DIR, { recursive: true });
    appendFileSync(
      join(LOG_DIR, 'executor.jsonl'),
      `${JSON.stringify({ at: new Date().toISOString(), event, ...data })}\n`,
    );
  } catch {}
}

function kill(child, why) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  note('kill', { pid: child.pid, why });
  try {
    process.kill(-child.pid, 'SIGTERM');
  } catch {
    try {
      child.kill('SIGTERM');
    } catch {}
  }
}

class E2eExecutor {
  id = 'e2e';
  /** branch -> Map(runId -> child) */
  byBranch = new Map();

  capabilities() {
    // persistent: true so the conductor calls stopRun/cleanupRun at finalise.
    return { persistent: true };
  }

  async startRun(input) {
    const { ticket, run, workspacePath, command, env } = input;
    const script = `/e2e/agent/${ticket.identifier}.json`;
    if (existsSync(script) && JSON.parse(readFileSync(script, 'utf8')).launch === 'fails') {
      renameSync(script, `${script}.launch-failed`);
      note('refuse', { ticket: ticket.identifier, run: run.uuid });
      throw new Error(`the end-to-end test fails the launch of ${ticket.identifier}`);
    }
    mkdirSync(RUN_DIR, { recursive: true });
    const logFile = join(RUN_DIR, `${run.id}.log`);
    const fd = openSync(logFile, 'a');
    const child = spawn('sh', ['-c', command ?? 'true'], {
      cwd: workspacePath,
      env: { ...process.env, ...(env ?? {}) },
      detached: true,
      stdio: ['ignore', fd, fd],
    });
    child.unref();
    const runs = this.byBranch.get(ticket.branchName) ?? new Map();
    runs.set(run.id, child);
    this.byBranch.set(ticket.branchName, runs);
    writeFileSync(join(RUN_DIR, `${run.id}.pid`), String(child.pid));
    note('start', {
      ticket: ticket.identifier,
      branch: ticket.branchName,
      state: ticket.state,
      run: run.uuid,
      runId: run.id,
      pid: child.pid,
      workspacePath,
      command,
      envKeys: Object.keys(env ?? {}),
    });
    child.on('exit', (code, signal) => {
      note('exit', { ticket: ticket.identifier, run: run.uuid, runId: run.id, code, signal });
      writeFileSync(join(RUN_DIR, `${run.id}.exit`), String(code ?? signal));
    });
    return { sessionRef: `${ticket.branchName}#${run.id}` };
  }

  async stopRun(branch) {
    note('stopRun', { branch });
    for (const child of this.byBranch.get(branch)?.values() ?? []) kill(child, 'stopRun');
  }

  async cleanupRun(branch, runId) {
    note('cleanupRun', { branch, runId });
    const runs = this.byBranch.get(branch);
    const child = runs?.get(runId);
    if (child) {
      kill(child, 'cleanupRun');
      runs.delete(runId);
    }
  }
}

export default function e2eExecutor(_options = {}) {
  const executor = new E2eExecutor();
  return {
    kind: 'executor',
    id: 'e2e',
    requiredModules: [],
    async createExecutor(_config, _deps) {
      return executor;
    },
  };
}
