// ─────────────────────────────────────────────────────────────
// server.js
//
// WHAT'S NEW IN THIS VERSION:
//
//   1. AGENT-D: FAILSAFE AGENT
//      Uses Groq directly (different infrastructure than OpenRouter)
//      so it's available even when all primary agents are down.
//      Activates automatically when Agent-A AND Agent-B have both
//      had 3+ consecutive failures.
//
//   2. AGENT HEALTH MONITOR
//      Tracks consecutive failures per agent. After the threshold
//      is reached, getAgentForTask() skips that agent and tries
//      the next. If all primary agents (A, B, C) are down,
//      Agent-D takes over.
//
//   3. INSTRUCTION SETS
//      GET  /api/instructions  → returns list of available modes
//      POST /api/ask accepts   { prompt, instructionSet }
//      The instruction set replaces the agent's system prompt
//      for that request only. Defaults to "general" if omitted.
//
//   4. NEW ENDPOINTS
//      GET /api/instructions  → list all instruction sets
//      GET /health            → uptime + agent health status
//      GET /scoreboard        → model performance data
// ─────────────────────────────────────────────────────────────

import { fileURLToPath } from "url";
import path from "path";
import fs from "fs";
import express from "express";

const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);
const envPath    = path.join(__dirname, ".env");

if (fs.existsSync(envPath)) {
  const { default: dotenv } = await import("dotenv");
  dotenv.config({ path: envPath });
}

import { AIAgent }                        from "./src/agent.js";
import { router, ROUTING_TABLE }          from "./src/router.js";
import { refiner }                        from "./src/refiner.js";
import { semanticCache }                  from "./src/semanticCache.js";
import { honeypot }                       from "./src/honeypot.js";
import { scoreboard }                     from "./src/scoreboard.js";
import { getInstructionSet, listInstructionSets } from "./src/instructionSets.js";

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

// ─────────────────────────────────────────────────────────────
// AGENT CONFIGURATIONS
// ─────────────────────────────────────────────────────────────

const AGENT_CONFIGS = [
  // ── Agent A: Primary general/vision agent (OpenRouter) ────
  {
    id: "Agent-A",
    config: {
      apiKey:     process.env.AGENT_A_API_KEY  ?? "mock-key-a",
      baseURL:    process.env.AGENT_A_BASE_URL ?? "https://openrouter.ai/api/v1",
      modelNames: process.env.AGENT_A_MODELS?.split(",").filter(Boolean) ?? ["meta-llama/llama-3.1-8b-instruct:free"],
      modelName:  process.env.AGENT_A_MODEL  ?? "meta-llama/llama-3.1-8b-instruct:free",
      maxTokens:  1024,
      enabledTools:  ["readImage", "generateImage", "runCode"],
      systemPrompt:  "You are Agent A, a vision-capable general-purpose assistant.",
      telemetryMs:   2000,
    },
  },

  // ── Agent B: Code-focused agent (OpenRouter) ──────────────
  {
    id: "Agent-B",
    config: {
      apiKey:     process.env.AGENT_B_API_KEY  ?? "mock-key-b",
      baseURL:    process.env.AGENT_B_BASE_URL ?? "https://openrouter.ai/api/v1",
      modelNames: process.env.AGENT_B_MODELS?.split(",").filter(Boolean) ?? ["google/gemma-4-26b-a4b-it:free"],
      modelName:  process.env.AGENT_B_MODEL  ?? "google/gemma-4-26b-a4b-it:free",
      maxTokens:  1024,
      enabledTools:  ["runCode", "readImage"],
      systemPrompt:  "You are Agent B, a code-focused assistant. Excel at programming tasks.",
      telemetryMs:   2000,
    },
  },

  // ── Agent C: Local generalist (OpenRouter) ────────────────
  {
    id: "Agent-C",
    config: {
      apiKey:     process.env.AGENT_C_API_KEY  ?? "mock-key-c",
      baseURL:    process.env.AGENT_C_BASE_URL ?? "https://openrouter.ai/api/v1",
      modelNames: process.env.AGENT_C_MODELS?.split(",").filter(Boolean) ?? ["meta-llama/llama-3-8b-instruct:free"],
      modelName:  process.env.AGENT_C_MODEL  ?? "meta-llama/llama-3-8b-instruct:free",
      maxTokens:  1024,
      systemPrompt: "You are Agent C, a local generalist assistant.",
      telemetryMs:  2000,
    },
  },

  // ── Agent D: FAILSAFE — uses Groq (different infrastructure) ─
  //
  // Why Groq and not OpenRouter?
  //   Agents A, B, and C all use OpenRouter. If OpenRouter is
  //   down or rate-limiting your account, all three fail at once.
  //   Agent D uses Groq's own API — a completely separate backend
  //   — so it remains available even when OpenRouter is having issues.
  //
  // Agent D is NEVER used for normal routing. It only activates
  // when the health monitor marks both A and B as down.
  {
    id: "Agent-D",
    isFailsafe: true,
    config: {
      apiKey:     process.env.GROQ_API_KEY ?? "missing-groq-key",
      baseURL:    "https://api.groq.com/openai/v1",
      modelNames: ["llama-3.3-70b-versatile", "llama-3.1-8b-instant"],
      modelName:  "llama-3.3-70b-versatile",
      maxTokens:  1024,
      systemPrompt:
        "You are Agent D, a failsafe assistant. The primary agents are temporarily " +
        "unavailable, so you are handling this request. Be helpful and thorough.",
      telemetryMs: 2000,
    },
  },
];

