// ─────────────────────────────────────────────────────────────
// src/scoreboard.js
//
// WHAT THIS FILE DOES:
//   Tracks how well each AI model performs at different types
//   of tasks, using a rating system called "Elo" (the same
//   system used in chess rankings!).
//
// ELO SYSTEM EXPLAINED (very simply):
//   - Every model starts with a score (around 1200-1280)
//   - When a model gives a good response → score goes UP
//   - When a model gives a bad response → score goes DOWN
//   - The more unexpected a win/loss, the bigger the change
//   - A weak model beating a strong model gains more points
//     than a strong model beating a weak model
//
// SAME-MODEL GUARD:
//   If a model is compared against itself (e.g., after a
//   refiner or reviewer pass on the same model), no Elo
//   change is applied to avoid artificial inflation.
//
// MODEL DEDUPLICATION:
//   Model names are normalised before storage so variants
//   like "gpt-4o" and "openai/gpt-4o" resolve to one entry.
//   The :free suffix used by OpenRouter is stripped for scoring
//   but retained in display.
//
// DATA SAVED TO:
//   ./data/scoreboard.json  - Current scores for each model
//   ./data/failure_log.json - Log of every failure (for debugging)
//
// HOW IT'S USED:
//   - agent.js calls recordWin()  after good responses
//   - agent.js calls recordLoss() after failed responses
//   - server.js calls getBestModel() to route to the
//     currently best-performing model for a task type
//   - server.js calls getSummary() / getModelOverview() for UI
// ─────────────────────────────────────────────────────────────

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);

const DATA_DIR          = path.join(__dirname, "..", "data");
const SCOREBOARD_FILE   = path.join(DATA_DIR, "scoreboard.json");
const FAILURE_LOG_FILE  = path.join(DATA_DIR, "failure_log.json");

// ── Elo configuration ─────────────────────────────────────────
const K_FACTOR          = 32;   // Points at stake per match (higher = bigger swings)
const MIN_MATCHES_RANK  = 3;    // Minimum matches needed to appear in getBestModel()
const SELF_MATCH_GUARD  = true; // If true, self-comparisons never change scores

// ── Pre-seeded starting scores ────────────────────────────────
// These come from public AI benchmark data so we start with
// reasonable estimates rather than treating all models equally.
//
// Keys are NORMALISED model names (see _normalise() below).
const INITIAL_SCORES = {
  "gpt-4o":                      { code: 1280, creative: 1260, math: 1260, qa: 1260, summarization: 1270 },
  "claude-opus-4-5":             { code: 1280, creative: 1240, qa: 1250, summarization: 1260, math: 1240 },
  "claude-sonnet-4-5":           { code: 1260, creative: 1240, qa: 1245, summarization: 1255, math: 1235 },
  "gemini-pro":                  { math: 1260, summarization: 1250, qa: 1240, code: 1240 },
  "llama-3.1-8b-instant":        { qa: 1240, code: 1230, creative: 1220, math: 1220 },
  "llama-3.1-8b-instruct":       { qa: 1230, code: 1220, creative: 1210, math: 1210 },
  "llama-3-8b-instruct":         { qa: 1220, code: 1215, creative: 1205, math: 1205 },
  "gemma-4-26b-a4b-it":          { code: 1240, math: 1230, qa: 1235, summarization: 1235 },
  "qwen2.5-3b-instruct":         { code: 1200, math: 1200, creative: 1200, qa: 1200 },
  "nemotron-3-super-120b-a12b":  { code: 1260, math: 1250, qa: 1255, summarization: 1255 },
};

const DEFAULT_SCORE = 1200;

// ── Normalisation helpers ─────────────────────────────────────

/**
 * Normalise a model name for consistent storage.
 *
 * Rules applied in order:
 *   1. Lowercase
 *   2. Strip the ":free" OpenRouter suffix
 *   3. Strip any leading "provider/" prefix  (e.g. "google/gemma-4" → "gemma-4")
 *
 * The original (raw) string is kept in a separate display map so
 * the UI can still show the full name.
 *
 * @param  {string} rawName
 * @returns {{ canonical: string, display: string }}
 */
