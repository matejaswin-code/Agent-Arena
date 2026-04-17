// ─────────────────────────────────────────────────────────────
// index.js  — Public entry point + local test harness
//
// HOW TO USE:
//   As a library (in other projects):
//     import { AIAgent, createAgent } from './index.js';
//
//   As a test runner:
//     node index.js
//
//   As a web server:
//     node server.js
// ─────────────────────────────────────────────────────────────

import { createRequire } from "module";
import { fileURLToPath } from "url";
import path from "path";
import fs from "fs";

// Figure out where this file lives
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const envPath = path.join(__dirname, ".env");

// Load .env file if it exists (no crash if it's missing)
if (fs.existsSync(envPath)) {
  const { default: dotenv } = await import("dotenv");
  dotenv.config({ path: envPath });
} else {
  console.warn("[index] No .env file found. Using process.env directly.");
}

// ── Public exports ────────────────────────────────────────────
// These are the things other projects can import from this file

// Core agent (original)
export { AIAgent, createAgent } from "./src/agent.js";
export { TelemetryEmitter } from "./src/telemetry.js";
export { buildToolMap, KNOWN_TOOLS } from "./src/tools.js";
export { runCode, detectLanguage } from "./src/sandbox.js";

// New systems (added in this update)
export { SemanticCache, semanticCache } from "./src/semanticCache.js";
export { Scoreboard, scoreboard } from "./src/scoreboard.js";
export { RouterAgent, router, ROUTING_TABLE } from "./src/router.js";
export { ReviewerAgent, reviewer } from "./src/reviewer.js";
export { RefinerAgent, refiner } from "./src/refiner.js";
export { HoneypotScheduler, honeypot } from "./src/honeypot.js";
export { heuristicCheck } from "./src/heuristicCheck.js";

// ─────────────────────────────────────────────────────────────
// LOCAL TEST HARNESS
// Only runs when you do: node index.js
// Does NOT run when this file is imported as a library
// ─────────────────────────────────────────────────────────────
const isMain = process.argv[1] === __filename;

if (!isMain) {
  // When imported as a library, don't run test code
  // (we used to exit here, but that breaks library imports — just do nothing)
}

