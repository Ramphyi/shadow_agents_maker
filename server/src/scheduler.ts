import { Cron } from 'croner';
import type { Core } from './core.ts';
import { errMsg } from './util.ts';

/** Keeps one cron job per enabled scheduled function of every active agent. */
export class Scheduler {
  private core: Core;
  private jobs = new Map<string, Cron>();
  private started = false;

  constructor(core: Core) { this.core = core; }

  start() { this.started = true; this.sync(); }

  stop() {
    for (const job of this.jobs.values()) job.stop();
    this.jobs.clear();
    this.started = false;
  }

  static validate(expr: string): string | null {
    try {
      new Cron(expr, { paused: true }).stop();
      return null;
    } catch (e) {
      return errMsg(e);
    }
  }

  /** Rebuild jobs from the database. Called after anything that changes agents or functions. */
  sync() {
    if (!this.started) return;
    for (const job of this.jobs.values()) job.stop();
    this.jobs.clear();
    const active = new Set(this.core.store.agents().filter((a) => a.status === 'active').map((a) => a.id));
    for (const fn of this.core.store.functions()) {
      if (fn.kind !== 'schedule' || !fn.enabled || !fn.cron || !active.has(fn.agentId)) continue;
      try {
        // protect: skip a tick while the previous run of the same function is still going.
        const job = new Cron(fn.cron, { protect: true }, async () => {
          await this.core.runtime.run(fn.agentId, { trigger: 'schedule', input: fn.prompt, functionId: fn.id }).catch(() => {});
        });
        this.jobs.set(fn.id, job);
      } catch {
        // An invalid expression is rejected when it is saved; one that slipped in must not stop the others.
      }
    }
  }

  nextRun(fnId: string): number | null {
    return this.jobs.get(fnId)?.nextRun()?.getTime() ?? null;
  }
}
