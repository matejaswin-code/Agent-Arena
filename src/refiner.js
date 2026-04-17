// ─────────────────────────────────────────────────────────────
// src/refiner.js
//
// WHAT THIS FILE DOES:
//   Improves text quality at two points in the pipeline:
//
//   1. BEFORE sending to AI: Rewrites vague user prompts
//      to be clearer and more specific
//
//   2. AFTER getting a response: Cleans up the formatting
//      and readability of the AI's answer
//
// EXAMPLE — Prompt Refinement:
//   Original: "explain python"
//   Refined:  "Please provide a beginner-friendly explanation of
//              the Python programming language, including its main
//              use cases and key features."
//
// EXAMPLE — Answer Refinement:
//   Original: messy response with inconsistent formatting
//   Refined:  same content but with clean headings, proper spacing
//
// USES: Groq's fast, free API
// ─────────────────────────────────────────────────────────────

const GROQ_API_URL = "https://api.groq.com/openai/v1/chat/completions";
const GROQ_MODEL = "llama-3.1-8b-instant";

// ── Helper function to call Groq API ─────────────────────────
/**
 * Makes a single call to the Groq API.
 * Used internally by both refinePrompt and refineAnswer.
 */
async function callGroq(systemPrompt, userContent) {
  const response = await fetch(GROQ_API_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${process.env.GROQ_API_KEY}`,
    },
    body: JSON.stringify({
      model: GROQ_MODEL,
      max_tokens: 1000,
      temperature: 0.3, // Some creativity but mostly consistent
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userContent },
      ],
    }),
  });

  if (!response.ok) {
    throw new Error(`Groq API returned status ${response.status}`);
  }

  const data = await response.json();
  return data.choices?.[0]?.message?.content?.trim() ?? "";
}

// ── RefinerAgent class ────────────────────────────────────────
export class RefinerAgent {
  /**
   * Rewrite a user's raw prompt to be clearer and more specific.
   *
   * If refinement fails for any reason, returns the original
   * prompt unchanged — we never lose the user's question.
   *
   * @param {string} rawPrompt - The user's original input
   * @returns {Promise<string>} - The improved prompt (or original if error)
   */
  async refinePrompt(rawPrompt) {
    const systemPrompt = `You are a prompt engineer. Rewrite the user's input to be clearer, 
more specific, and unambiguous. Fix grammar, add missing context, and make the intent obvious.

IMPORTANT: Return ONLY the rewritten prompt. 
No explanation, no preamble, no "Here is the rewritten prompt:", nothing else.
Just the rewritten prompt text and nothing more.`;

    try {
      const refined = await callGroq(systemPrompt, rawPrompt);

      // Safety check: if the AI returned something empty, use the original
      if (!refined || refined.length < 5) {
        console.log("[Refiner] Prompt refinement returned empty — using original.");
        return rawPrompt;
      }

      console.log(
        `[Refiner] Prompt refined: ${rawPrompt.length} chars → ${refined.length} chars`
      );
      return refined;
    } catch (err) {
      console.warn(
        "[Refiner] refinePrompt() failed — using original prompt:",
        err.message
      );
      return rawPrompt; // Always fall back to original
    }
  }

  /**
   * Improve the formatting and readability of an AI answer.
   * IMPORTANT: This does NOT change the factual content.
   * It only makes the existing content easier to read.
   *
   * @param {string} originalPrompt - The user's question (for context)
   * @param {string} rawAnswer      - The AI's answer to improve
   * @returns {Promise<string>}     - The formatted answer (or original if error)
   */
  async refineAnswer(originalPrompt, rawAnswer) {
    const systemPrompt = `You are a text formatter. Improve the formatting, readability, 
and clarity of the answer below. 

Rules you MUST follow:
- Do NOT change any facts, numbers, or technical information
- Do NOT add new information that wasn't in the original answer
- Do NOT remove any important information from the original answer
- DO fix inconsistent formatting (headings, bullet points, spacing)
- DO improve paragraph structure and flow
- DO fix grammar and spelling errors

IMPORTANT: Return ONLY the improved answer.
No preamble, no "Here is the improved version:", nothing else.
Just the improved answer and nothing more.`;

    const userContent =
      `Original question (for context): ${originalPrompt}\n\n` +
      `Answer to improve:\n${rawAnswer}`;

    try {
      const refined = await callGroq(systemPrompt, userContent);

      if (!refined || refined.length < 5) {
        console.log("[Refiner] Answer refinement returned empty — using original.");
        return rawAnswer;
      }

      console.log(
        `[Refiner] Answer refined: ${rawAnswer.length} chars → ${refined.length} chars`
      );
      return refined;
    } catch (err) {
      console.warn(
        "[Refiner] refineAnswer() failed — using original answer:",
        err.message
      );
      return rawAnswer; // Always fall back to original
    }
  }
}

// Export a ready-to-use instance
export const refiner = new RefinerAgent();
