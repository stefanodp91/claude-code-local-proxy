/**
 * pythonExecutor.ts — Python execution service for the proxy.
 *
 * Manages a per-workspace Python virtual environment and executes Python
 * code snippets on behalf of the LLM agent loop or the chat UI's "Run"
 * button (POST /v1/exec-python).
 *
 * Design mirrors the bash workspace action:
 *  - The caller is responsible for requesting user approval before calling
 *    executePythonCode() when invoked from the agent loop.
 *  - The /v1/exec-python endpoint (manual "Run" button) skips the approval
 *    gate because the user explicitly clicked Run.
 *
 * Venv location: <workspaceCwd>/<venvRelDir>  (default: .claudio/python-venv)
 * Each workspace gets its own isolated venv; packages installed for one
 * project do not bleed into others.
 *
 * @module infrastructure/pythonExecutor
 */

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, writeFile, readFile, unlink } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";

// ─────────────────────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────────────────────

/** Timeout for Python code execution (ms). */
const EXEC_TIMEOUT_MS = 30_000;
/** Timeout for venv creation (ms). */
const VENV_CREATE_TIMEOUT_MS = 60_000;
/** Timeout for pip install (ms). */
const PIP_INSTALL_TIMEOUT_MS = 120_000;
/** Timeout for module availability check (ms). */
const MODULE_CHECK_TIMEOUT_MS = 10_000;

/** Python binaries to try when searching for a system Python. */
const PYTHON_CANDIDATES = [
  "python3",
  "python",
  "/usr/bin/python3",
  "/opt/homebrew/bin/python3",
  "/usr/local/bin/python3",
  "/opt/local/bin/python3",
];

/** Pre-installed packages added to every new venv. */
const PREINSTALLED_PACKAGES = ["matplotlib", "numpy", "pandas", "scipy"];

/** PyPI package name when the import name differs from the package name. */
const IMPORT_TO_PACKAGE: Record<string, string> = {
  PIL:      "Pillow",
  cv2:      "opencv-python",
  sklearn:  "scikit-learn",
  bs4:      "beautifulsoup4",
  yaml:     "PyYAML",
  dotenv:   "python-dotenv",
  attr:     "attrs",
  jwt:      "PyJWT",
  dateutil: "python-dateutil",
  Crypto:   "pycryptodome",
  google:   "google-cloud",
  wx:       "wxPython",
};

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

export type PythonProgressPhase = "creating_env" | "installing_packages" | "executing";

export type PythonResult =
  | { type: "text";  data: string }
  | { type: "image"; data: string }   // base64-encoded PNG
  | { type: "error"; data: string };

// ─────────────────────────────────────────────────────────────────────────────
// Private helpers
// ─────────────────────────────────────────────────────────────────────────────

/** Remove ANSI/VT100 escape codes from a string. */
const stripAnsi = (s: string): string => s.replace(/\x1B\[[0-9;]*[A-Za-z]/g, "");

/** Run a child process and collect its stdout/stderr. */
async function runPyProcess(
  cmd: string,
  args: string[],
  timeoutMs = EXEC_TIMEOUT_MS,
  cwd?: string,
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    const proc = spawn(cmd, args, { timeout: timeoutMs, cwd });
    proc.stdout.on("data", (d: Buffer) => (stdout += d.toString()));
    proc.stderr.on("data", (d: Buffer) => (stderr += d.toString()));
    proc.on("close", () => resolve({ stdout, stderr }));
    proc.on("error", (e) => resolve({ stdout, stderr: e.message }));
  });
}

/** Find the first available Python binary on the system. */
async function findSystemPython(): Promise<string | null> {
  for (const cmd of PYTHON_CANDIDATES) {
    const found = await new Promise<boolean>((resolve) => {
      const p = spawn(cmd, ["--version"]);
      p.on("close", (code) => resolve(code === 0));
      p.on("error", () => resolve(false));
    });
    if (found) return cmd;
  }
  return null;
}

/** Parse top-level import module names from Python source code. */
function extractImports(code: string): string[] {
  const modules = new Set<string>();
  for (const m of code.matchAll(/^\s*import\s+([\w.]+)/gm))
    modules.add(m[1].split(".")[0]);
  for (const m of code.matchAll(/^\s*from\s+([\w.]+)\s+import/gm))
    modules.add(m[1].split(".")[0]);
  return [...modules];
}

