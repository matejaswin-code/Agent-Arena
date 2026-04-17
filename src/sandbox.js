// ─────────────────────────────────────────────────────────────
// src/sandbox.js
// Sandboxed code execution for the runCode tool.
//
// JS  → Node.js vm module (isolated context, no require/import)
// PY  → child_process spawning python3 with a timeout
//
// Both return: { stdout, stderr, exitCode, language }
// ─────────────────────────────────────────────────────────────

import vm from "vm";
import { execFile } from "child_process";
import { promisify } from "util";
import { writeFile, unlink } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { randomBytes } from "crypto";

const execFileAsync = promisify(execFile);

/** Execution timeout ceiling in milliseconds */
const EXEC_TIMEOUT_MS = 8000;

// ── Helpers ───────────────────────────────────────────────────

/**
 * Naively detect the language of a code snippet.
 * Returns 'python' | 'javascript' | 'unknown'
 */
export function detectLanguage(code) {
  const py = /\bdef \w+\(|import \w|print\s*\(|:\s*$|\bself\b/.test(code);
  const js = /\bfunction\b|\bconst\b|\blet\b|\bvar\b|console\.(log|error)|=>/
    .test(code);

  if (py && !js) return "python";
  if (js && !py) return "javascript";
  // If ambiguous, prefer JS since we're in a Node environment
  return js ? "javascript" : "python";
}

// ── JavaScript sandbox (vm module) ───────────────────────────

/**
 * Execute a JS snippet in an isolated vm context.
 * console.log / console.error are captured into stdout/stderr strings.
 * No access to require, import, process, or fs.
 */
export async function runJavaScript(code) {
  const stdoutLines = [];
  const stderrLines = [];

  const sandbox = {
    console: {
      log: (...args) => stdoutLines.push(args.map(String).join(" ")),
      error: (...args) => stderrLines.push(args.map(String).join(" ")),
      warn: (...args) => stderrLines.push("[warn] " + args.map(String).join(" ")),
      info: (...args) => stdoutLines.push(args.map(String).join(" ")),
    },
    Math,
    JSON,
    Date,
    parseInt,
    parseFloat,
    isNaN,
    isFinite,
    Number,
    String,
    Boolean,
    Array,
    Object,
    Error,
  };

  vm.createContext(sandbox);

  try {
    const script = new vm.Script(code, { timeout: EXEC_TIMEOUT_MS });
    const result = script.runInContext(sandbox, { timeout: EXEC_TIMEOUT_MS });

    // If the last expression had a non-undefined value, surface it
    if (result !== undefined && stdoutLines.length === 0) {
      stdoutLines.push(String(result));
    }

    return {
      language: "javascript",
      stdout: stdoutLines.join("\n"),
      stderr: stderrLines.join("\n"),
      exitCode: 0,
    };
  } catch (err) {
    return {
      language: "javascript",
      stdout: stdoutLines.join("\n"),
      stderr: err.message,
      exitCode: 1,
    };
  }
}

// ── Python sandbox (child_process) ───────────────────────────

/**
 * Execute a Python snippet by writing it to a temp file
 * and spawning python3 with a hard wall-clock timeout.
 * Requires python3 in PATH; falls back gracefully if not found.
 */
export async function runPython(code) {
  const tmpFile = join(tmpdir(), `agent_${randomBytes(6).toString("hex")}.py`);

  try {
    await writeFile(tmpFile, code, "utf8");

    const { stdout, stderr } = await execFileAsync("python3", [tmpFile], {
      timeout: EXEC_TIMEOUT_MS,
      maxBuffer: 1024 * 256, // 256 KB
    });

    return {
      language: "python",
      stdout: stdout.trim(),
      stderr: stderr.trim(),
      exitCode: 0,
    };
  } catch (err) {
    // execFile rejects on non-zero exit OR timeout
    const isTimeout = err.killed || err.code === "ETIMEDOUT";
    return {
      language: "python",
      stdout: err.stdout?.trim() ?? "",
      stderr: isTimeout
        ? `Execution timed out after ${EXEC_TIMEOUT_MS}ms`
        : (err.stderr?.trim() ?? err.message),
      exitCode: err.code ?? 1,
    };
  } finally {
    await unlink(tmpFile).catch(() => {}); // best-effort cleanup
  }
}

// ── Unified entry point ───────────────────────────────────────

/**
 * Run a code snippet in the appropriate sandbox.
 * @param {string} code
 * @param {string} [hint] – optional language hint ('js'|'py'|'python'|'javascript')
 * @returns {Promise<{ language, stdout, stderr, exitCode }>}
 */
export async function runCode(code, hint) {
  const normalised = hint?.toLowerCase().replace("javascript", "js") ?? "";
  const lang =
    normalised === "js" || normalised === "javascript"
      ? "javascript"
      : normalised === "py" || normalised === "python"
      ? "python"
      : detectLanguage(code);

  if (lang === "python") return runPython(code);
  return runJavaScript(code);
}