// ── Build agent instances ─────────────────────────────────────
const agentMap = {};
const agents   = AGENT_CONFIGS.map(({ id, config }) => {
  const agent   = new AIAgent(config);
  agentMap[id]  = agent;
  return agent;
});

// Primary agents (A, B, C) — used for normal routing
const primaryAgentIds  = AGENT_CONFIGS.filter((c) => !c.isFailsafe).map((c) => c.id);
// Failsafe agents (D) — used when primaries are down
const failsafeAgentIds = AGENT_CONFIGS.filter((c) =>  c.isFailsafe).map((c) => c.id);

// ─────────────────────────────────────────────────────────────
// AGENT HEALTH MONITOR
//
// Tracks consecutive failures per agent.
// After FAILURE_THRESHOLD consecutive failures, the agent is
// marked as "down" and skipped by getAgentForTask().
// A single success resets the counter.
// ─────────────────────────────────────────────────────────────
const FAILURE_THRESHOLD = 3;

class AgentHealthMonitor {
  constructor(threshold = FAILURE_THRESHOLD) {
    this.threshold          = threshold;
    this._consecutiveFails  = {}; // agentId → number
    this._totalCalls        = {}; // agentId → number
    this._lastFailure       = {}; // agentId → ISO timestamp
  }

  /** Call after a successful agent.run() */
  recordSuccess(agentId) {
    this._consecutiveFails[agentId] = 0;
    this._totalCalls[agentId]       = (this._totalCalls[agentId] ?? 0) + 1;
  }

  /** Call after agent.run() returns failed: true */
  recordFailure(agentId) {
    this._consecutiveFails[agentId] = (this._consecutiveFails[agentId] ?? 0) + 1;
    this._totalCalls[agentId]       = (this._totalCalls[agentId] ?? 0) + 1;
    this._lastFailure[agentId]      = new Date().toISOString();

    if (this.isDown(agentId)) {
      console.warn(
        `[HealthMonitor] ⚠️  ${agentId} has failed ${this._consecutiveFails[agentId]} ` +
        `times in a row — marking as DOWN.`
      );
    }
  }

  /** True when consecutive failures >= threshold */
  isDown(agentId) {
    return (this._consecutiveFails[agentId] ?? 0) >= this.threshold;
  }

  /** Summary for the /health endpoint */
  getStatus() {
    const out = {};
    for (const id of [...primaryAgentIds, ...failsafeAgentIds]) {
      out[id] = {
        consecutiveFailures: this._consecutiveFails[id] ?? 0,
        totalCalls:          this._totalCalls[id]       ?? 0,
        isDown:              this.isDown(id),
        lastFailure:         this._lastFailure[id]      ?? null,
      };
    }
    return out;
  }
}

const healthMonitor = new AgentHealthMonitor();

// ─────────────────────────────────────────────────────────────
// AGENT SELECTION
// ─────────────────────────────────────────────────────────────

