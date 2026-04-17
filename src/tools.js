// ─────────────────────────────────────────────────────────────
// src/tools.js
// All tool definitions live here. Each tool is a factory that
// returns an async function bound to agent config.
// Tools must NEVER throw — they catch internally and return a
// structured result so the parent Promise is never rejected.
// ─────────────────────────────────────────────────────────────

// --- TOOL DEFINITIONS ---

import { runCode as sandboxRunCode, detectLanguage } from "./sandbox.js";

// ── Shared utilities ──────────────────────────────────────────

/**
 * Standardised fallback message for unsupported capabilities.
 * @param {string} toolName
 * @returns {string}
 */
const unsupportedMsg = (toolName) =>
  `${toolName} is not supported by this model/API.`;

/**
 * Classify an HTTP/API error as "unsupported capability" vs real error.
 * Covers 400 Bad Request, 422 Unprocessable Entity, and common text patterns
 * from providers like OpenAI, Anthropic, Replicate, etc.
 */
function isCapabilityError(err) {
  const status = err?.status ?? err?.statusCode ?? err?.response?.status;
  if (status === 400 || status === 422) return true;

  const msg = (err?.message ?? "").toLowerCase();
  const capabilityKeywords = [
    "not supported",
    "unsupported",
    "does not support",
    "cannot process",
    "invalid_request",
    "model does not",
    "no vision",
    "no image",
    "capability",
  ];
  return capabilityKeywords.some((kw) => msg.includes(kw));
}

/**
 * POST helper that normalises response errors into thrown Error objects
 * with a `.status` property, making them compatible with isCapabilityError().
 */
async function apiPost(url, apiKey, body) {
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    const err = new Error(
      `API error ${res.status}: ${text.slice(0, 200)}`
    );
    err.status = res.status;
    throw err;
  }

  return res.json();
}

// ── Tool: readImage ───────────────────────────────────────────

/**
 * Attempts to analyse an image URL using vision-capable models
 * (OpenAI-style messages API with image_url content).
 *
 * @param {object} config – agent config
 * @returns {(imageUrl: string, prompt?: string) => Promise<string>}
 */
export function makeReadImageTool(config) {
  return async function readImage(imageUrl, prompt = "Describe this image.") {
    try {
      const data = await apiPost(
        `${config.baseURL}/chat/completions`,
        config.apiKey,
        {
          model: config.modelName,
          messages: [
            {
              role: "user",
              content: [
                { type: "image_url", image_url: { url: imageUrl } },
                { type: "text", text: prompt },
              ],
            },
          ],
          max_tokens: config.maxTokens ?? 512,
          ...config.modelOptions,
        }
      );

      return data.choices?.[0]?.message?.content ?? "No response from model.";
    } catch (err) {
      if (isCapabilityError(err)) return unsupportedMsg("readImage");
      // Re-package unexpected errors as a soft message — do not rethrow
      return `readImage encountered an error: ${err.message}`;
    }
  };
}

// ── Tool: readVideo ───────────────────────────────────────────

/**
 * Attempts video understanding via a vendor-specific endpoint.
 * Most standard LLM APIs don't support this; the fallback fires immediately
 * for any 4xx or "unsupported" message.
 *
 * @param {object} config
 * @returns {(videoUrl: string, prompt?: string) => Promise<string>}
 */
export function makeReadVideoTool(config) {
  return async function readVideo(videoUrl, prompt = "Summarise this video.") {
    try {
      // Attempt using OpenAI-style API with a video URL.
      // Most models will reject this with 400/422.
      const data = await apiPost(
        `${config.baseURL}/chat/completions`,
        config.apiKey,
        {
          model: config.modelName,
          messages: [
            {
              role: "user",
              content: [
                {
                  type: "video_url",
                  video_url: { url: videoUrl },
                },
                { type: "text", text: prompt },
              ],
            },
          ],
          max_tokens: config.maxTokens ?? 512,
          ...config.modelOptions,
        }
      );

      return data.choices?.[0]?.message?.content ?? "No response from model.";
    } catch (err) {
      if (isCapabilityError(err)) return unsupportedMsg("readVideo");
      return `readVideo encountered an error: ${err.message}`;
    }
  };
}

// ── Tool: generateImage ───────────────────────────────────────

/**
 * Attempts image generation via /images/generations (OpenAI DALL-E style).
 * Text-only models return a capability fallback.
 *
 * @param {object} config
 * @returns {(prompt: string) => Promise<string>}
 */
export function makeGenerateImageTool(config) {
  return async function generateImage(prompt) {
    try {
      const data = await apiPost(
        `${config.baseURL}/images/generations`,
        config.apiKey,
        {
          model: config.modelName,
          prompt,
          n: 1,
          size: config.imageSize ?? "1024x1024",
          response_format: "url",
          ...config.modelOptions,
        }
      );

      const url = data.data?.[0]?.url;
      return url ? `Generated image URL: ${url}` : "Image generated but no URL returned.";
    } catch (err) {
      if (isCapabilityError(err)) return unsupportedMsg("generateImage");
      return `generateImage encountered an error: ${err.message}`;
    }
  };
}

