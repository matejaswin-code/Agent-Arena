// ─────────────────────────────────────────────────────────────
// src/router.js
//
// WHAT THIS FILE DOES:
//   Looks at a user's prompt and decides:
//   1. What TYPE of task it is (coding? math? creative writing?)
//   2. Which AGENT should handle it (Agent-A, Agent-B, Agent-C)
//   3. If the task is complex, splits it into SUBTASKS that can
//      run in parallel or in sequence
//
// EXAMPLE:
//   Prompt: "Write a poem about Python and also show me a code example"
//   → taskType: "mixed"
//   → subtasks: [
//       { id: 1, type: "creative", description: "Write a poem about Python" },
//       { id: 2, type: "code", description: "Show a Python code example", dependsOn: [] }
//     ]
//
// USES: Groq's free API (fast LLM) to analyze the prompt
// ─────────────────────────────────────────────────────────────

// ── Routing Table ─────────────────────────────────────────────
/**
 * Maps each task type to the best agent for that job.
 * These agent IDs must match the ids in server.js.
 *
 * You can change these mappings if you want different agents
 * handling different types of tasks.
 */
export const ROUTING_TABLE = {
  code:          "Agent-B", // Code agent (Claude) — best at programming
  math:          "Agent-A", // General agent — handles calculations
  creative:      "Agent-A", // General agent — handles creative writing
  summarization: "Agent-B", // Code agent is also good at summarizing text
  qa:            "Agent-C", // Local agent — handles general Q&A
  image:         "Agent-A", // Vision agent — handles image-related tasks
  mixed:         "Agent-A", // Use the main agent for mixed tasks
};

// ── Groq API settings ─────────────────────────────────────────
const GROQ_API_URL = "https://api.groq.com/openai/v1/chat/completions";
const GROQ_MODEL = "llama-3.1-8b-instant";

// Instructions we give the AI router about how to respond
const ROUTER_SYSTEM_PROMPT = `You are a task router for an AI system. 
Analyze the user's prompt and respond with ONLY raw JSON — no markdown, no backticks, no explanation.

The JSON must follow this exact format:
{
  "taskType": "<one of: code, math, creative, summarization, qa, image, mixed>",
  "subtasks": [
    {
      "id": 1,
      "type": "<one of: code, math, creative, summarization, qa, image>",
      "description": "<specific description of what needs to be done>",
      "dependsOn": []
    }
  ]
}

Rules:
- Simple prompts get ONE subtask with dependsOn: []
- Complex prompts can be split into multiple subtasks
- If subtask B needs the output of subtask A, set B's dependsOn to [1] (A's id)
- taskType should reflect the overall task category
- Always return valid JSON with no extra text`;

// ── Safe default (used when routing fails) ───────────────────
/**
 * If the router AI fails for any reason, we fall back to this.
 * Treats everything as a basic Q&A task.
 */
function safeDefault(prompt) {
  return {
    taskType: "qa",
    subtasks: [
      {
        id: 1,
        type: "qa",
        description: prompt,
        dependsOn: [],
      },
    ],
  };
}

// ── RouterAgent class ─────────────────────────────────────────
export class RouterAgent {
  /**
   * Analyzes a prompt and returns routing instructions.
   *
   * @param {string} prompt - The user's question
   * @returns {Promise<{ taskType: string, subtasks: Array }>}
   */
  async route(prompt) {
    try {
      const response = await fetch(GROQ_API_URL, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${process.env.GROQ_API_KEY}`,
        },
        body: JSON.stringify({
          model: GROQ_MODEL,
          max_tokens: 500,
          temperature: 0.1, // Low temperature = more consistent, predictable output
          messages: [
            { role: "system", content: ROUTER_SYSTEM_PROMPT },
            { role: "user", content: prompt },
          ],
        }),
      });

      if (!response.ok) {
        throw new Error(`Groq API returned status ${response.status}`);
      }

      const data = await response.json();
      const rawText = data.choices?.[0]?.message?.content?.trim() ?? "";

      // Remove any accidental markdown code fences the AI might add
      const cleanedText = rawText.replace(/```json|```/g, "").trim();

      const parsed = JSON.parse(cleanedText);

      // Validate the structure before using it
      if (!parsed.taskType || !Array.isArray(parsed.subtasks)) {
        throw new Error("Router returned invalid JSON structure");
      }

      console.log(
        `[Router] Task: "${parsed.taskType}" | Subtasks: ${parsed.subtasks.length}`
      );

      return parsed;
    } catch (err) {
      console.warn(
        "[Router] Failed to route prompt, using safe default:",
        err.message
      );
      return safeDefault(prompt);
    }
  }
}

// Export a ready-to-use instance
export const router = new RouterAgent();
