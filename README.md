# jev-router-pi (Jev routing for pi, on z.ai GLM)

Automatic model routing for the [pi coding agent](https://github.com/earendil-works/pi-mono)
across **z.ai GLM models**. Each turn goes to the cheapest tier that can actually handle it —
trivial edits to the cheapest flash model, hard debugging to the strongest — with the decision
made by [Jev](https://docs.typesafe.ai), TypeSafe's System One decision model.

Port of [jev-router](https://github.com/gargpratyush/jev-router) (Claude Code + Anthropic) to
pi's native extension system. No proxy and no `BASE_URL` rewriting: the extension asks Jev on
each new prompt and switches the session model with `pi.setModel()` before the agent loop runs.

```
you -> pi (real CLI, real UI) -> z.ai GLM
          |
          +-> jev extension: which tier does this turn need?
```

## Quick start

Requires pi (`npm install -g @earendil-works/pi-coding-agent`), Node.js 20.12+, and
[z.ai](https://z.ai) access.

```bash
git clone <this-repo> jev-router-pi
cd jev-router-pi
npm install
mkdir -p ~/.pi/agent/extensions
ln -s "$(pwd)" ~/.pi/agent/extensions/jev-router
echo "JEV_API_KEY=..." > ~/.jev-pi.env
export ZAI_API_KEY=...   # or: /login zai inside pi
pi
```

You need two keys:

| Key | What for |
| --- | --- |
| `JEV_API_KEY` (or `TYPESAFE_API_KEY`) | Jev routing decisions, from [TypeSafe](https://docs.typesafe.ai). Without it the extension stays off and pi behaves normally. |
| `ZAI_API_KEY` | The GLM models themselves. Env var or `/login zai`. |

The extension is picked up automatically from `~/.pi/agent/extensions/`; edit code and run
`/reload` to pick up changes.

## Using it

Routing is **off by default**: sessions behave exactly like stock pi until you opt in with
`/jev` (or `/jev on`) — or set `JEV_DEFAULT_MODE=on` in `~/.jev-pi.env` to start routed.
Once on, every new prompt is routed to the cheapest sufficient GLM tier, and your choice
persists when you resume the session. A widget above the editor shows the state:

```
jev: off — /jev to enable routing  opted out, pi as usual
⚡ jev pro p=0.91              routed, Jev confidence 0.91
⚡ jev air p=0.97 (override)   you said "use air"
⏸ jev manual · glm-5.3        your own choice, Jev standing down
jev: off — put JEV_API_KEY...  no Jev key configured
```

- `/jev on` enables routing, `/jev off` disables it again, `/jev status` shows the mode.
- Pick any model yourself (`/model`, `Ctrl+P`) and routing **stands down** — your choice goes
  to the API untouched and Jev is not consulted.
- `/jev` resumes routing; `/jev on`, `/jev off`, `/jev status` are explicit.
- An explicit `use air` / `switch to glm-5.3` in your message beats Jev outright.

## Routing rules

One Jev call per user turn selects a tier. `src/policy.ts` then applies, in order:

- an explicit tier in your message wins outright;
- a Jev failure, timeout or unrecognised answer keeps the current model;
- a low-confidence answer never downgrades, and caps upgrades at `pro`;
- a downgrade is refused once the conversation is large, since switching models invalidates
  the provider prompt cache and the rebuild costs more than the downgrade saves;
- the tier is clamped to what is present in the z.ai catalog and authenticated, stepping up
  rather than down;
- prompts with images step up to a vision-capable tier (`air`, i.e. glm-5.3-flash), or stay
  put when none is available.

Routing is fail-open by construction: every error path keeps the original model.

Like the Claude Code original, three kinds of turn are deliberately not routed:

| Turn | Reason |
| --- | --- |
| Anything after a manual model pick | You chose it. |
| Continuations of a running task (steers, follow-ups, tool loops) | The tier is chosen once and pinned, so the model cannot change mid-task. |
| Session restore | The persisted mode decides, not the restored model. |

## Tier ladder

Defined in `src/config.ts`, cheapest first — edit that file to change the whole policy:

| Tier | Model | In $/M (in/out) | Notes |
| --- | --- | --- | --- |
| `air` | glm-5.3-flash | 0.075 / 0.25 | cheapest, 1M context, vision |
| `pro` | glm-5.3 | 1.40 / 4.40 | strongest reasoning, always thinks, safe ceiling when Jev is unsure |

Thinking levels: pi clamps the session's thinking level to whatever the routed model supports
(via each model's `thinkingLevelMap`). `air` and `pro` never run with thinking fully off;
your level survives tier switches that support it.

## Differences from the Claude Code version

- **No proxy.** pi extensions can switch models directly, so there is no sentinel
  `jev-auto` model id, no `/model` picker hack, and no status line script — a widget instead.
- **No settings surgery.** Nothing is written to or restored from pi's settings; `pi.setModel`
  is session-scoped by design.
- **Provider.** z.ai GLM (`zai` global coding plan by default; `JEV_PROVIDER=zai-coding-cn`
  for the China plan — the tier ids exist in both catalogs).
- **Sub-agents.** pi sub-agents run in the same session model; there is no separate pinning
  as in the Claude Code proxy, because routing happens per user turn, not per request.

## Configuration

| Variable | Effect |
| --- | --- |
| `JEV_API_KEY` | Required for routing. `TYPESAFE_API_KEY` also works. |
| `JEV_PROVIDER` | `zai` (default) or `zai-coding-cn`. |
| `JEV_DEFAULT_MODE` | `on` starts every new session with routing enabled; unset or anything else starts off. Per-session `/jev` choices still win on resume. |
| `JEV_DEBUG` | Logs every decision and switch to `~/.jev-pi.log`. |

Values are read from the environment, from `~/.jev-pi.env`, and from a `.env` in the launch
directory, in increasing order of precedence.

## Development

```bash
npm install
echo "JEV_API_KEY=..." > .env
echo "ZAI_API_KEY=..." >> .env

npm test                          # 16 offline policy tests
pi -e ./src/index.ts              # try it without installing
```

`npm test` covers the policy decision table with synthetic Jev answers. For a live check,
start pi with `JEV_DEBUG=1` and watch `~/.jev-pi.log`:

```
2025-01-01T12:00:00.000Z [jev] 312ms p=0.94 air -> air (jev) ctx~1200 | fix this typo
```

## Limitations

- Your prompt text is sent to TypeSafe for the routing decision. Nothing else is.
- Jev adds roughly 300 ms to the first request of a turn, and about a second on the first
  call of a session while TLS is established. Continuations add nothing.
- Tier prices/ids come from pi's built-in z.ai catalog; if z.ai renames models, update
  `src/config.ts`.

## License

MIT