if (isMain) {
  // ── Import everything we need for testing ─────────────────
  const { AIAgent } = await import("./src/agent.js");

  // ── Colour helpers (makes output easier to read) ──────────
  const C = {
    reset:   "\x1b[0m",
    bold:    "\x1b[1m",
    dim:     "\x1b[2m",
    cyan:    "\x1b[36m",
    green:   "\x1b[32m",
    yellow:  "\x1b[33m",
    red:     "\x1b[31m",
    magenta: "\x1b[35m",
    blue:    "\x1b[34m",
  };

  const label  = (name, color) => `${color}${C.bold}[${name}]${C.reset}`;
  const banner = (text) => {
    const line = "═".repeat(60);
    console.log(`\n${C.cyan}${line}${C.reset}`);
    console.log(`${C.cyan}  ${text}${C.reset}`);
    console.log(`${C.cyan}${line}${C.reset}\n`);
  };

  function formatResult(agentLabel, res) {
    console.log(`\n${agentLabel} ${C.green}${C.bold}RESULT${C.reset}`);
    console.log(`  ${C.bold}model:${C.reset}      ${res.model}`);
    console.log(`  ${C.bold}durationMs:${C.reset} ${res.durationMs}ms`);
    console.log(
      `  ${C.bold}toolsUsed:${C.reset}  ${
        res.toolsUsed.length ? res.toolsUsed.join(", ") : "(none)"
      }`
    );
    if (res.errors.length) {
      console.log(`  ${C.yellow}${C.bold}soft errors:${C.reset}`);
      res.errors.forEach((e) =>
        console.log(`    • ${C.yellow}[${e.tool}]${C.reset} ${e.message}`)
      );
    }
    console.log(`  ${C.bold}result:${C.reset}`);
    res.result.split("\n").forEach((l) => console.log(`    ${l}`));
  }

  // ── Test agent configurations ─────────────────────────────
  // These use mock API keys so they'll demonstrate graceful
  // fallback without making real API calls.
  const testAgentConfigs = [
    {
      id: "Agent-A",
      color: C.cyan,
      config: {
        apiKey:    process.env.AGENT_A_API_KEY  ?? "mock-key-a",
        baseURL:   process.env.AGENT_A_BASE_URL ?? "https://api.openai.com/v1",
        modelNames: process.env.AGENT_A_MODELS?.split(",") ?? ["gpt-4o"],
        modelName:  process.env.AGENT_A_MODEL  ?? "gpt-4o",
        maxTokens: 512,
        enabledTools: ["readImage", "generateImage", "runCode"],
        systemPrompt: "You are Agent A, a vision-capable assistant.",
        telemetryMs: 1000,
      },
    },
    {
      id: "Agent-B",
      color: C.magenta,
      config: {
        apiKey:    process.env.AGENT_B_API_KEY  ?? "mock-key-b",
        baseURL:   process.env.AGENT_B_BASE_URL ?? "https://api.anthropic.com/v1",
        modelNames: process.env.AGENT_B_MODELS?.split(",") ?? ["claude-opus-4-5"],
        modelName:  process.env.AGENT_B_MODEL  ?? "claude-opus-4-5",
        maxTokens: 512,
        enabledTools: ["runCode", "readImage"],
        systemPrompt: "You are Agent B, a code-focused assistant.",
        telemetryMs: 1000,
      },
    },
    {
      id: "Agent-C",
      color: C.blue,
      config: {
        apiKey:    process.env.AGENT_C_API_KEY  ?? "ollama",
        baseURL:   process.env.AGENT_C_BASE_URL ?? "http://localhost:11434/v1",
        modelNames: process.env.AGENT_C_MODELS?.split(",") ?? ["llama3"],
        modelName:  process.env.AGENT_C_MODEL  ?? "llama3",
        maxTokens: 512,
        systemPrompt: "You are Agent C, a local generalist assistant.",
        telemetryMs: 1000,
      },
    },
  ];

  // ── Test prompts ──────────────────────────────────────────
  const TEST_PROMPTS = [
    // Test 1: Code execution
    `Run this JavaScript code and tell me the output:
\`\`\`js
const fib = (n) => n <= 1 ? n : fib(n-1) + fib(n-2);
console.log([...Array(8).keys()].map(fib).join(', '));
\`\`\``,

    // Test 2: Plain text (no tools)
    `In two sentences, explain why the sky is blue.`,

    // Test 3: Math
    `What is 25% of 480?`,
  ];

  // ── Run tests ─────────────────────────────────────────────
  async function runDispatch(promptText, promptIndex) {
    banner(`PROMPT ${promptIndex + 1}: "${promptText.slice(0, 60).trim()}..."`);

    const testAgents = testAgentConfigs.map(({ id, color, config }) => {
      const agent = new AIAgent({
        ...config,
        onStatus: ({ phase, model, elapsedMs }) => {
          console.log(
            `  ${label(id, color)} ${C.dim}${elapsedMs}ms${C.reset} → ${phase}`
          );
        },
      });
      return { id, color, agent };
    });

    console.log(`${C.dim}Dispatching to ${testAgents.length} agents...${C.reset}\n`);

    const results = await Promise.allSettled(
      testAgents.map(({ agent }) => agent.run(promptText))
    );

    banner("RESULTS");
    results.forEach((outcome, i) => {
      const { id, color } = testAgents[i];
      if (outcome.status === "fulfilled") {
        formatResult(label(id, color), outcome.value);
      } else {
        console.log(`\n${label(id, color)} ${C.red}REJECTED${C.reset}`);
        console.log(`  ${C.red}${outcome.reason}${C.reset}`);
      }
      console.log();
    });
  }

  async function main() {
    banner("AI AGENT TEST HARNESS");
    console.log(
      `${C.dim}Running ${TEST_PROMPTS.length} prompt(s) across ${testAgentConfigs.length} agents.\n` +
      `Agents with mock API keys will demonstrate graceful fallback.${C.reset}\n`
    );

    for (let i = 0; i < TEST_PROMPTS.length; i++) {
      await runDispatch(TEST_PROMPTS[i], i);
    }

    banner("ALL TESTS COMPLETE");
  }

  main().catch((err) => {
    console.error(`${C.red}Fatal error in test harness:${C.reset}`, err);
    process.exit(1);
  });
}
