/**
 * hooks.ts — trust, inspect and revoke a workspace's hooks.
 *
 * Trusting has to happen outside the conversation. The model can write files,
 * so anything it could reach — a marker in `.claudio/`, an action, a prompt it
 * could talk its way through — would let it trust its own hooks, and the
 * mechanism would be theatre.
 *
 * So it is a command a person runs, and it prints what it is about to trust:
 *
 *   npm run hooks -- status  <workspace>
 *   npm run hooks -- trust   <workspace>
 *   npm run hooks -- revoke  <workspace>
 *
 * @module cli/hooks
 */

import { resolve } from "node:path";
import { loadConfig } from "../infrastructure/config";
import { FsHooksRepository } from "../infrastructure/adapters/fsHooksRepository";

const [command, rawWorkspace] = process.argv.slice(2);

function main(): number {
  const config = loadConfig();
  const repo = new FsHooksRepository(config.hooksFile, config.hooksTrustFile);
  const workspace = resolve(rawWorkspace ?? process.cwd());
  const status = repo.status(workspace);

  switch (command) {
    case "status": {
      if (!status.configured) {
        console.log(`No hooks in ${workspace} (looked for ${config.hooksFile}).`);
        return 0;
      }
      if (status.error) {
        console.error(`Hooks in ${workspace} could not be read: ${status.error}`);
        return 1;
      }
      console.log(`${workspace}\n  file:    ${config.hooksFile}`);
      console.log(`  trusted: ${status.trusted ? "yes" : "no — nothing will run"}`);
      for (const [action, commands] of Object.entries(status.hooks)) {
        for (const c of commands) console.log(`  after ${action}: ${c}`);
      }
      return 0;
    }

    case "trust": {
      if (!status.configured) {
        console.error(`No hooks to trust in ${workspace} (looked for ${config.hooksFile}).`);
        return 1;
      }
      if (status.error) {
        console.error(`Refusing to trust unreadable hooks: ${status.error}`);
        return 1;
      }
      // Printed before trusting, because the point of the whole mechanism is
      // that a person saw what they were agreeing to run without being asked
      // again.
      console.log(`These commands will run without asking, after the matching action:\n`);
      for (const [action, commands] of Object.entries(status.hooks)) {
        for (const c of commands) console.log(`  after ${action}: ${c}`);
      }
      console.log("");
      if (!repo.trust(workspace)) {
        console.error("Could not write the trust record.");
        return 1;
      }
      console.log(`Trusted for ${workspace}. Any change to the file revokes this.`);
      return 0;
    }

    case "revoke": {
      repo.revoke(workspace);
      console.log(`Revoked for ${workspace}. Hooks there are inert until trusted again.`);
      return 0;
    }

    default:
      console.error("usage: npm run hooks -- status|trust|revoke [workspace]");
      return 2;
  }
}

process.exit(main());
