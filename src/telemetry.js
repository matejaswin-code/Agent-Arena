// ─────────────────────────────────────────────────────────────
// src/telemetry.js
// Lightweight telemetry emitter: one status event per second,
// flushed on completion. Composable — each agent gets its own.
// ─────────────────────────────────────────────────────────────

// --- TELEMETRY ---

import { EventEmitter } from "events";

/**
 * TelemetryEmitter wraps an EventEmitter with:
 *  - A 1-second interval ticker that broadcasts the current phase
 *  - A history log of all phase transitions with timestamps
 *  - A graceful stop() that clears the interval and emits 'done'
 *
 * Events emitted:
 *   'status'  → { phase: string, model: string, elapsedMs: number }
 *   'error'   → { tool: string, message: string }
 *   'done'    → { model: string, durationMs: number, history: [] }
 */
export class TelemetryEmitter extends EventEmitter {
  /**
   * @param {string} modelName  – label attached to every event
   * @param {number} [intervalMs=1000] – tick frequency in ms
   */
  constructor(modelName, intervalMs = 1000) {
    super();
    this.modelName = modelName;
    this.intervalMs = intervalMs;

    this._phase = "idle";
    this._startTime = null;
    this._ticker = null;
    this._history = []; // [{ phase, timestamp, elapsedMs }]
  }

  // ── Phase management ─────────────────────────────────────────

  /**
   * Transition to a new phase. Logged immediately; the next tick
   * will broadcast it.
   * @param {string} phase
   */
  setPhase(phase) {
    this._phase = phase;
    const elapsedMs = this._startTime ? Date.now() - this._startTime : 0;
    this._history.push({ phase, timestamp: Date.now(), elapsedMs });
  }

  // ── Lifecycle ─────────────────────────────────────────────────

  /** Begin ticking. Call once when agent.run() starts. */
  start() {
    this._startTime = Date.now();
    this.setPhase("dispatching");

    this._ticker = setInterval(() => {
      const elapsedMs = Date.now() - this._startTime;
      this.emit("status", {
        phase: this._phase,
        model: this.modelName,
        elapsedMs,
      });
    }, this.intervalMs);

    // Emit one immediately so callers get instant feedback
    this.emit("status", {
      phase: this._phase,
      model: this.modelName,
      elapsedMs: 0,
    });
  }

  /**
   * Stop ticking and emit a final 'done' event.
   * Safe to call multiple times (idempotent).
   */
  stop() {
    if (!this._ticker) return;
    clearInterval(this._ticker);
    this._ticker = null;

    const durationMs = this._startTime ? Date.now() - this._startTime : 0;
    this.setPhase("done");

    this.emit("done", {
      model: this.modelName,
      durationMs,
      history: [...this._history],
    });
  }

  /** Emit a non-fatal tool error. */
  emitToolError(tool, message) {
    this.emit("error", { tool, message });
  }

  /** Snapshot of phase history for the final response object. */
  get history() {
    return [...this._history];
  }
}