/**
 * Pick the best available agent for a given task type.
 * Priority:
 *   1. Scoreboard winner for this task type (if healthy)
 *   2. Routing table preference (if healthy)
 *   3. Any other non-down primary agent
 *   4. Agent-D failsafe (if ALL primaries are down)
 *
 * @param {string} taskType
 * @returns {{ agent: AIAgent, id: string }}
 */
function getAgentForTask(taskType) {
  // 1. Scoreboard-recommended model (only trust it if healthy)
  const bestModel = scoreboard.getBestModel(taskType);
  if (bestModel && agentMap[bestModel] && !healthMonitor.isDown(bestModel)) {
    return { agent: agentMap[bestModel], id: bestModel };
  }

  // 2. Routing table preference
  const preferredId = ROUTING_TABLE[taskType] ?? "Agent-A";
  if (!healthMonitor.isDown(preferredId) && agentMap[preferredId]) {
    return { agent: agentMap[preferredId], id: preferredId };
  }

  // 3. Any other healthy primary agent
  for (const id of primaryAgentIds) {
    if (!healthMonitor.isDown(id) && agentMap[id]) {
      console.log(`[Server] Preferred agent "${preferredId}" is down. Using "${id}" instead.`);
      return { agent: agentMap[id], id };
    }
  }

  // 4. All primaries are down — activate the failsafe
  const failsafeId = failsafeAgentIds[0];
  console.warn(
    `[Server] 🚨 All primary agents are DOWN. ` +
    `Activating failsafe: ${failsafeId}.`
  );
  return { agent: agentMap[failsafeId], id: failsafeId };
}

/**
 * Run an agent and update the health monitor based on the result.
 *
 * @param {AIAgent} agent
 * @param {string}  agentId
 * @param {string}  description
 * @param {string}  taskType
 * @param {string|null} systemPromptOverride
 */
async function runAgentTracked(agent, agentId, description, taskType, systemPromptOverride) {
  const result = await agent.run(
    description,
    taskType,
    systemPromptOverride ? { systemPromptOverride } : {}
  );

  if (result.failed) {
    healthMonitor.recordFailure(agentId);
  } else {
    healthMonitor.recordSuccess(agentId);
  }

  return result;
}

// ─────────────────────────────────────────────────────────────
// ROUTES
// ─────────────────────────────────────────────────────────────

