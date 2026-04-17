// ─────────────────────────────────────────────────────────────
// src/honeypot.js
//
// WHAT THIS FILE DOES:
//   Secretly tests AI agents in the background while the server
//   runs normally. Think of it like surprise quality checks.
//
// HOW IT WORKS:
//   - Has a list of test questions with known correct answers
//   - Every 10 minutes, picks a random agent and asks it one of
//     these test questions
//   - Checks if the answer contains the expected key phrases
//   - Updates the scoreboard based on how well it did
//
// WHY "HONEYPOT"?
//   The AI agents don't know they're being tested — they get
//   the same treatment as a real user question. This gives us
//   honest performance data without the AI "knowing" it's
//   being evaluated.
//
// THE BENCHMARKS:
//   We have questions in 3 categories: code, math, and qa
//   (at least 2 per category as required)
// ─────────────────────────────────────────────────────────────

import { scoreboard } from "./scoreboard.js";

// ── Benchmark questions ───────────────────────────────────────
/**
 * Each benchmark has:
 *   prompt:             The test question
 *   expectedKeyPhrases: Words/phrases that MUST appear in a correct answer
 *   taskType:           Which category this tests (code, math, qa)
 */
const BENCHMARKS = [
  // ── Code benchmarks (2 minimum) ──────────────────────────
  {
    prompt:
      "Write a JavaScript function that takes two numbers as arguments and returns their sum.",
    expectedKeyPhrases: ["function", "return", "+"],
    taskType: "code",
  },
  {
    prompt:
      "Write a Python function called is_prime that returns True if a number is prime, False otherwise.",
    expectedKeyPhrases: ["def is_prime", "return", "for", "range"],
    taskType: "code",
  },
  {
    prompt:
      "Write JavaScript code to check if a string is a palindrome (same forwards and backwards).",
    expectedKeyPhrases: ["function", "reverse", "return"],
    taskType: "code",
  },

  // ── Math benchmarks (2 minimum) ──────────────────────────
  {
    prompt: "What is 15% of 240? Show your calculation.",
    expectedKeyPhrases: ["36"],
    taskType: "math",
  },
  {
    prompt:
      "A train travels at 60 miles per hour. How many miles does it travel in 2.5 hours?",
    expectedKeyPhrases: ["150"],
    taskType: "math",
  },
  {
    prompt:
      "What is the area of a circle with radius 7? Use π ≈ 3.14159. Round to 2 decimal places.",
    expectedKeyPhrases: ["153.94"],
    taskType: "math",
  },

  // ── Q&A benchmarks (2 minimum) ───────────────────────────
  {
    prompt: "What is the capital city of France?",
    expectedKeyPhrases: ["paris"],
    taskType: "qa",
  },
  {
    prompt: "Who wrote the play Romeo and Juliet?",
    expectedKeyPhrases: ["shakespeare", "william"],
    taskType: "qa",
  },
  {
    prompt: "What does HTML stand for?",
    expectedKeyPhrases: ["hypertext", "markup", "language"],
    taskType: "qa",
  },
];

// Get all unique task types from our benchmark list
const ALL_TASK_TYPES = [...new Set(BENCHMARKS.map((b) => b.taskType))];

// ── HoneypotScheduler class ───────────────────────────────────
export class HoneypotScheduler {
  /**
   * Run a single benchmark check against a specific agent.
   * This is called silently — errors are caught and logged, never thrown.
   *
   * @param {object} agentInstance - An instantiated AIAgent object
   * @param {string} taskType      - Which category to test ("code", "math", "qa")
   */
  async runCheck(agentInstance, taskType) {
    // Get all benchmarks for this task type
    const candidates = BENCHMARKS.filter((b) => b.taskType === taskType);
    if (candidates.length === 0) {
      console.log(`[Honeypot] No benchmarks found for task type: ${taskType}`);
      return;
    }

    // Pick one randomly
    const benchmark = candidates[Math.floor(Math.random() * candidates.length)];

    try {
      console.log(
        `[Honeypot] 🍯 Running secret check | Task: ${taskType} | ` +
        `Prompt: "${benchmark.prompt.slice(0, 50)}..."`
      );

      // Run the benchmark through the agent (agent doesn't know it's a test)
      const result = await agentInstance.run(benchmark.prompt, taskType);
      const responseText = result.result.toLowerCase();
      const modelName = result.model;

      // Count how many expected phrases appear in the response
      const matchCount = benchmark.expectedKeyPhrases.filter((phrase) =>
        responseText.includes(phrase.toLowerCase())
      ).length;

      const fraction = matchCount / benchmark.expectedKeyPhrases.length;
      const percentage = (fraction * 100).toFixed(0);

      console.log(
        `[Honeypot] Score: ${matchCount}/${benchmark.expectedKeyPhrases.length} ` +
        `phrases found (${percentage}%) for model: ${modelName}`
      );

      // Update the scoreboard based on performance
      if (fraction > 0.8) {
        // Passed: found more than 80% of expected phrases
        scoreboard.recordWin(modelName, taskType);
        console.log(`[Honeypot] ✅ PASS — ${modelName} scored well on ${taskType}`);
      } else {
        // Failed: didn't find enough expected phrases
        scoreboard.recordLoss(modelName, taskType, {
          failureMode: "honeypot_benchmark",
          severity: "minor",
        });
        console.log(
          `[Honeypot] ❌ FAIL — ${modelName} only got ${percentage}% on ${taskType} benchmark`
        );
      }
    } catch (err) {
      // Never crash the server because of a honeypot check
      console.error("[Honeypot] runCheck() error (non-fatal):", err.message);
    }
  }

  /**
   * Start running periodic background checks every 10 minutes.
   * Call this once when the server starts up.
   *
   * @param {object[]} agents - Array of AIAgent instances to test
   */
  startScheduler(agents) {
    if (!agents || agents.length === 0) {
      console.warn("[Honeypot] No agents provided — scheduler will not start.");
      return;
    }

    const TEN_MINUTES_MS = 10 * 60 * 1000;

    setInterval(() => {
      // Wrap everything in try-catch so the interval never crashes
      try {
        // Pick a random agent and task type
        const randomAgent = agents[Math.floor(Math.random() * agents.length)];
        const randomTaskType =
          ALL_TASK_TYPES[Math.floor(Math.random() * ALL_TASK_TYPES.length)];

        console.log(
          `[Honeypot] ⏰ Scheduled check starting | Task type: ${randomTaskType}`
        );

        // Run the check but don't await it — we don't want to block anything
        this.runCheck(randomAgent, randomTaskType).catch((err) => {
          console.error("[Honeypot] Scheduled check failed:", err.message);
        });
      } catch (err) {
        console.error("[Honeypot] Scheduler tick error:", err.message);
      }
    }, TEN_MINUTES_MS);

    console.log("[Honeypot] 🍯 Scheduler started — will run checks every 10 minutes.");
  }
}

// Export a ready-to-use instance
export const honeypot = new HoneypotScheduler();
