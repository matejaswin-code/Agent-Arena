// ─────────────────────────────────────────────────────────────
// src/semanticCache.js
//
// THREE-LAYER CACHE SYSTEM:
//
//   Layer 1 — Exact Match (instant, zero API calls)
//     Normalises text (lowercase + collapse whitespace) and
//     checks an in-memory Map. Same prompt = instant hit.
//     Persisted across restarts via the entries file.
//
//   Layer 2 — Semantic Match via HuggingFace embeddings
//     Converts text to number vectors, compares with cosine
//     similarity. Catches "What is the capital of France?"
//     matching "Tell me France's capital city." (threshold 0.92)
//     Skipped gracefully when HF_API_KEY is missing or HF is down.
//
//   Layer 3 — Local Token Similarity fallback
//     Zero-API Jaccard similarity on word tokens. Catches
//     near-identical prompts even when HF is unavailable.
//     (threshold 0.85 — slightly looser than semantic layer)
//
// BUG THAT WAS FIXED:
//   Previously, when HF API failed (missing key, rate limit,
//   slow response), both get() and set() silently returned/
//   skipped — so the cache NEVER actually stored or served
//   anything. Now Layer 1 always runs regardless of HF status.
//
// DATA SAVED TO: ./data/semantic_cache.json
// ─────────────────────────────────────────────────────────────

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);

const DATA_DIR   = path.join(__dirname, "..", "data");
const CACHE_FILE = path.join(DATA_DIR, "semantic_cache.json");

// Similarity thresholds
const SEMANTIC_THRESHOLD = 0.92; // HuggingFace cosine similarity
const LOCAL_THRESHOLD    = 0.85; // Jaccard token similarity fallback

// ── Math helpers ──────────────────────────────────────────────

/**
 * Cosine similarity between two numeric vectors.
 * Returns 0.0 (totally different) → 1.0 (identical).
 */
function cosineSimilarity(vecA, vecB) {
  let dot = 0, magA = 0, magB = 0;
  for (let i = 0; i < vecA.length; i++) {
    dot  += vecA[i] * vecB[i];
    magA += vecA[i] * vecA[i];
    magB += vecB[i] * vecB[i];
  }
  if (magA === 0 || magB === 0) return 0;
  return dot / (Math.sqrt(magA) * Math.sqrt(magB));
}

/**
 * Jaccard similarity on word-token sets.
 * "hello world" vs "hello there world" → 2/3 ≈ 0.67
 * Used as a zero-API fallback when HuggingFace is unavailable.
 */
function jaccardSimilarity(textA, textB) {
  const tokenise = (t) => new Set(t.toLowerCase().match(/\b\w+\b/g) ?? []);
  const setA = tokenise(textA);
  const setB = tokenise(textB);

  if (setA.size === 0 && setB.size === 0) return 1;
  if (setA.size === 0 || setB.size === 0) return 0;

  const intersection = [...setA].filter((w) => setB.has(w)).length;
  const union = new Set([...setA, ...setB]).size;
  return intersection / union;
}

// ── Main class ────────────────────────────────────────────────
export class SemanticCache {
  /**
   * @param {number} [semanticThreshold=0.92] - HF cosine similarity threshold
   * @param {number} [localThreshold=0.85]    - Jaccard similarity threshold
   */
  constructor(semanticThreshold = SEMANTIC_THRESHOLD, localThreshold = LOCAL_THRESHOLD) {
    this.semanticThreshold = semanticThreshold;
    this.localThreshold    = localThreshold;

    // Layer 1: exact-match (normalised text → response)
    // Always available, zero API calls, rebuilt from disk on start
    this._exactCache = new Map();

    // Layer 2 + 3: entries with optional HF embeddings
    this.entries = []; // [{ prompt, normalised, embedding|null, response, storedAt }]

    this._loadFromDisk();
  }

  // ── Text normalisation ────────────────────────────────────

  /**
   * Normalise a prompt for consistent comparison.
   * Removes case differences and collapses whitespace.
   *
   * "  What IS  the capital of FRANCE? " → "what is the capital of france?"
   */
  _normalise(text) {
    return text.trim().toLowerCase().replace(/\s+/g, " ");
  }

  // ── Disk operations ───────────────────────────────────────

  _ensureDataDir() {
    if (!fs.existsSync(DATA_DIR)) {
      fs.mkdirSync(DATA_DIR, { recursive: true });
      console.log("[SemanticCache] Created ./data/ directory.");
    }
  }

  _loadFromDisk() {
    try {
      if (fs.existsSync(CACHE_FILE)) {
        const raw = fs.readFileSync(CACHE_FILE, "utf8");
        this.entries = JSON.parse(raw);

        // Rebuild the exact-match Map from stored entries
        // so Layer 1 works immediately after a server restart
        for (const entry of this.entries) {
          const key = entry.normalised ?? this._normalise(entry.prompt);
          this._exactCache.set(key, entry.response);
        }

        console.log(
          `[SemanticCache] Loaded ${this.entries.length} cached entries ` +
          `(${this._exactCache.size} in exact-match map).`
        );
      } else {
        console.log("[SemanticCache] No cache file yet — starting fresh.");
      }
    } catch (err) {
      console.warn("[SemanticCache] Could not read cache file (starting fresh):", err.message);
      this.entries     = [];
      this._exactCache = new Map();
    }
  }

