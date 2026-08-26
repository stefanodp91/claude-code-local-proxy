/**
 * i18n.test.ts — Guards the translation layer against silent failures.
 *
 * `t()` looks keys up in a FLAT `Record<string, string>` and, when a key is
 * missing, returns the key itself rather than throwing (see domain/i18n.ts).
 * That is a deliberate choice — a missing translation stays visible instead of
 * crashing the proxy — but it means a typo or a wrongly-shaped locale file
 * reaches the user as a raw key like `tools.unsupportedByModel` in place of an
 * error message, and nothing upstream notices.
 *
 * TypeScript cannot catch this: locale files are read with `JSON.parse`, whose
 * return type is `any`, so a nested object type-checks exactly like a flat map.
 * These tests are the only thing standing between that mistake and production.
 *
 * @module test/i18n
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const PROXY_ROOT = fileURLToPath(new URL("..", import.meta.url));
const SRC_DIR = join(PROXY_ROOT, "src");
const LOCALES_DIR = join(PROXY_ROOT, "locales");

/**
 * Matches `t("some.key"` — including calls split across lines.
 *
 * The negative lookbehind is what keeps this honest: without it the pattern
 * also fires on the tail of `split("…")`, `.at("…")`, `format("…")` and any
 * other identifier ending in `t`.
 */
const T_CALL = /(?<![A-Za-z0-9_$.])t\(\s*"([^"\\]+)"/g;

/** Every `.ts` file under src/, as absolute paths. */
function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...sourceFiles(full));
    else if (entry.name.endsWith(".ts")) out.push(full);
  }
  return out;
}

/** Translation keys referenced from source, mapped to where they appear. */
function referencedKeys(): Map<string, string[]> {
  const keys = new Map<string, string[]>();
  for (const file of sourceFiles(SRC_DIR)) {
    const text = readFileSync(file, "utf8");
    for (const match of text.matchAll(T_CALL)) {
      const where = relative(PROXY_ROOT, file);
      const seen = keys.get(match[1]);
      if (seen) seen.push(where);
      else keys.set(match[1], [where]);
    }
  }
  return keys;
}

/** Every locale file, as `[filename, parsed]` pairs. */
function locales(): [string, Record<string, unknown>][] {
  return readdirSync(LOCALES_DIR)
    .filter((f) => f.endsWith(".json"))
    .map((f) => [f, JSON.parse(readFileSync(join(LOCALES_DIR, f), "utf8"))]);
}

test("the extractor recognises a t() call and rejects lookalikes", () => {
  const sample = `
    t("real.key");
    t(
      "multiline.key",
      { n: 1 },
    );
    "x".split("not.a.key");
    messages.at("also.not.a.key");
    formatWithUnit("nope");
  `;
  const found = [...sample.matchAll(T_CALL)].map((m) => m[1]);
  assert.deepEqual(found, ["real.key", "multiline.key"]);
});

test("every locale file is a flat map of strings", () => {
  for (const [name, parsed] of locales()) {
    for (const [key, value] of Object.entries(parsed)) {
      assert.equal(
        typeof value,
        "string",
        `${name}: key "${key}" is ${
          Array.isArray(value) ? "an array" : typeof value
        }, but t() reads a flat Record<string, string>. A nested object here ` +
          `does not throw — it makes t("${key}.something") return the raw key ` +
          `as the user-facing message.`,
      );
    }
  }
});

test("at least one locale file exists", () => {
  assert.ok(locales().length > 0, "no locale files found in locales/");
});

test("every key referenced by t() exists in every locale", () => {
  const referenced = referencedKeys();
  assert.ok(referenced.size > 0, "extractor found no t() calls — check T_CALL");

  for (const [name, parsed] of locales()) {
    const missing = [...referenced.entries()]
      .filter(([key]) => !(key in parsed))
      .map(([key, files]) => `  "${key}"  (used in ${files.join(", ")})`);

    assert.equal(
      missing.length,
      0,
      `${name} is missing ${missing.length} key(s) referenced from src/. ` +
        `Each would surface to the user as the raw key string:\n${missing.join("\n")}`,
    );
  }
});

test("every locale file defines the same key set", () => {
  const all = locales();
  if (all.length < 2) return; // nothing to compare against yet

  const [refName, refParsed] = all[0];
  const refKeys = new Set(Object.keys(refParsed));

  for (const [name, parsed] of all.slice(1)) {
    const keys = new Set(Object.keys(parsed));
    const absent = [...refKeys].filter((k) => !keys.has(k));
    const extra = [...keys].filter((k) => !refKeys.has(k));
    assert.deepEqual(
      { absent, extra },
      { absent: [], extra: [] },
      `${name} has drifted from ${refName}`,
    );
  }
});
