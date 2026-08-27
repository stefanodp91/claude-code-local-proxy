/**
 * fsSkillRepository.ts — instructions the model loads only when it needs them.
 *
 * A skill is a directory with a `SKILL.md` in it and whatever else it needs:
 * templates, examples, a script. Two places are searched — the workspace's own
 * `.claudio/skills/` and a global directory — and the workspace wins a clash by
 * name, because the project's version is the one under review and the one a
 * colleague gets when they clone it.
 *
 * What every request pays for is the **index**: one line per skill. The body
 * arrives only when the model asks for it, which is the whole design — on these
 * models the context window is the scarce resource, and a skill that is always
 * present is just a longer prompt.
 *
 * A skill's scripts are not run from here. The skill ships the file, the model
 * runs it with the ordinary `bash` or `python` action, and that action passes
 * the approval gate like any other. A private execution path would be a second
 * route with nobody watching it.
 *
 * @module infrastructure/adapters/fsSkillRepository
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";

/** Instructions are injected whole; beyond this they are a document, not a skill. */
const MAX_SKILL_BYTES = 8_000;
/** How much of a skill's own text is used as its index line when it has no front matter. */
const FALLBACK_DESCRIPTION_CHARS = 120;

export interface SkillSummary {
  name: string;
  /** One line, for the index in the prompt. */
  description: string;
  /** Workspace-relative when the skill is the project's, absolute when global. */
  location: string;
}

export interface LoadedSkill extends SkillSummary {
  /** The instructions, front matter removed and capped. */
  body: string;
  /** Everything else in the skill's directory — what the model may read or run. */
  files: string[];
}

export class FsSkillRepository {
  /**
   * @param workspaceRelativeDir Where a project keeps its own skills.
   * @param globalDir            Absolute path to shared skills, or "" for none.
   */
  constructor(
    private readonly workspaceRelativeDir: string,
    private readonly globalDir: string,
  ) {}

  /**
   * Every skill on offer, the workspace's shadowing the global ones by name.
   *
   * Never throws: a missing directory, an unreadable one, a skill without a
   * `SKILL.md` — all of it means "not a skill", because a broken skill must cost
   * itself and not the turn.
   */
  list(workspaceCwd: string): SkillSummary[] {
    const byName = new Map<string, SkillSummary>();

    for (const { dir, location } of this.roots(workspaceCwd)) {
      for (const name of readDirNames(dir)) {
        const body = readSkillFile(join(dir, name));
        if (body === null) continue;
        // Workspace roots come last, so they overwrite.
        byName.set(name, {
          name,
          description: describe(body, name),
          location: `${location}/${name}`,
        });
      }
    }

    return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
  }

  /**
   * One skill's instructions and the files it brought with it.
   *
   * @returns `null` when the name matches nothing, or names something outside
   *          the skills directories — the name comes from the model, and it is
   *          a path segment.
   */
  load(workspaceCwd: string, name: string): LoadedSkill | null {
    if (!name || !isPlainName(name)) return null;

    // Reversed: the workspace is searched first so it wins.
    for (const { dir, location } of [...this.roots(workspaceCwd)].reverse()) {
      const skillDir = join(dir, name);
      const body = readSkillFile(skillDir);
      if (body === null) continue;

      const stripped = stripFrontMatter(body);
      return {
        name,
        description: describe(body, name),
        location: `${location}/${name}`,
        body: stripped.length > MAX_SKILL_BYTES
          ? `${stripped.slice(0, MAX_SKILL_BYTES)}\n\n[skill '${name}' truncated]`
          : stripped,
        files: readDirFiles(skillDir).filter((f) => f !== "SKILL.md"),
      };
    }

    return null;
  }

  /** Global first, workspace second — later roots win a name clash. */
  private roots(workspaceCwd: string): { dir: string; location: string }[] {
    const roots: { dir: string; location: string }[] = [];

    if (this.globalDir) {
      roots.push({ dir: this.globalDir, location: this.globalDir });
    }
    if (this.workspaceRelativeDir) {
      const full = resolve(workspaceCwd, this.workspaceRelativeDir);
      const rel = relative(resolve(workspaceCwd), full);
      // The path is configuration rather than model input, but it is still read
      // from disk on every request; a stray `../` in a config file should not
      // turn the index into a directory listing of somewhere else.
      if (rel !== "" && !rel.startsWith("..") && !isAbsolute(rel)) {
        roots.push({ dir: full, location: this.workspaceRelativeDir });
      }
    }

    return roots;
  }
}

/** A skill name is one path segment: no separators, no climbing. */
function isPlainName(name: string): boolean {
  return !/[\\/]/.test(name) && name !== "." && name !== "..";
}

function readDirNames(dir: string): string[] {
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name);
  } catch {
    return [];
  }
}

function readDirFiles(dir: string): string[] {
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isFile())
      .map((e) => e.name)
      .sort();
  } catch {
    return [];
  }
}

/** The skill's own instructions, or null when this is not a skill directory. */
function readSkillFile(skillDir: string): string | null {
  const file = join(skillDir, "SKILL.md");
  try {
    if (!statSync(file).isFile()) return null;
    return readFileSync(file, "utf-8");
  } catch {
    return null;
  }
}

/**
 * The index line.
 *
 * `description:` in the front matter when there is one; otherwise the first
 * meaningful line of the file, because a skill written without a header must
 * still be findable rather than disappearing from the index in silence.
 */
function describe(body: string, name: string): string {
  const front = frontMatter(body);
  const described = front?.match(/^description:\s*(.+)$/m)?.[1]?.trim();
  if (described) return described;

  const firstLine = stripFrontMatter(body)
    .split("\n")
    .map((l) => l.replace(/^#+\s*/, "").trim())
    .find((l) => l.length > 0);

  return (firstLine ?? name).slice(0, FALLBACK_DESCRIPTION_CHARS);
}

function frontMatter(body: string): string | null {
  const match = body.match(/^---\n([\s\S]*?)\n---\n?/);
  return match ? match[1] : null;
}

function stripFrontMatter(body: string): string {
  return body.replace(/^---\n[\s\S]*?\n---\n?/, "").trim();
}