function normaliseModel(rawName) {
  if (!rawName || typeof rawName !== "string") {
    return { canonical: "unknown", display: "unknown" };
  }

  const display   = rawName.trim();
  let   canonical = display.toLowerCase();

  // Strip :free (and similar OpenRouter tier suffixes)
  canonical = canonical.replace(/:free$|:nitro$|:turbo$|:extended$/i, "");

  // Strip provider prefix (everything before the first "/")
  const slashIdx = canonical.indexOf("/");
  if (slashIdx !== -1) {
    canonical = canonical.slice(slashIdx + 1);
  }

  return { canonical, display };
}

/**
 * Return true when two normalised model names refer to the same model.
 * Used to skip Elo changes for self-comparisons.
 *
 * @param {string} a
 * @param {string} b
 * @returns {boolean}
 */
function isSameModel(a, b) {
  const { canonical: ca } = normaliseModel(a);
  const { canonical: cb } = normaliseModel(b);
  return ca === cb;
}

// ── Disk helpers ──────────────────────────────────────────────
function ensureDataDir() {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }
}

// ── Main class ─────────────────────────────────────────────────
export class Scoreboard {
  constructor() {
    // scores[canonicalName][taskType] = { score, wins, losses, displayName }
    this.scores = {};

    // Array of failure records
    this.failureLog = [];

    // Map from canonical → latest display name (for the UI)
    this._displayNames = {};

    this._loadFromDisk();
  }

  // ── Private: disk operations ──────────────────────────────

  _loadFromDisk() {
    try {
      if (fs.existsSync(SCOREBOARD_FILE)) {
        this.scores = JSON.parse(fs.readFileSync(SCOREBOARD_FILE, "utf8"));
        // Rebuild display-name map from stored data
        Object.entries(this.scores).forEach(([canonical, tasks]) => {
          const firstTask = Object.values(tasks)[0];
          if (firstTask?.displayName) {
            this._displayNames[canonical] = firstTask.displayName;
          }
        });
        console.log("[Scoreboard] Loaded existing scores from disk.");
      }

      if (fs.existsSync(FAILURE_LOG_FILE)) {
        this.failureLog = JSON.parse(fs.readFileSync(FAILURE_LOG_FILE, "utf8"));
        console.log(`[Scoreboard] Loaded ${this.failureLog.length} failure log entries.`);
      }
    } catch (err) {
      console.warn("[Scoreboard] Could not load data files:", err.message);
    }
  }

  _saveToDisk() {
    try {
      ensureDataDir();
      fs.writeFileSync(SCOREBOARD_FILE, JSON.stringify(this.scores, null, 2), "utf8");
      fs.writeFileSync(FAILURE_LOG_FILE, JSON.stringify(this.failureLog, null, 2), "utf8");
    } catch (err) {
      console.warn("[Scoreboard] Could not save data files:", err.message);
    }
  }

  // ── Private: entry management ─────────────────────────────

  /**
   * Get or create the score entry for a canonical model + taskType.
   * Also keeps the display name up-to-date.
   */
  _getEntry(canonical, taskType, displayName) {
    if (!this.scores[canonical]) {
      this.scores[canonical] = {};
    }

    if (!this.scores[canonical][taskType]) {
      const startingScore =
        INITIAL_SCORES[canonical]?.[taskType] ?? DEFAULT_SCORE;

      this.scores[canonical][taskType] = {
        score:       startingScore,
        wins:        0,
        losses:      0,
        displayName: displayName || canonical,
      };
    }

    // Always refresh the display name in case a richer version comes in
    if (displayName) {
      this.scores[canonical][taskType].displayName = displayName;
      this._displayNames[canonical] = displayName;
    }

    return this.scores[canonical][taskType];
  }

  // ── Private: Elo math ─────────────────────────────────────

  /**
   * Standard Elo expected-score formula.
   * Returns the probability that winnerScore beats loserScore.
   */
  _expectedScore(winnerScore, loserScore) {
    return 1 / (1 + Math.pow(10, (loserScore - winnerScore) / 400));
  }

