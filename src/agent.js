// ─────────────────────────────────────────────────────────────
// src/agent.js
//
// WHAT THIS FILE DOES:
//   The core AI Agent — the brain of the whole system.
//   One instance = one AI model configuration.
//
// WHAT'S NEW vs the previous version:
//   1. run() accepts an optional third argument: options object
//      - options.systemPromptOverride: replaces the agent's default
//        system prompt for this single call only. Used by instruction sets.
//   2. The response object now includes failed: boolean
//      - true only when every model in the fallback chain failed
//      - server.js uses this for health monitoring
//
// HOW THE RESPONSE PIPELINE WORKS:
//   Prompt → Tools → LLM → Heuristic Check → [Reviewer] → Return
//                                ↓ pass          ↓ minor
//                            skip reviewer    add footnote
//                                             ↓ major
//                                         retry next model
// ─────────────────────────────────────────────────────────────

import { TelemetryEmitter } from "./telemetry.js";
import { buildToolMap, isCodePrompt, KNOWN_TOOLS } from "./tools.js";
import { heuristicCheck } from "./heuristicCheck.js";
import { reviewer } from "./reviewer.js";
import { scoreboard } from "./scoreboard.js";

// ── Config validation ─────────────────────────────────────────
const REQUIRED_CONFIG_KEYS = ["apiKey", "baseURL"];

function validateConfig(config) {
  if (!config || typeof config !== "object") {
    throw new Error("Agent config must be a non-null object.");
  }

  const missing = REQUIRED_CONFIG_KEYS.filter(
    (k) => !config[k] || typeof config[k] !== "string"
  );

  if (missing.length > 0) {
    throw new Error(
      `Agent config is missing required fields: ${missing.join(", ")}`
    );
  }

  if (config.enabledTools) {
    if (!Array.isArray(config.enabledTools)) {
      throw new Error("config.enabledTools must be an array.");
    }
    const invalid = config.enabledTools.filter((t) => !KNOWN_TOOLS.includes(t));
    if (invalid.length > 0) {
      throw new Error(
        `config.enabledTools has unknown tools: ${invalid.join(", ")}. ` +
        `Valid tools: ${KNOWN_TOOLS.join(", ")}`
      );
    }
  }
}

