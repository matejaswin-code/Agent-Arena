// ─────────────────────────────────────────────────────────────
// src/reviewer.js
//
// WHAT THIS FILE DOES:
//   A "hostile" AI reviewer that tries to find problems in
//   AI-generated responses. Think of it as a tough editor.
//
// HOW IT WORKS:
//   - Only runs if the quick heuristic check found issues
//   - Uses Groq (fast, cheap AI) to review the response
//   - Returns one of three severity levels:
//
//     "pass"  → Response is good, return it as-is
//     "minor" → Small issues (formatting, clarity) — add a footnote
//     "major" → Serious problems — throw it out, try a different AI model
//
// IMPORTANT DESIGN RULE:
//   The reviewer should NEVER use the same AI model that generated
//   the response being reviewed. Since we use Groq here and the
//   main agents use different providers (OpenAI, Anthropic, etc.),
//   this is naturally satisfied. But we warn if it happens.
// ─────────────────────────────────────────────────────────────

const GROQ_API_URL = "https://api.groq.com/openai/v1/chat/completions";
const GROQ_MODEL = "llama-3.1-8b-instant";

// The instruction we give the reviewer AI
const REVIEWER_SYSTEM_PROMPT = `You are a hostile expert reviewer. Your ONLY job is to find problems with AI responses.
Be critical, thorough, and merciless. Do not be polite.

Respond with ONLY raw JSON — no markdown backticks, no preamble, no explanation:
{
  "severity": "pass",
  "issues": [],
  "affectedSections": []
}

Severity levels:
- "pass"  : The response correctly and fully answers the prompt
- "minor" : Small issues like formatting problems, minor unclear phrasing, or small inaccuracies
- "major" : Wrong answers, dangerous/harmful content, complete failure to answer, or logical errors

The "issues" array lists specific problems you found.
The "affectedSections" array lists which parts of the response have problems.
If severity is "pass", both arrays should be empty.`;

// Used when the reviewer itself fails (so we don't block the main response)
const SAFE_DEFAULT_PASS = {
  severity: "pass",
  issues: [],
  affectedSections: [],
};

// ── ReviewerAgent class ───────────────────────────────────────
export class ReviewerAgent {
  /**
   * Review an AI-generated response for quality problems.
   *
   * @param {string} originalPrompt  - The user's original question
   * @param {string} response        - The AI's answer to review
   * @param {string} taskType        - What kind of task this was (code, math, etc.)
   * @param {string} generatingModel - Which model produced this response
   * @returns {Promise<{ severity: string, issues: string[], affectedSections: string[] }>}
   */
  async review(originalPrompt, response, taskType, generatingModel) {
    // Safety warning: reviewer should be a different model than generator
    if (generatingModel === GROQ_MODEL) {
      console.warn(
        `[Reviewer] ⚠️  WARNING: The generating model (${generatingModel}) ` +
        `is the same as the reviewing model. Review quality may be reduced.`
      );
    }

    try {
      // Build the message that describes what to review
      const userContent =
        `Original prompt: ${originalPrompt}\n\n` +
        `Task type: ${taskType}\n\n` +
        `Response to review:\n${response}`;

      const apiResponse = await fetch(GROQ_API_URL, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${process.env.GROQ_API_KEY}`,
        },
        body: JSON.stringify({
          model: GROQ_MODEL,
          max_tokens: 500,
          temperature: 0.2, // Slightly low temperature for consistent JSON output
          messages: [
            { role: "system", content: REVIEWER_SYSTEM_PROMPT },
            { role: "user", content: userContent },
          ],
        }),
      });

      if (!apiResponse.ok) {
        throw new Error(`Groq API returned status ${apiResponse.status}`);
      }

      const data = await apiResponse.json();
      const rawText = data.choices?.[0]?.message?.content?.trim() ?? "";

      // Remove any accidental markdown fences
      const cleanedText = rawText.replace(/```json|```/g, "").trim();

      const parsed = JSON.parse(cleanedText);

      // Make sure we got the expected structure
      if (!["pass", "minor", "major"].includes(parsed.severity)) {
        throw new Error(`Invalid severity value: ${parsed.severity}`);
      }

      console.log(
        `[Reviewer] Verdict: "${parsed.severity}" | ` +
        `Issues found: ${parsed.issues?.length ?? 0}`
      );

      return {
        severity: parsed.severity,
        issues: Array.isArray(parsed.issues) ? parsed.issues : [],
        affectedSections: Array.isArray(parsed.affectedSections)
          ? parsed.affectedSections
          : [],
      };
    } catch (err) {
      // If the reviewer itself breaks, default to "pass" so we don't block responses
      console.warn(
        "[Reviewer] Review failed — defaulting to pass so we don't block output:",
        err.message
      );
      return SAFE_DEFAULT_PASS;
    }
  }
}

// Export a ready-to-use instance
export const reviewer = new ReviewerAgent();