  /**
   * Average score across all tracked models for a given task type.
   * Excludes the model being updated to avoid circular dependency.
   *
   * @param {string} taskType
   * @param {string} [excludeCanonical] - Model to skip when averaging
   * @returns {number}
   */
  _getAverageScore(taskType, excludeCanonical = null) {
    const allScores = Object.entries(this.scores)
      .filter(([name]) => name !== excludeCanonical)
      .map(([, modelData]) => modelData[taskType]?.score)
      .filter((s) => s !== undefined && s !== null);

    if (allScores.length === 0) return DEFAULT_SCORE;

    return allScores.reduce((sum, s) => sum + s, 0) / allScores.length;
  }

  // ── Public API ────────────────────────────────────────────

  /**
   * Record a WIN for a model on a specific task type.
   *
   * @param {string} model      - Raw model name (e.g. "google/gemma-4-26b-a4b-it:free")
   * @param {string} taskType   - Task category (e.g. "code", "math")
   * @param {string} [opponent] - Optional opponent model (enables direct Elo comparison)
   */
  recordWin(model, taskType, opponent = null) {
    const { canonical, display } = normaliseModel(model);

    // ── Self-match guard ──────────────────────────────────
    if (SELF_MATCH_GUARD && opponent && isSameModel(model, opponent)) {
      console.log(
        `[Scoreboard] ⏭  Skipped self-match: ${display} vs ${opponent} on ${taskType}`
      );
      return;
    }

    const entry = this._getEntry(canonical, taskType, display);

    // Use opponent's score as the "loser" baseline when available
    const opponentCanonical = opponent ? normaliseModel(opponent).canonical : null;
    const opponentScore = opponentCanonical && this.scores[opponentCanonical]?.[taskType]?.score
      ? this.scores[opponentCanonical][taskType].score
      : this._getAverageScore(taskType, canonical);

    const expected   = this._expectedScore(entry.score, opponentScore);
    const scoreGain  = K_FACTOR * (1 - expected);
    const prevScore  = entry.score;

    entry.score += scoreGain;
    entry.wins  += 1;

    console.log(
      `[Scoreboard] ✅ WIN: ${display} / ${taskType} ` +
      `| ${prevScore.toFixed(0)} → ${entry.score.toFixed(0)} (+${scoreGain.toFixed(1)})`
    );

    this._saveToDisk();
  }

  /**
   * Record a LOSS for a model on a specific task type.
   *
   * @param {string} model            - Raw model name
   * @param {string} taskType         - Task category
   * @param {object} [failureDetails] - Optional details about the failure
   * @param {string} [opponent]       - Optional opponent model
   */
  recordLoss(model, taskType, failureDetails = {}, opponent = null) {
    const { canonical, display } = normaliseModel(model);

    // ── Self-match guard ──────────────────────────────────
    if (SELF_MATCH_GUARD && opponent && isSameModel(model, opponent)) {
      console.log(
        `[Scoreboard] ⏭  Skipped self-match loss: ${display} vs ${opponent} on ${taskType}`
      );
      return;
    }

    const entry = this._getEntry(canonical, taskType, display);

    const opponentCanonical = opponent ? normaliseModel(opponent).canonical : null;
    const opponentScore = opponentCanonical && this.scores[opponentCanonical]?.[taskType]?.score
      ? this.scores[opponentCanonical][taskType].score
      : this._getAverageScore(taskType, canonical);

    // Loss formula: the "opponent" won, so we compute from opponent's perspective
    const expected   = this._expectedScore(opponentScore, entry.score);
    const scoreLoss  = K_FACTOR * (1 - expected);
    const prevScore  = entry.score;

    entry.score  -= scoreLoss;
    entry.losses += 1;

    this.failureLog.push({
      timestamp:   new Date().toISOString(),
      model:       display,
      canonical,
      taskType,
      failureMode: failureDetails.failureMode ?? "unknown",
      severity:    failureDetails.severity    ?? "unknown",
    });

    console.log(
      `[Scoreboard] ❌ LOSS: ${display} / ${taskType} ` +
      `| ${prevScore.toFixed(0)} → ${entry.score.toFixed(0)} (-${scoreLoss.toFixed(1)})`
    );

    this._saveToDisk();
  }