/** Return the subset of `modules` that are not importable in the given Python. */
async function findMissingModules(python: string, modules: string[]): Promise<string[]> {
  if (modules.length === 0) return [];
  const check = [
    "import importlib.util",
    `modules = ${JSON.stringify(modules)}`,
    "missing = [m for m in modules if importlib.util.find_spec(m) is None]",
    'print("\\n".join(missing))',
  ].join("\n");
  const { stdout } = await runPyProcess(python, ["-c", check], MODULE_CHECK_TIMEOUT_MS);
  return stdout.trim() ? stdout.trim().split("\n") : [];
}

// ─────────────────────────────────────────────────────────────────────────────
// Public API
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Ensure a Python virtual environment exists at `<workspaceCwd>/<venvRelDir>`.
 * Creates it (and installs base packages) on first call; subsequent calls
 * return immediately if the venv binary already exists.
 *
 * @returns Path to the Python binary inside the venv, or null if Python is
 *          not available on the system.
 */
export async function ensureVenv(
  workspaceCwd: string,
  venvRelDir: string,
  onProgress?: (phase: PythonProgressPhase) => void,
): Promise<string | null> {
  const isWin = process.platform === "win32";
  const venvPath = join(workspaceCwd, venvRelDir);
  const venvBin = join(venvPath, isWin ? "Scripts" : "bin", isWin ? "python.exe" : "python");

  if (existsSync(venvBin)) return venvBin;

  const sysPy = await findSystemPython();
  if (!sysPy) return null;

  try {
    await mkdir(venvPath, { recursive: true });
    onProgress?.("creating_env");
    await runPyProcess(sysPy, ["-m", "venv", venvPath], VENV_CREATE_TIMEOUT_MS);
    onProgress?.("installing_packages");
    await runPyProcess(
      venvBin,
      ["-m", "pip", "install", "--quiet", ...PREINSTALLED_PACKAGES],
      PIP_INSTALL_TIMEOUT_MS,
    );
    return venvBin;
  } catch {
    // Venv creation failed — fall back to system Python so execution can still proceed
    return sysPy;
  }
}

/**
 * Execute a Python code snippet and return the result.
 *
 * Handles:
 *  - Automatic venv creation on first use
 *  - Missing-module detection and pip-install
 *  - `plt.show()` interception → saves plot as a PNG and returns it as base64
 *
 * @param code         - Python source code to execute
 * @param workspaceCwd - Absolute path to the workspace root (venv lives here)
 * @param venvRelDir   - Relative path from workspaceCwd to the venv dir
 * @param onProgress   - Callback for progress events (creating_env,
 *                       installing_packages, executing)
 */
export async function executePythonCode(
  code: string,
  workspaceCwd: string,
  venvRelDir: string,
  onProgress: (phase: PythonProgressPhase) => void,
): Promise<PythonResult> {
  const python = await ensureVenv(workspaceCwd, venvRelDir, onProgress);
  if (!python) {
    return { type: "error", data: "Python not found. Install Python 3 and try again." };
  }

  const missing = await findMissingModules(python, extractImports(code));
  if (missing.length > 0) {
    onProgress("installing_packages");
    await runPyProcess(
      python,
      ["-m", "pip", "install", "--quiet", ...missing.map((m) => IMPORT_TO_PACKAGE[m] ?? m)],
      PIP_INSTALL_TIMEOUT_MS,
    );
  }

  onProgress("executing");

  const id = randomUUID();
  const tmp = tmpdir();
  const pyFile = join(tmp, `claudio_${id}.py`);
  const imgFile = join(tmp, `claudio_${id}.png`);

  // Intercept plt.show() to save the figure as a PNG instead of opening a window.
  const hasPlot = code.includes("plt.");
  let modified = code.replace(
    /plt\.show\(\s*\)/g,
    `plt.savefig(r'${imgFile}', dpi=100, bbox_inches='tight'); plt.close()`,
  );
  if (hasPlot && !code.includes("plt.show()")) {
    modified +=
      `\ntry:\n  import matplotlib.pyplot as _plt\n  _plt.savefig(r'${imgFile}', dpi=100, bbox_inches='tight'); _plt.close()\nexcept Exception:\n  pass\n`;
  }

  try {
    await writeFile(pyFile, modified, "utf-8");
    const { stdout, stderr } = await runPyProcess(python, [pyFile], EXEC_TIMEOUT_MS, tmp);

    try {
      const imgData = await readFile(imgFile);
      await unlink(imgFile).catch(() => undefined);
      return { type: "image", data: imgData.toString("base64") };
    } catch {
      // No image — return text output
      const cleanOut = stripAnsi(stdout.trim());
      const cleanErr = stripAnsi(stderr.trim());
      if (cleanErr && !cleanOut) {
        return { type: "error", data: cleanErr };
      }
      return { type: "text", data: cleanOut || "(no output)" };
    }
  } finally {
    await unlink(pyFile).catch(() => undefined);
  }
}