// ── Tool: generateVideo ───────────────────────────────────────

/**
 * Stubs a video generation request (e.g. Runway, Sora, Luma endpoints).
 * Standard LLM APIs will always return a capability fallback here —
 * this is intentional; real integrations hook in via config.videoEndpoint.
 *
 * @param {object} config
 * @returns {(prompt: string) => Promise<string>}
 */
export function makeGenerateVideoTool(config) {
  return async function generateVideo(prompt) {
    try {
      // Use a custom video endpoint if provided in config, otherwise
      // hit the model's base API which will almost certainly 4xx.
      const endpoint =
        config.videoEndpoint ?? `${config.baseURL}/video/generations`;

      const data = await apiPost(endpoint, config.apiKey, {
        model: config.modelName,
        prompt,
        duration_seconds: config.videoDuration ?? 5,
        ...config.modelOptions,
      });

      const url = data?.video_url ?? data?.data?.[0]?.url;
      return url ? `Generated video URL: ${url}` : "Video generated but no URL returned.";
    } catch (err) {
      if (isCapabilityError(err)) return unsupportedMsg("generateVideo");
      return `generateVideo encountered an error: ${err.message}`;
    }
  };
}

// ── Tool: runCode ─────────────────────────────────────────────

/**
 * Detects code blocks in a prompt and executes them in an appropriate sandbox.
 * Supports JavaScript (vm module, isolated) and Python (child_process).
 *
 * Extraction logic:
 *   1. Fenced code blocks (```lang ... ```)
 *   2. Indented blocks (4-space / tab)
 *   3. Bare snippet if nothing else found
 *
 * @param {object} config
 * @returns {(prompt: string) => Promise<string>}
 */
export function makeRunCodeTool(config) {
  return async function runCode(prompt) {
    try {
      // ── Extract code from prompt ──────────────────────────
      let code = null;
      let langHint = null;

      // 1. Fenced block: ```lang\n...\n```
      const fenced = prompt.match(/```(\w*)\n([\s\S]*?)```/);
      if (fenced) {
        langHint = fenced[1] || null;
        code = fenced[2].trim();
      }

      // 2. Indented block (4 spaces or tab)
      if (!code) {
        const lines = prompt.split("\n");
        const indented = lines
          .filter((l) => l.startsWith("    ") || l.startsWith("\t"))
          .map((l) => l.replace(/^(\t| {4})/, ""));
        if (indented.length > 0) code = indented.join("\n");
      }

      // 3. Fall back to the whole prompt as raw snippet
      if (!code) code = prompt.trim();

      // ── Execute ───────────────────────────────────────────
      const result = await sandboxRunCode(code, langHint ?? undefined);

      const parts = [`Language: ${result.language}`];
      if (result.stdout) parts.push(`stdout:\n${result.stdout}`);
      if (result.stderr) parts.push(`stderr:\n${result.stderr}`);
      parts.push(`Exit code: ${result.exitCode}`);

      return parts.join("\n\n");
    } catch (err) {
      // Sandbox itself should never throw, but belt-and-suspenders
      return `runCode encountered an unexpected error: ${err.message}`;
    }
  };
}

// ── Tool registry ─────────────────────────────────────────────

/**
 * All known tool names. Used for validation and enabledTools filtering.
 */
export const KNOWN_TOOLS = [
  "readImage",
  "readVideo",
  "generateImage",
  "generateVideo",
  "runCode",
];

/**
 * Build the full tool map for a given config.
 * Only tools listed in config.enabledTools (or ALL if omitted) are included.
 *
 * @param {object} config
 * @returns {Record<string, Function>}
 */
export function buildToolMap(config) {
  const allowed = config.enabledTools
    ? new Set(config.enabledTools)
    : new Set(KNOWN_TOOLS);

  const allTools = {
    readImage: makeReadImageTool(config),
    readVideo: makeReadVideoTool(config),
    generateImage: makeGenerateImageTool(config),
    generateVideo: makeGenerateVideoTool(config),
    runCode: makeRunCodeTool(config),
  };

  return Object.fromEntries(
    Object.entries(allTools).filter(([name]) => allowed.has(name))
  );
}

// ── Code-prompt detector ──────────────────────────────────────

/**
 * Heuristic: returns true if the prompt appears to involve programming.
 * Used to auto-route to runCode when appropriate.
 */
export function isCodePrompt(prompt) {
  const codeSignals = [
    /```[\s\S]*?```/.test(prompt),                         // fenced block
    /\bdef \w+\(|\bfunction\b|\bconst\b|\blet\b/.test(prompt), // code syntax
    /console\.log|print\s*\(|System\.out/.test(prompt),    // common output calls
    /run (this|the|my) code/i.test(prompt),
    /execute (this|the|my)/i.test(prompt),
    /what (does|will) this (code|script|program)/i.test(prompt),
    /debug (this|my)/i.test(prompt),
  ];
  return codeSignals.some(Boolean);
}
