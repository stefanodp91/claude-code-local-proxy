/**
 * fsMemoryRepository.test.ts — reading the workspace's memory file.
 *
 * Everything that can go wrong reading a file has to degrade to "no memory",
 * never to a failed request: the memory is an optional enrichment of the system
 * prompt, and a turn that dies because a markdown file was missing would be a
 * strictly worse trade than not having memory at all.
 *
 * @module test/fsMemoryRepository
 */

import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FsMemoryRepository } from "../src/infrastructure/adapters/fsMemoryRepository";

let ws: string;
beforeEach(() => { ws = mkdtempSync(join(tmpdir(), "claudio-memory-")); });
afterEach(() => { rmSync(ws, { recursive: true, force: true }); });

const repo = (rel = ".claudio/MEMORY.md") => new FsMemoryRepository(rel);

function put(rel: string, content: string) {
  const full = join(ws, rel);
  mkdirSync(join(full, ".."), { recursive: true });
  writeFileSync(full, content);
}

test("the memory file is read", () => {
  put(".claudio/MEMORY.md", "The deploy script needs sudo.");
  assert.equal(repo().load(ws), "The deploy script needs sudo.");
});

test("a missing file is no memory, not an error", () => {
  assert.equal(repo().load(ws), null);
});

test("a file with only whitespace counts as empty", () => {
  // Otherwise the prompt gains a memory section containing nothing, which costs
  // tokens and teaches the model that memory exists and is useless.
  put(".claudio/MEMORY.md", "\n\n   \n");
  assert.equal(repo().load(ws), null);
});

test("a directory where the file should be is not a crash", () => {
  mkdirSync(join(ws, ".claudio", "MEMORY.md"), { recursive: true });
  assert.equal(repo().load(ws), null);
});

test("configuring an empty path disables memory entirely", () => {
  put(".claudio/MEMORY.md", "remembered");
  assert.equal(repo("").load(ws), null);
});

test("a very long memory is truncated rather than crowding out the conversation", () => {
  put(".claudio/MEMORY.md", "m".repeat(20_000));
  const out = repo().load(ws)!;

  assert.equal(out.length < 20_000, true);
  assert.match(out, /\[memory truncated\]$/);
});

test("a configured path that climbs out of the workspace reads nothing", () => {
  // The path comes from configuration, not from the model, so this is not a
  // hole an attacker walks through. It is the same containment rule the rest of
  // the proxy uses, applied where a file is read and interpolated into a prompt.
  writeFileSync(join(ws, "..", "outside-memory.md"), "secrets");
  try {
    assert.equal(repo("../outside-memory.md").load(ws), null);
  } finally {
    rmSync(join(ws, "..", "outside-memory.md"), { force: true });
  }
});

test("the configured path is what the prompt is told to write to", () => {
  assert.equal(repo("notes/MEMORY.md").relativePath, "notes/MEMORY.md");
});
