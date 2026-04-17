// ─────────────────────────────────────────────────────────────
// src/heuristicCheck.js
//
// WHAT THIS FILE DOES:
//   A quick, FREE quality check that runs BEFORE we call the
//   expensive reviewer AI. Uses simple code logic (no AI needed)
//   to catch obvious problems in AI responses.
//
// CHECKS PERFORMED:
//   1. CODE CHECK: If the prompt is about code, check the code
//      in the response for syntax errors
//   2. JSON CHECK: If the prompt asks for JSON, check if the
//      response actually contains valid JSON
//   3. ANSWER LENGTH CHECK: If the prompt is a short question,
//      make sure the response isn't suspiciously empty
//
// WHY THIS MATTERS:
//   If all checks pass → skip the reviewer AI entirely (saves money!)
//   If checks fail → send to the reviewer AI for deeper analysis
// ─────────────────────────────────────────────────────────────

/**
 * Run quick programmatic checks on an AI response.
 * No API calls, no tokens used — pure JavaScript logic.
 *
 * @param {string} prompt   - The original user question
 * @param {string} response - The AI's answer to check
 * @returns {Promise<{ passed: boolean, issues: string[] }>}
 */
export async function heuristicCheck(prompt, response) {
  const issues = []; // We'll collect any problems we find here
  const promptLower = prompt.toLowerCase();

  // ── Check 1: Code Validation ──────────────────────────────
  //
  // Conditions that trigger this check:
  //   - The prompt contains a fenced code block (```...```)
  //   - The prompt contains words like "run", "execute", or "code"
  //
  const promptHasCode = /```[\s\S]*?```/.test(prompt);
  const promptMentionsCode = /\b(run|execute|code)\b/.test(promptLower);

  if (promptHasCode || promptMentionsCode) {
    // Does the response contain a code block?
    const responseCodeMatch = response.match(/```(\w*)\n?([\s\S]*?)```/);

    if (responseCodeMatch) {
      const language = (responseCodeMatch[1] || "").toLowerCase();
      const codeContent = responseCodeMatch[2];

      // JavaScript syntax check using built-in Function constructor
      const isJavaScript = !language || language === "js" || language === "javascript";
      if (isJavaScript) {
        try {
          // This will throw a SyntaxError if the JS code is invalid
          new Function(codeContent);
        } catch (syntaxError) {
          issues.push(
            `JavaScript code block has a syntax error: ${syntaxError.message}`
          );
        }
      }

      // Python syntax check (simple heuristics — we can't run Python here)
      const isPython = language === "python" || language === "py";
      if (isPython) {
        const lines = codeContent.split("\n");

        // Check 1: Count brackets — they should balance to zero
        let openBrackets = 0;
        for (const line of lines) {
          for (const char of line) {
            if ("([{".includes(char)) openBrackets++;
            if (")]}".includes(char)) openBrackets--;
          }
        }
        if (openBrackets !== 0) {
          issues.push(
            `Python code has ${Math.abs(openBrackets)} unmatched bracket(s). ` +
            `${openBrackets > 0 ? "Too many opening" : "Too many closing"} brackets.`
          );
        }

        // Check 2: Lines ending with ":" should be followed by indented code
        for (let i = 0; i < lines.length - 1; i++) {
          const line = lines[i].trim();
          const nextLine = lines[i + 1];

          if (line.endsWith(":") && line.length > 1) {
            // The next line should be indented (has spaces or tab at start)
            if (nextLine && nextLine.length > 0 && !/^\s/.test(nextLine)) {
              issues.push(
                `Python code may have indentation error at line ${i + 2}: ` +
                `"${line}" should be followed by indented code.`
              );
              break; // Only report first indentation issue to avoid noise
            }
          }
        }
      }
    }
  }

  // ── Check 2: JSON Validation ──────────────────────────────
  //
  // Triggers if the prompt contains "json" or asks for structured output
  //
  const promptAsksForJson =
    /\bjson\b/.test(promptLower) ||
    /structured output|in json format|as json/.test(promptLower);

  if (promptAsksForJson) {
    // Try to find a JSON object or array in the response
    const jsonPattern = /\{[\s\S]*\}|\[[\s\S]*\]/;
    const jsonMatch = response.match(jsonPattern);

    if (jsonMatch) {
      try {
        JSON.parse(jsonMatch[0]);
        // If we get here, JSON is valid — no issue to add
      } catch (parseError) {
        issues.push(
          `Response contains malformed JSON that cannot be parsed: ${parseError.message}`
        );
      }
    } else {
      issues.push(
        "The prompt asked for JSON output but the response contains no JSON object or array."
      );
    }
  }

  // ── Check 3: Minimum Answer Length ───────────────────────
  //
  // Triggers if the prompt looks like a short direct question
  // (ends with "?", under 200 characters)
  //
  const isShortQuestion =
    prompt.trim().endsWith("?") && prompt.trim().length < 200;

  if (isShortQuestion) {
    const responseLength = response ? response.trim().length : 0;

    if (responseLength < 20) {
      issues.push(
        `The response to a direct question is too short ` +
        `(${responseLength} characters). Expected at least 20 characters.`
      );
    }
  }

  // ── Return result ─────────────────────────────────────────
  const passed = issues.length === 0;

  if (passed) {
    console.log("[HeuristicCheck] ✅ All checks passed.");
  } else {
    console.log(`[HeuristicCheck] ⚠️  Found ${issues.length} issue(s):`, issues);
  }

  return { passed, issues };
}
