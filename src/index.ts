/**
 * Jev Router for pi — automatic model routing across z.ai GLM models.
 *
 * Port of jev-router (Claude Code) to pi. Instead of an ANTHROPIC_BASE_URL proxy, this is
 * a native extension: on each new user prompt it asks Jev which GLM tier the turn needs
 * and switches the session model with pi.setModel() before the agent loop starts.
 *
 *   user prompt -> before_agent_start -> Jev: which tier? -> decide() -> pi.setModel()
 *
 * Routing rules (src/policy.ts, unchanged in spirit from the Claude Code port):
 *   - an explicit "use pro" in the message wins outright;
 *   - a Jev failure, timeout or unrecognised answer keeps the current model;
 *   - a low-confidence answer never downgrades, and caps upgrades at `pro`;
 *   - a downgrade is refused once the conversation is large (prompt-cache rebuild);
 *   - the tier is clamped to what is available and authenticated.
 *
 * Modes: the startup default comes from JEV_DEFAULT_MODE in ~/.jev-pi.env (`on` enables
 * routing, unset/anything else keeps it off); /jev (or /jev on) opts in to `auto`, which
 * routes every settled turn; picking a model yourself (/model, Ctrl+P) flips to `manual`
 * and Jev stands down; /jev off turns routing off again. The chosen mode persists across
 * resume. The mode and the last decision are visible in a widget above the editor.
 */
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { Model } from "@earendil-works/pi-ai";
import { TIERS, TIER_NAMES, tierOf, tierSpec } from "./config.ts";
import { askJev } from "./router.ts";
import { decide } from "./policy.ts";
import { loadEnvFiles, jevApiKey, jevDefaultMode } from "./env.ts";
import { debug } from "./log.ts";

type Mode = "auto" | "manual" | "off";

const MODE_ENTRY = "jev-mode";
const WIDGET_KEY = "jev-router";

interface LastDecision {
  tier: string;
  confidence: number | null;
  reason: string;
}

