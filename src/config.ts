// Every routing decision knob lives here, so the whole policy is reviewable in one file.
// Ported from jev-router (Claude Code) to pi + z.ai GLM models.
import { choice } from "@typesafe-ai/sdk";

/**
 * Model tiers, cheapest first. `id` is the model id in the z.ai catalog pi ships built in
 * (provider `zai`, the global coding plan; set JEV_PROVIDER=zai-coding-cn for the China
 * plan, which carries the same ids). Tiers are chosen by price then capability:
 *
 *   glm-5.3-flash  $0.075/$0.25  cheapest, 1M context, fast distilled reasoning, vision
 *   glm-4.7        $0.60/$2.20   cheap classic generation
 *   glm-5.2        $1.40/$4.40   strong frontier model
 *   glm-5.3        $1.40/$4.40   strongest reasoning, always thinks (never "off")
 */
export interface TierSpec {
  /** Abstract tier name, used in policy decisions, logs and the widget. */
  name: string;
  /** Model id passed to the API and used to recognise the model pi selected. */
  id: string;
  /** Whether the model accepts image input. */
  vision: boolean;
}

export const TIERS: TierSpec[] = [
  { name: "air", id: "glm-5.3-flash", vision: true },
  { name: "core", id: "glm-4.7", vision: false },
  { name: "pro", id: "glm-5.2", vision: false },
  { name: "max", id: "glm-5.3", vision: false },
];

export const TIER_NAMES = TIERS.map((t) => t.name);

export const rankOf = (name: string) => TIER_NAMES.indexOf(name);

export const idOf = (name: string) => TIERS.find((t) => t.name === name)?.id;

export const tierSpec = (name: string) => TIERS.find((t) => t.name === name);

/** z.ai provider whose catalog the tiers resolve against. */
export const providerId = () => process.env.JEV_PROVIDER ?? "zai";

/**
 * Tier name for a model id pi is using, or null if we don't recognise it. Compared
 * case-insensitively against the full tier id, which is exact in pi's z.ai catalogs.
 */
export const tierOf = (model: string | undefined | null) =>
  TIERS.find(
    (t) => typeof model === "string" && model.toLowerCase().includes(t.id.toLowerCase()),
  )?.name ?? null;

export const THRESHOLDS = {
  /** Below this Jev confidence we refuse to downgrade and cap upgrades at `uncertainCeiling`. */
  minConfidence: 0.6,
  /** Safest tier to land on when Jev is unsure. */
  uncertainCeiling: "pro",
  /**
   * Switching models invalidates the provider's prompt cache; the next turn re-sends the
   * whole conversation. A downgrade only pays off while the conversation is still small.
   */
  downgradeMaxContextTokens: 20000,
  /**
   * Per-attempt Jev HTTP timeout and the hard wall-clock deadline for the whole routing
   * call. Measured on the Claude Code port: ~300-350ms warm, ~900-1000ms cold (TLS), so
   * the deadline leaves room for one retry after a cold-start timeout.
   */
  jevTimeoutMs: 1500,
  jevDeadlineMs: 3000,
  jevMaxRetries: 1,
};

/**
 * Phrases that mean "the human already decided", checked against the raw prompt. Each tier
 * matches both its abstract name ("use pro") and its concrete model id ("switch to
 * glm-5.3-flash"), with -, . or spaces as separators.
 */
const aliasPattern = (id: string) =>
  id
    .split(/[^a-z0-9.]+/i)
    .filter(Boolean)
    .map((part) => part.replace(/\./g, "\\."))
    .join("[-. ]?");

export const OVERRIDE_PATTERNS = TIERS.map((t) => ({
  tier: t.name,
  re: new RegExp(
    `\\b(?:use|switch to|with|on)\\s+(?:the\\s+)?(?:${t.name}|${aliasPattern(t.id)})\\b`,
    "i",
  ),
}));

export const QUESTIONS = {
  model_tier: choice(
    [
      "Pick the cheapest GLM model tier that can fully complete this coding request in one pass, without a retry on a stronger model.",
      "Judge the reasoning the request demands, not the length of the reply it asks for. A request that wants a one-line answer to a hard debugging or design question still needs a strong model; a request for a long but mechanical edit does not.",
    ],
    {
      air: {
        what: "Trivial, mechanical, or purely factual work.",
        signals: [
          "Rename a symbol, fix a typo, reformat, add a comment",
          "Answer a short factual question about a known file",
          "Run one obvious command and report the output",
        ],
        not_for: "Anything requiring design judgement or multi-file reasoning.",
      },
      core: {
        what: "Ordinary day-to-day engineering with a clear, bounded shape.",
        signals: [
          "Implement a well-specified function, endpoint, or component",
          "Write or fix tests for existing behaviour",
          "Localised bug fix where the cause is already understood",
        ],
        not_for: "Open-ended architecture, subtle concurrency, or deep unknown-cause debugging.",
      },
      pro: {
        what: "Hard reasoning, ambiguity, or high blast radius.",
        signals: [
          "Debug a failure whose cause is unknown",
          "Design or refactor across several modules",
          "Security, auth, concurrency, data-migration, or money-handling logic",
        ],
        not_for: "Work that a competent mid-level engineer would finish without thinking hard.",
      },
      max: {
        what: "Very large or very long-running tasks that exceed the others' practical reach.",
        signals: [
          "Whole-repo migration or framework upgrade",
          "Task requiring an unusually large amount of context to be held at once",
          "Long autonomous multi-hour execution",
        ],
        not_for: "Anything a single focused session on pro would finish.",
      },
    },
  ),
};
