/**
 * lifecycle.ts — the lifecycle rules, reachable from a shell script.
 *
 * `start_agent_cli.sh` cannot import TypeScript, and reimplementing the rules in
 * bash is exactly how the two copies drifted: both killed the proxy by the
 * wrapper's pid, and only one of them was ever fixed. So the script calls this
 * instead, and there is one implementation again.
 *
 * Every command prints one line and exits 0 on success, non-zero on failure, so
 * a shell can use it with `$(...)` and `||`.
 *
 *   node --import tsx src/cli/lifecycle.ts find-port 5678      → 5679
 *   node --import tsx src/cli/lifecycle.ts kill-group 12345    → ok
 *   node --import tsx src/cli/lifecycle.ts wait-health 5679 30 [pid] → ok | gone-or-timeout
 *
 * @module cli/lifecycle
 */

import { findFreePort, killProcessGroup, waitForHealth } from "../infrastructure/lifecycle";

const [command, ...args] = process.argv.slice(2);

async function main(): Promise<number> {
  switch (command) {
    case "find-port": {
      const base = parseInt(args[0] ?? "5678", 10);
      if (!Number.isInteger(base)) {
        console.error("find-port: expected a port number");
        return 2;
      }
      console.log(await findFreePort(base));
      return 0;
    }

    case "kill-group": {
      const pid = parseInt(args[0] ?? "", 10);
      if (!Number.isInteger(pid) || pid <= 1) {
        console.error("kill-group: expected a pid");
        return 2;
      }
      killProcessGroup(pid, (args[1] as NodeJS.Signals) ?? "SIGTERM");
      console.log("ok");
      return 0;
    }

    case "wait-health": {
      const port = parseInt(args[0] ?? "", 10);
      const seconds = parseInt(args[1] ?? "30", 10);
      const pid = parseInt(args[2] ?? "", 10);
      if (!Number.isInteger(port)) {
        console.error("wait-health: expected a port number");
        return 2;
      }
      // With a pid, the wait ends the moment that process dies: a proxy that
      // exited on startup will never answer, and waiting out the deadline for it
      // is thirty seconds of silence with the reason already in the log.
      const isAlive = Number.isInteger(pid)
        ? () => { try { process.kill(pid, 0); return true; } catch { return false; } }
        : undefined;
      const healthy = await waitForHealth(port, seconds * 1_000, isAlive);
      console.log(healthy ? "ok" : "gone-or-timeout");
      return healthy ? 0 : 1;
    }

    default:
      console.error(`unknown command '${command ?? ""}'. Try: find-port | kill-group | wait-health`);
      return 2;
  }
}

main().then((code) => process.exit(code));
