import { TIER_NAMES, THRESHOLDS, OVERRIDE_PATTERNS, rankOf } from "./config.ts";

/** The tier the user named explicitly in the prompt, or null. */
export function detectOverride(prompt: string | null | undefined) {
  const hit = OVERRIDE_PATTERNS.find((p) => p.re.test(prompt ?? ""));
  return hit ? hit.tier : null;
}

/**
 * Nearest tier the session can actually run. Prefers stepping up rather than down so we
 * never silently hand a hard task to a weaker model.
 */
function clampToAvailable(tier: string, available: string[]) {
  if (available.includes(tier)) return tier;
  const rank = rankOf(tier);
  const up = TIER_NAMES.filter((t) => rankOf(t) > rank && available.includes(t));
  if (up.length) return up[0];
  const down = TIER_NAMES.filter((t) => rankOf(t) < rank && available.includes(t));
  return down.length ? down[down.length - 1] : null;
}

/**
 * Turns a Jev answer into the model we will actually run. Pure and total: any missing,
 * malformed, or unavailable input falls back to the model already in use.
 *
 * @param input
 * @param input.prompt        raw user prompt, for explicit-override detection
 * @param input.jev           null when Jev failed
 * @param input.current       tier currently active in the session (null if pi is on a
 *                            model outside the tier ladder, e.g. another provider)
 * @param input.available     tier names resolvable and authenticated in this session
 * @param input.contextTokens approximate size of the conversation so far
 * @param input.needsVision   the prompt carries images
 * @param input.visionTiers   subset of `available` that accepts image input
 * @returns {{tier: string, reason: string, changed: boolean}}
 */
export function decide({
  prompt,
  jev,
  current,
  available,
  contextTokens = 0,
  needsVision = false,
  visionTiers = [],
}: {
  prompt: string | null | undefined;
  jev: { choice: string; confidence: number } | null;
  current: string | null;
  available: string[];
  contextTokens?: number;
  needsVision?: boolean;
  visionTiers?: string[];
}): { tier: string; reason: string; changed: boolean } {
  const settle = (tier: string, reason: string) => {
    let final = clampToAvailable(tier, available);
    let why = final === tier ? reason : `${reason}+unavailable`;
    if (final === null) {
      return { tier: current ?? tier, reason: `${why}/unavailable`, changed: false };
    }
    if (needsVision && !visionTiers.includes(final)) {
      const rank = rankOf(final);
      const up = TIER_NAMES.filter((t) => rankOf(t) >= rank && visionTiers.includes(t));
      if (up.length) {
        final = up[0];
        why += "+vision";
      } else {
        return { tier: current ?? final, reason: "vision-unavailable", changed: false };
      }
    }
    const unchanged = current !== null && final === current;
    return {
      tier: final,
      reason: unchanged ? `${why}/no-change` : why,
      changed: !unchanged,
    };
  };

  const override = detectOverride(prompt);
  if (override) return settle(override, "override");

  if (!jev || !TIER_NAMES.includes(jev.choice)) return settle(current ?? "pro", "jev-unavailable");

  let target = jev.choice;

  if (jev.confidence < THRESHOLDS.minConfidence) {
    const currentRank = current === null ? Number.POSITIVE_INFINITY : rankOf(current);
    if (rankOf(target) < currentRank) return settle(current ?? target, "low-confidence-no-downgrade");
    const ceiling = Math.max(currentRank, rankOf(THRESHOLDS.uncertainCeiling));
    if (rankOf(target) > ceiling) return settle(TIER_NAMES[ceiling], "low-confidence-capped");
  }

  if (
    current !== null &&
    rankOf(target) < rankOf(current) &&
    contextTokens > THRESHOLDS.downgradeMaxContextTokens
  ) {
    return settle(current, "downgrade-not-worth-cache-rebuild");
  }

  return settle(target, "jev");
}