// ── Helper: POST to an AI chat endpoint ──────────────────────
async function chatCompletionPost(baseURL, apiKey, body) {
  const res = await fetch(`${baseURL}/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    const err = new Error(`HTTP ${res.status}: ${text.slice(0, 300)}`);
    err.status = res.status;
    throw err;
  }

  return res.json();
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// ── AIAgent class ─────────────────────────────────────────────
export class AIAgent {
  /**
   * @param {object} config
   * @param {string}   config.apiKey
   * @param {string}   config.baseURL
   * @param {string}   config.modelName
   * @param {string[]} [config.modelNames]
   * @param {string[]} [config.enabledTools]
   * @param {object}   [config.modelOptions]
   * @param {number}   [config.maxTokens=1024]
   * @param {Function} [config.onStatus]
   * @param {number}   [config.telemetryMs=1000]
   * @param {string}   [config.systemPrompt]
   * @param {string}   [config.imageSize]
   * @param {string}   [config.videoEndpoint]
   * @param {number}   [config.videoDuration]
   */
  constructor(config) {
    validateConfig(config);
    this.config     = Object.freeze({ ...config });
    this.modelNames = config.modelNames?.filter(Boolean) ?? [config.modelName];
    if (this.modelNames.length === 0) {
      throw new Error("Agent config needs at least one model name.");
    }
    this.modelName = this.modelNames[0];
    this._tools    = buildToolMap(this.config);
  }

  // ── Main public method ────────────────────────────────────

  /**
   * Run a prompt through the agent and return a response.
   * Always resolves (never rejects).
   *
   * @param {string} prompt
   * @param {string} [taskType="qa"]
   * @param {object} [options={}]
   * @param {string} [options.systemPromptOverride] - Replaces the agent's
   *   default system prompt for this call only. Used by instruction sets.
   *
   * @returns {Promise<AgentResponse>}
   *
   * @typedef {object} AgentResponse
   * @property {string}   model
   * @property {string}   result
   * @property {string[]} toolsUsed
   * @property {number}   durationMs
   * @property {Array}    errors
   * @property {boolean}  failed   - true only when ALL models in the chain failed
   */
  async run(prompt, taskType = "qa", options = {}) {
    const startTime    = Date.now();
    const toolsUsed    = [];
    const errors       = [];
    let   currentPrompt = prompt;
    let   retryDelayMs  = 1000;

    for (let modelIndex = 0; modelIndex < this.modelNames.length; modelIndex++) {
      const model    = this.modelNames[modelIndex];
      this.modelName = model;

      const telemetry = this._createTelemetry();
      if (typeof this.config.onStatus === "function") {
        telemetry.on("status", this.config.onStatus);
      }
      telemetry.start();

      try {
        // ── Phase 1: Pre-processing Tools ──────────────────
        const toolResults = await this._runPreProcessingTools(
          currentPrompt, telemetry, toolsUsed, errors
        );

        // ── Phase 2: Call the LLM ───────────────────────────
        telemetry.setPhase(`generating:${model}`);
        const rawResult = await this._callLLM(
          currentPrompt,
          toolResults,
          options.systemPromptOverride ?? null
        );

        // ── Phase 3: Heuristic Check ────────────────────────
        telemetry.setPhase("heuristic_check");
        const heuristic = await heuristicCheck(currentPrompt, rawResult);

        // ── Phase 4: Reviewer (only if heuristic found issues) ──
        let finalResult = rawResult;

        if (heuristic.passed) {
          console.log(`[Agent:${model}] ✅ Heuristic check passed — skipping reviewer.`);
          scoreboard.recordWin(model, taskType);
          telemetry.stop();
          return { model, result: finalResult, toolsUsed, durationMs: Date.now() - startTime, errors, failed: false };
        }

        console.log(
          `[Agent:${model}] ⚠️ Heuristic issues: ${heuristic.issues.join("; ")}. Calling reviewer...`
        );

        telemetry.setPhase("reviewing");
        const review = await reviewer.review(currentPrompt, rawResult, taskType, model);

        if (review.severity === "pass") {
          scoreboard.recordWin(model, taskType);
          telemetry.stop();
          return { model, result: finalResult, toolsUsed, durationMs: Date.now() - startTime, errors, failed: false };

        } else if (review.severity === "minor") {
          const issueList = review.issues.join("; ");
          finalResult = rawResult + `\n\n---\n⚠️ **Note:** This response has minor quality issues: ${issueList}`;
          scoreboard.recordWin(model, taskType);
          telemetry.stop();
          return { model, result: finalResult, toolsUsed, durationMs: Date.now() - startTime, errors, failed: false };

        } else if (review.severity === "major") {
          const issueList   = review.issues.join(", ");
          const sectionList = review.affectedSections.join(", ");

          console.log(`[Agent:${model}] 🔴 MAJOR review failure. Issues: ${issueList}. Abandoning.`);
          scoreboard.recordLoss(model, taskType, { failureMode: "major_review_failure", severity: "major" });
          errors.push({ tool: "reviewer", message: `Major quality issues from ${model}: ${issueList}` });

          const nextModel = this.modelNames[modelIndex + 1];
          if (nextModel) {
            currentPrompt =
              `A previous attempt failed due to: ${issueList}. ` +
              `Avoid problems in: ${sectionList}. ` +
              `Now answer: ${prompt}`;
            console.log(`[Agent] ↩️  Falling back: "${model}" → "${nextModel}" (major review failure)`);
          }

          telemetry.stop();
          continue;
        }

      } catch (err) {
        telemetry.stop();
        const status  = err?.status ?? err?.response?.status;
        const elapsed = Date.now() - startTime;

        if (status === 429) {
          console.log(`[Agent:${model}] ⏳ Rate limited (429). Waiting ${retryDelayMs}ms...`);
          await sleep(retryDelayMs);
          retryDelayMs = Math.min(retryDelayMs * 2, 16000);

          try {
            this.modelName = model;
            const retryTelemetry = this._createTelemetry();
            retryTelemetry.start();

            const toolResults  = await this._runPreProcessingTools(currentPrompt, retryTelemetry, toolsUsed, errors);
            const retryResult  = await this._callLLM(currentPrompt, toolResults, options.systemPromptOverride ?? null);

            retryTelemetry.stop();
            scoreboard.recordWin(model, taskType);
            return { model, result: retryResult, toolsUsed, durationMs: Date.now() - startTime, errors, failed: false };

          } catch (retryErr) {
            const nextModel = this.modelNames[modelIndex + 1];
            console.log(
              `[Agent] ↩️  Falling back: "${model}" → "${nextModel ?? "none"}" | ` +
              `elapsed: ${elapsed}ms | reason: 429 retry also failed`
            );
            scoreboard.recordLoss(model, taskType, { failureMode: "rate_limit_429", severity: "major" });
          }
        } else {
          const nextModel = this.modelNames[modelIndex + 1];
          console.log(
            `[Agent] ↩️  Falling back: "${model}" → "${nextModel ?? "none"}" | ` +
            `elapsed: ${elapsed}ms | reason: HTTP ${status ?? "unknown"} — ${err.message.slice(0, 100)}`
          );
          scoreboard.recordLoss(model, taskType, { failureMode: `http_${status ?? "unknown"}`, severity: "major" });
        }

        errors.push({ tool: "model", message: `Model "${model}" failed: ${err.message.slice(0, 200)}` });
        continue;
      }
    }

    // ── All models failed ─────────────────────────────────
    console.error("[Agent] 💥 All models in the fallback chain have failed.");
    return {
      model:      this.modelNames[0],
      result:     "I'm sorry, but all available AI models have failed to respond. Please try again in a moment.",
      toolsUsed,
      durationMs: Date.now() - startTime,
      errors,
      failed:     true, // ← health monitor uses this
    };
  }

  // ── Private helpers ───────────────────────────────────────

  _createTelemetry() {
    return new TelemetryEmitter(this.modelName, this.config.telemetryMs ?? 1000);
  }

  async _runPreProcessingTools(prompt, telemetry, toolsUsed, errors) {
    const results = {};
    const lower   = prompt.toLowerCase();

    if (this._tools.runCode && isCodePrompt(prompt)) {
      telemetry.setPhase("calling_tool:runCode");
      try {
        const out = await this._tools.runCode(prompt);
        results.runCode = out;
        toolsUsed.push("runCode");
        if (out.startsWith("runCode encountered")) errors.push({ tool: "runCode", message: out });
      } catch (err) {
        errors.push({ tool: "runCode", message: err.message });
        telemetry.emitToolError("runCode", err.message);
      }
    }

    if (this._tools.readImage) {
      const imageUrl = extractUrl(prompt, /\.(png|jpg|jpeg|gif|webp)(\?|$)/i);
      if (imageUrl) {
        telemetry.setPhase("calling_tool:readImage");
        const out = await this._tools.readImage(imageUrl);
        results.readImage = out;
        toolsUsed.push("readImage");
        if (out === "readImage is not supported by this model/API.")
          errors.push({ tool: "readImage", message: out });
      }
    }

    if (this._tools.readVideo) {
      const videoUrl = extractUrl(prompt, /\.(mp4|mov|avi|webm|mkv)(\?|$)/i);
      if (videoUrl) {
        telemetry.setPhase("calling_tool:readVideo");
        const out = await this._tools.readVideo(videoUrl);
        results.readVideo = out;
        toolsUsed.push("readVideo");
        if (out === "readVideo is not supported by this model/API.")
          errors.push({ tool: "readVideo", message: out });
      }
    }

    if (
      this._tools.generateImage &&
      /generate|create|draw|make|produce/.test(lower) &&
      /\bimage\b|\bpicture\b|\billustration\b|\bart\b/.test(lower)
    ) {
      telemetry.setPhase("calling_tool:generateImage");
      const out = await this._tools.generateImage(prompt);
      results.generateImage = out;
      toolsUsed.push("generateImage");
      if (out === "generateImage is not supported by this model/API.")
        errors.push({ tool: "generateImage", message: out });
    }

    if (
      this._tools.generateVideo &&
      /generate|create|make|produce/.test(lower) &&
      /\bvideo\b|\bclip\b|\banimation\b/.test(lower)
    ) {
      telemetry.setPhase("calling_tool:generateVideo");
      const out = await this._tools.generateVideo(prompt);
      results.generateVideo = out;
      toolsUsed.push("generateVideo");
      if (out === "generateVideo is not supported by this model/API.")
        errors.push({ tool: "generateVideo", message: out });
    }

    return results;
  }

  /**
   * Call the LLM.
   *
   * @param {string}      prompt
   * @param {object}      toolResults
   * @param {string|null} systemPromptOverride - If set, replaces config.systemPrompt
   */
  async _callLLM(prompt, toolResults, systemPromptOverride = null) {
    const hasToolResults = Object.keys(toolResults).length > 0;

    // Use the override if provided, otherwise fall back to config default
    const baseSystemPrompt =
      systemPromptOverride ??
      this.config.systemPrompt ??
      "You are a helpful, concise assistant.";

    const systemParts = [baseSystemPrompt];

    if (hasToolResults) {
      systemParts.push(
        "\n\nThe following tool outputs were gathered before your response. " +
        "Use them as additional context:\n" +
        Object.entries(toolResults)
          .map(([tool, output]) => `[${tool}]:\n${output}`)
          .join("\n\n")
      );
    }

    const data = await chatCompletionPost(this.config.baseURL, this.config.apiKey, {
      model:      this.modelName,
      messages:   [
        { role: "system", content: systemParts.join("") },
        { role: "user",   content: prompt },
      ],
      max_tokens: this.config.maxTokens ?? 1024,
      ...this.config.modelOptions,
    });

    return (
      data.choices?.[0]?.message?.content?.trim() ??
      "No content returned by the model."
    );
  }
}

// ── Utility ───────────────────────────────────────────────────
function extractUrl(text, pathPattern) {
  const urlRegex = /https?:\/\/[^\s"'<>]+/g;
  let match;
  while ((match = urlRegex.exec(text)) !== null) {
    if (pathPattern.test(match[0])) return match[0];
  }
  return null;
}

export function createAgent(config) {
  return new AIAgent(config);
}