// ── POST /api/ask ─────────────────────────────────────────────
app.post("/api/ask", async (req, res) => {
  const requestStart = Date.now();

  try {
    const { prompt, instructionSet: instructionSetName } = req.body;

    if (!prompt || typeof prompt !== "string" || prompt.trim().length === 0) {
      return res.status(400).json({ error: 'Request body must include a "prompt" string.' });
    }

    const rawPrompt = prompt.trim();

    // Resolve instruction set — defaults to "general" if not provided or unrecognised
    const instructionSet       = getInstructionSet(instructionSetName ?? "general");
    const systemPromptOverride = instructionSet.systemPrompt;

    // ── Refine + cache check ──────────────────────────────
    const refinedPrompt   = await refiner.refinePrompt(rawPrompt);
    const cachedResponse  = await semanticCache.get(refinedPrompt);

    if (cachedResponse) {
      return res.json({
        result:         cachedResponse,
        taskType:       "cached",
        subtaskCount:   0,
        cached:         true,
        instructionSet: instructionSetName ?? "general",
        durationMs:     Date.now() - requestStart,
        behindTheScenes: [],
      });
    }

    // ── Route + execute ───────────────────────────────────
    const routeResult              = await router.route(refinedPrompt);
    const { taskType, subtasks }   = routeResult;
    const subtaskResults           = {};
    const executionDetails         = [];

    const independentSubtasks = subtasks.filter((s) => s.dependsOn.length === 0);
    const dependentSubtasks   = subtasks.filter((s) => s.dependsOn.length > 0);

    // Run independent subtasks in parallel
    if (independentSubtasks.length > 0) {
      const parallelResults = await Promise.allSettled(
        independentSubtasks.map(async (subtask) => {
          const { agent, id: agentId } = getAgentForTask(subtask.type);
          const result = await runAgentTracked(
            agent, agentId, subtask.description, subtask.type, systemPromptOverride
          );
          return { id: subtask.id, type: subtask.type, agentId, result: result.result, model: result.model };
        })
      );

      parallelResults.forEach((outcome, i) => {
        const subtask = independentSubtasks[i];
        if (outcome.status === "fulfilled") {
          subtaskResults[subtask.id] = outcome.value.result;
          executionDetails.push({
            id:      subtask.id,
            type:    outcome.value.type,
            model:   outcome.value.model,
            agentId: outcome.value.agentId,
            output:  outcome.value.result,
          });
        } else {
          subtaskResults[subtask.id] = `[Error: ${outcome.reason?.message}]`;
        }
      });
    }

    // Run dependent subtasks sequentially
    for (const subtask of dependentSubtasks) {
      const dependencyContext = subtask.dependsOn
        .map((depId) => subtaskResults[depId] ? `[Step ${depId}]:\n${subtaskResults[depId]}` : "")
        .join("\n\n");
      const enrichedDescription = `${dependencyContext}\n\nUsing the above context: ${subtask.description}`;

      const { agent, id: agentId } = getAgentForTask(subtask.type);
      try {
        const result = await runAgentTracked(
          agent, agentId, enrichedDescription, subtask.type, systemPromptOverride
        );
        subtaskResults[subtask.id] = result.result;
        executionDetails.push({
          id:      subtask.id,
          type:    subtask.type,
          model:   result.model,
          agentId,
          output:  result.result,
        });
      } catch (err) {
        subtaskResults[subtask.id] = `[Error: ${err.message}]`;
      }
    }

    // ── Assemble + refine final response ──────────────────
    let assembledResponse;
    if (subtasks.length === 1) {
      assembledResponse = subtaskResults[subtasks[0].id] ?? "No result.";
    } else {
      assembledResponse = subtasks
        .map((s) => `### Part ${s.id}: ${s.type.toUpperCase()}\n\n${subtaskResults[s.id] ?? "No result."}`)
        .join("\n\n---\n\n");
    }

    const finalResponse = await refiner.refineAnswer(refinedPrompt, assembledResponse);
    await semanticCache.set(refinedPrompt, finalResponse);

    return res.json({
      result:          finalResponse,
      taskType,
      subtaskCount:    subtasks.length,
      cached:          false,
      instructionSet:  instructionSetName ?? "general",
      durationMs:      Date.now() - requestStart,
      behindTheScenes: executionDetails,
    });

  } catch (err) {
    return res.status(500).json({ error: "Server error", message: err.message });
  }
});

// ── GET /api/instructions ─────────────────────────────────────
// Returns all available instruction sets for the frontend dropdown.
app.get("/api/instructions", (req, res) => {
  res.json({
    instructionSets: listInstructionSets(),
    default:         "general",
  });
});

// ── GET /health ───────────────────────────────────────────────
app.get("/health", (req, res) => {
  const agentHealth = healthMonitor.getStatus();
  const anyDown     = Object.values(agentHealth).some((s) => s.isDown);

  res.json({
    status:      anyDown ? "degraded" : "ok",
    uptime:      process.uptime(),
    cacheSize:   semanticCache.size,
    agents:      agentHealth,
  });
});

// ── GET /scoreboard ───────────────────────────────────────────
app.get("/scoreboard", (req, res) => res.json(scoreboard.getSummary()));

// ─────────────────────────────────────────────────────────────
// START
// ─────────────────────────────────────────────────────────────
const PORT   = process.env.PORT ?? 3000;
const server = app.listen(PORT, () => {
  console.log(`\n[Server] 🚀 Running at http://localhost:${PORT}`);
  console.log(`[Server] 🛡️  Failsafe agent: ${failsafeAgentIds.join(", ")} (activates after ${FAILURE_THRESHOLD} consecutive primary failures)`);
  console.log(`[Server] 📋 Instruction sets: ${listInstructionSets().map((s) => s.key).join(", ")}`);
  honeypot.startScheduler(agents.filter((_, i) => !AGENT_CONFIGS[i].isFailsafe));
});

process.on("SIGINT", () => server.close(() => process.exit(0)));
export default app;