  /**
   * Get the best-performing model for a given task type.
   * Returns null when fewer than MIN_MATCHES_RANK matches are recorded.
   *
   * @param {string} taskType
   * @returns {string|null} - Canonical model name, or null
   */
  getBestModel(taskType) {
    const eligible = Object.entries(this.scores)
      .filter(([, modelData]) => {
        const e = modelData[taskType];
        return e && (e.wins + e.losses) >= MIN_MATCHES_RANK;
      })
      .map(([name, modelData]) => ({
        model: name,
        score: modelData[taskType].score,
        display: modelData[taskType].displayName || name,
      }));

    if (eligible.length === 0) {
      console.log(
        `[Scoreboard] Not enough data for ${taskType} — caller should use ROUTING_TABLE fallback.`
      );
      return null;
    }

    const best = eligible.sort((a, b) => b.score - a.score)[0];
    console.log(
      `[Scoreboard] Best model for ${taskType}: ${best.display} (score: ${best.score.toFixed(0)})`
    );
    return best.model;
  }

  /**
   * Get a per-model aggregated summary for the UI.
   * Each entry includes the display name, average Elo, total wins/losses,
   * win rate, and a per-task breakdown.
   *
   * @returns {Array<{
   *   canonical: string,
   *   displayName: string,
   *   provider: string,
   *   avgScore: number,
   *   totalWins: number,
   *   totalLosses: number,
   *   winRate: number,
   *   tasks: Array<{ taskType, score, wins, losses }>
   * }>}
   */
  getModelOverview() {
    return Object.entries(this.scores)
      .map(([canonical, taskMap]) => {
        const taskEntries = Object.entries(taskMap);
        const totalWins   = taskEntries.reduce((s, [, e]) => s + e.wins,   0);
        const totalLosses = taskEntries.reduce((s, [, e]) => s + e.losses, 0);
        const totalMatches = totalWins + totalLosses;
        const avgScore    = taskEntries.length > 0
          ? taskEntries.reduce((s, [, e]) => s + e.score, 0) / taskEntries.length
          : DEFAULT_SCORE;
        const displayName = this._displayNames[canonical] || canonical;

        // Extract provider from display name or canonical
        const rawSplit    = displayName.split("/");
        const provider    = rawSplit.length > 1 ? rawSplit[0] : "unknown";

        return {
          canonical,
          displayName,
          provider,
          avgScore,
          totalWins,
          totalLosses,
          winRate: totalMatches > 0 ? totalWins / totalMatches : 0,
          tasks: taskEntries.map(([taskType, e]) => ({
            taskType,
            score:   e.score,
            wins:    e.wins,
            losses:  e.losses,
          })),
        };
      })
      .sort((a, b) => b.avgScore - a.avgScore);
  }

  /**
   * Raw scores dump — used by /scoreboard endpoint and the existing UI.
   * The keys are the canonical model names; display name is embedded per task.
   *
   * @returns {object}
   */
  getSummary() {
    // Rebuild with canonical keys so the frontend can work without changes
    const out = {};
    Object.entries(this.scores).forEach(([canonical, tasks]) => {
      // Use the stored displayName as the outer key for backwards-compat
      const displayKey = this._displayNames[canonical] || canonical;
      out[displayKey] = {};
      Object.entries(tasks).forEach(([taskType, entry]) => {
        out[displayKey][taskType] = {
          score:  entry.score,
          wins:   entry.wins,
          losses: entry.losses,
        };
      });
    });
    return out;
  }

  /**
   * Get a snapshot of the raw internal scores (for debugging).
   * @returns {object}
   */
  getRawScores() {
    return JSON.parse(JSON.stringify(this.scores));
  }
}

// Export a ready-to-use instance
export const scoreboard = new Scoreboard();