export default function (pi: ExtensionAPI) {
  loadEnvFiles();

  // Startup default is configurable (JEV_DEFAULT_MODE), opt-in unless switched on; the
  // session_start handler applies it and lets a persisted mode override.
  let mode: Mode = jevApiKey() && jevDefaultMode() === "auto" ? "auto" : "off";
  let last: LastDecision | null = null;
  // Only route when the previous agent run fully settled, so queued steers/follow-ups
  // within one task keep the tier pinned for that task (mirrors the proxy's turn pinning).
  let settled = true;
  // Guards model_select: our own pi.setModel() emissions must not read as user choices.
  let selfSwitch = false;
  let warnedNoAuth = false;

  const hasKey = () => Boolean(jevApiKey());

  function renderWidget(ctx: ExtensionContext) {
    if (!ctx.hasUI) return;
    if (mode === "off") {
      ctx.ui.setWidget(WIDGET_KEY, [
        hasKey() ? "jev: off — /jev to enable routing" : "jev: off — put JEV_API_KEY in ~/.jev-pi.env, then /jev",
      ]);
    } else if (mode === "manual") {
      ctx.ui.setWidget(WIDGET_KEY, [`⏸ jev manual · ${ctx.model?.id ?? "?"}`]);
    } else {
      const p = last?.confidence != null ? ` p=${last.confidence.toFixed(2)}` : "";
      // Only name the reason when routing declined to do the obvious thing.
      const head = last?.reason?.split("/")[0] ?? "";
      const held = last && head !== "jev" && head !== "override";
      const why = held ? ` (${head})` : "";
      ctx.ui.setWidget(WIDGET_KEY, [`⚡ jev ${last?.tier ?? "…"}${p}${why}`]);
    }
  }

  function persistMode() {
    try {
      pi.appendEntry(MODE_ENTRY, { mode });
    } catch {
      // Persistence is best-effort; routing still works without it.
    }
  }

  function setMode(next: Mode, ctx: ExtensionContext) {
    if (mode !== next) {
      mode = next;
      persistMode();
    }
    renderWidget(ctx);
  }

  pi.on("session_start", async (_event, ctx) => {
    // Reload/fork/new start from the configured default (JEV_DEFAULT_MODE, off unless
    // switched on); a resumed session restores the mode the user left off in, which wins
    // over the env default. A missing Jev key always forces "off".
    mode = hasKey() ? jevDefaultMode() : "off";
    last = null;
    try {
      for (const entry of ctx.sessionManager.getEntries()) {
        if (entry.type === "custom" && entry.customType === MODE_ENTRY) {
          const saved = (entry.data as { mode?: Mode } | undefined)?.mode;
          if (saved === "auto" || saved === "manual" || saved === "off") mode = saved;
        }
      }
    } catch {
      // No readable session yet; keep the default.
    }
    if (!hasKey()) mode = "off";
    renderWidget(ctx);
  });

  pi.on("agent_settled", async () => {
    settled = true;
  });

  pi.on("model_select", async (event, ctx) => {
    if (selfSwitch) return; // our own routing switch, not a user choice
    if (event.source === "restore") {
      renderWidget(ctx); // session restore: keep the persisted mode
      return;
    }
    if (mode === "auto") {
      debug(`user picked ${event.model.provider}/${event.model.id}, standing down`);
      setMode("manual", ctx);
      if (ctx.hasUI) ctx.ui.notify("Jev Router standing down — manual model chosen", "info");
    } else {
      renderWidget(ctx);
    }
  });

  pi.on("before_agent_start", async (event, ctx) => {
    if (mode !== "auto") return;
    const prompt = event.prompt?.trim();
    if (!prompt) return;

    if (!settled) {
      debug("mid-task continuation, tier stays pinned");
      return;
    }
    settled = false;

    const registry = ctx.modelRegistry;
    const provider = process.env.JEV_PROVIDER ?? "zai";

    // Tiers this session can actually run: present in the catalog and authenticated.
    const runnable = TIERS.filter((t) => {
      const model = registry.find(provider, t.id);
      return model ? registry.hasConfiguredAuth(model) : false;
    });
    const available = runnable.map((t) => t.name);
    if (available.length === 0) {
      if (!warnedNoAuth && ctx.hasUI) {
        warnedNoAuth = true;
        ctx.ui.notify(
          "Jev Router: no authenticated z.ai model found — set ZAI_API_KEY or /login zai",
          "warning",
        );
      }
      return;
    }

    const currentModel = ctx.model;
    const current = tierOf(currentModel?.id);
    const needsVision = (event.images?.length ?? 0) > 0;
    const visionTiers = runnable.filter((t) => t.vision).map((t) => t.name);

    let contextTokens = ctx.getContextUsage()?.tokens;
    if (contextTokens == null) {
      try {
        contextTokens = Math.round(JSON.stringify(ctx.sessionManager.getBranch()).length / 4);
      } catch {
        contextTokens = 0;
      }
    }

    const jev = await askJev({
      prompt,
      current: current ?? currentModel?.id ?? "unknown",
      contextTokens,
      available,
    });
    const { tier, reason } = decide({
      prompt,
      jev,
      current,
      available,
      contextTokens,
      needsVision,
      visionTiers,
    });

    last = { tier, confidence: jev?.confidence ?? null, reason };
    debug(
      `${jev ? `${jev.ms}ms p=${(jev.confidence ?? 0).toFixed(2)}` : "no-jev"} ` +
        `${current ?? currentModel?.id ?? "unknown"} -> ${tier} (${reason}) ctx~${contextTokens} | ${prompt.slice(0, 60)}`,
    );

    const spec = tierSpec(tier);
    const target = spec ? registry.find(provider, spec.id) : undefined;
    if (!target) {
      debug(`tier ${tier} not in catalog, keeping ${currentModel?.id ?? "current"}`);
      renderWidget(ctx);
      return;
    }
    if (currentModel && target.id === currentModel.id && target.provider === currentModel.provider) {
      renderWidget(ctx); // already on it
      return;
    }

    selfSwitch = true;
    let ok = false;
    try {
      ok = await pi.setModel(target as Model);
    } finally {
      selfSwitch = false;
    }
    if (!ok) {
      debug(`setModel to ${spec?.id} refused (no auth?), keeping current`);
      last = { tier: current ?? tier, confidence: last.confidence, reason: "no-auth" };
    }
    renderWidget(ctx);
  });

  pi.registerCommand("jev", {
    description: "Toggle Jev automatic model routing (off by default; on/off/status)",
    getArgumentCompletions: (prefix: string) => {
      const items = ["on", "off", "status"].map((value) => ({ value, label: value }));
      const filtered = items.filter((i) => i.value.startsWith(prefix));
      return filtered.length ? filtered : null;
    },
    handler: async (args, ctx) => {
      const arg = args?.trim().toLowerCase();
      if (arg === "status") {
        ctx.ui.notify(
          `Jev Router: ${mode}${last ? ` · last: ${last.tier} p=${last.confidence?.toFixed(2) ?? "?"} (${last.reason})` : ""}`,
          "info",
        );
        return;
      }
      if (!hasKey()) {
        ctx.ui.notify("Jev Router: no JEV_API_KEY — put it in ~/.jev-pi.env first", "error");
        return;
      }
      const next: Mode = arg === "on" ? "auto" : arg === "off" ? "off" : mode === "auto" ? "off" : "auto";
      setMode(next, ctx);
      ctx.ui.notify(next === "auto" ? "Jev Router: routing on" : "Jev Router: routing off", "info");
    },
  });
}
