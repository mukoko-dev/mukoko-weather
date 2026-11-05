# CLAUDE.md patch note: GLM models only (owner, 2026-11-05)

Two lines in mukoko-weather/CLAUDE.md still say any `@cf/` model is allowed.

1. Tech Stack, "AI:" line (~line 36): after "the Worker's `AI_MODEL` var picks it" add
   "; only Z.ai GLM ids (`@cf/zai-org/glm-*`) are accepted".
2. AI Summaries, "Model ids:" bullet (~line 1201): replace "`@cf/` ids only via `allowed_model`" with
   "GLM ids only (`@cf/zai-org/glm-*`) via `allowed_model`, from the `AI_MODEL` var and from a passthrough caller alike; anything else falls back to `DEFAULT_MODEL`".
Owner quote: "The Shamwari ai and the ai we use should only use GLM models".