  _saveToDisk() {
    try {
      this._ensureDataDir();
      fs.writeFileSync(CACHE_FILE, JSON.stringify(this.entries, null, 2), "utf8");
    } catch (err) {
      console.warn("[SemanticCache] Could not save cache to disk:", err.message);
    }
  }

  // ── HuggingFace embedding (Layer 2) ──────────────────────

  /**
   * Convert text to a numeric vector via the HuggingFace Inference API.
   * Returns null (rather than throwing) when unavailable — callers fall
   * through to Layer 3.
   */
  async _getEmbedding(text) {
    if (!process.env.HF_API_KEY) {
      // Key not configured — skip silently
      return null;
    }

    try {
      const response = await fetch(
        "https://api-inference.huggingface.co/pipeline/feature-extraction/sentence-transformers/all-MiniLM-L6-v2",
        {
          method:  "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization:  `Bearer ${process.env.HF_API_KEY}`,
          },
          body:    JSON.stringify({ inputs: text }),
          signal:  AbortSignal.timeout(8000), // 8-second hard timeout
        }
      );

      if (!response.ok) {
        console.warn(`[SemanticCache] HF API returned ${response.status} — skipping embedding.`);
        return null;
      }

      const data = await response.json();
      // The API returns [[0.1, 0.2, ...]] — flatten to [0.1, 0.2, ...]
      return Array.isArray(data[0]) ? data[0] : data.flat();
    } catch (err) {
      console.warn("[SemanticCache] HF embedding failed — falling back to local similarity:", err.message);
      return null;
    }
  }

  // ── Public API ────────────────────────────────────────────

  /**
   * Look up a prompt across all three layers.
   * Returns the cached response string, or null on a miss.
   *
   * @param {string} promptText
   * @returns {Promise<string|null>}
   */
  async get(promptText) {
    const normalised = this._normalise(promptText);

    // ── Layer 1: Exact match (zero API calls, always runs) ──
    if (this._exactCache.has(normalised)) {
      console.log("[SemanticCache] ⚡ Layer 1 HIT — exact match.");
      return this._exactCache.get(normalised);
    }

    // ── Layer 2: HuggingFace semantic similarity ────────────
    if (this.entries.length > 0) {
      const embedding = await this._getEmbedding(promptText);

      if (embedding !== null) {
        // Compare against entries that have embeddings
        let bestScore = -1;
        let bestEntry = null;

        for (const entry of this.entries) {
          if (!entry.embedding) continue;
          const score = cosineSimilarity(embedding, entry.embedding);
          if (score > bestScore) {
            bestScore = score;
            bestEntry = entry;
          }
        }

        if (bestScore >= this.semanticThreshold) {
          console.log(
            `[SemanticCache] ✅ Layer 2 HIT — semantic similarity ${(bestScore * 100).toFixed(1)}%.`
          );
          return bestEntry.response;
        }

        console.log(
          `[SemanticCache] Layer 2 miss — best semantic score: ${(bestScore * 100).toFixed(1)}%.`
        );
      }

      // ── Layer 3: Local Jaccard token similarity ───────────
      // Runs when HF is unavailable OR semantic score was too low
      let bestLocal = -1;
      let bestLocalEntry = null;

      for (const entry of this.entries) {
        const score = jaccardSimilarity(normalised, entry.normalised ?? this._normalise(entry.prompt));
        if (score > bestLocal) {
          bestLocal      = score;
          bestLocalEntry = entry;
        }
      }

      if (bestLocal >= this.localThreshold) {
        console.log(
          `[SemanticCache] ✅ Layer 3 HIT — local similarity ${(bestLocal * 100).toFixed(1)}%.`
        );
        return bestLocalEntry.response;
      }

      console.log(
        `[SemanticCache] ❌ All layers missed. Best local: ${(bestLocal * 100).toFixed(1)}%.`
      );
    }

    return null;
  }

  /**
   * Store a new prompt-response pair.
   * Always writes to the exact-match layer immediately, then
   * attempts to add an HF embedding for the semantic layer.
   *
   * @param {string} promptText
   * @param {string} responseText
   */
  async set(promptText, responseText) {
    const normalised = this._normalise(promptText);

    // ── Layer 1: always store in exact-match map right now ──
    this._exactCache.set(normalised, responseText);
    console.log("[SemanticCache] ⚡ Added to exact-match layer.");

    // ── Try to get an HF embedding for Layer 2 ─────────────
    let embedding = null;
    try {
      embedding = await this._getEmbedding(promptText);
    } catch {
      // Already logged inside _getEmbedding — just proceed without it
    }

    // Store full entry (embedding may be null — that's fine for Layer 3)
    this.entries.push({
      prompt:    promptText,
      normalised,
      embedding, // null when HF unavailable — Jaccard still works
      response:  responseText,
      storedAt:  new Date().toISOString(),
    });

    this._saveToDisk();
    console.log(
      `[SemanticCache] Stored entry (embedding: ${embedding ? "yes" : "no — local only"}). ` +
      `Cache size: ${this.entries.length}.`
    );
  }

  /**
   * Clear all cached entries (in memory and on disk).
   * Useful for testing or manual cache invalidation.
   */
  clear() {
    this._exactCache.clear();
    this.entries = [];
    this._saveToDisk();
    console.log("[SemanticCache] Cache cleared.");
  }

  /** How many entries are currently cached. */
  get size() {
    return this.entries.length;
  }
}

// Export a ready-to-use instance
export const semanticCache = new SemanticCache();
