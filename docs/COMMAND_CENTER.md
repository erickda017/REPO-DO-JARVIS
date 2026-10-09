# Command centre — status and handover

Work done remotely, **without access to the author's local machine, projects or
the Jev AI service**. Everything below was verified against fake network
responses only. No real provider, token or paid API was called.

## Phase A — audit of the base (`adewaskar/jarvis`, MIT)

Imported unmodified in the first commit, so `git diff` against it shows exactly
what the command centre added.

| Area | Finding |
|---|---|
| Frontend | React 19 + Vite + Three.js/GLSL face, Zustand store, voice (Porcupine wake word, local VAD, browser STT/TTS, optional ElevenLabs, Kokoro) |
| Backend | `bridge/server.mjs` (Node ≥ 20): HTTP + WebSocket on `:8787`, runs the **Claude Agent SDK** (`query()`), i.e. Claude Code headless on the user's Claude login |
| Tools | Every MCP server in `~/.claude.json` is passed in by hand, plus in-process servers `jarvis` (HUD), `jarvis_ui`, `jarvis_chrome`, `jarvis_eyes` |
| Permissions | `decideTool()` is default-deny for effectful tools; `settingSources: []` makes it the only authority; writes need `JARVIS_ALLOW_WRITES=1` |
| Network safety | Origin allow-list on HTTP and WebSocket, SSRF-guarded `/img` `/media` `/file`, CSP, DOMPurify on model HTML |
| Multi-provider | **None.** The brain is Claude only. Other models are reachable today only as MCP tools (e.g. `openrouter`) |
| Windows 10 | Not verified here (Linux container). Needs a local run |

Risks noted: `claude-opus-5` default model id and `JARVIS_EFFORT` are the base's
choices and unverified by me; `probeUrl` is an unused import in the base.

## What was added (all under `bridge/command/`, one wiring edit in `server.mjs`)

- **Provider layer** — `providers/{anthropic,openaiCompat,unverified,registry}.mjs`.
  One adapter interface (`probe()`, `infer()`), normalised `ProviderError`
  kinds, per-request timeout, size cap, no redirect following.
- **Router** (`router.mjs`) — capability + priority selection; sensitive data
  never goes to external providers unless `allowSensitive`; paid calls need
  `confirmSpend`; fallback only after retryable errors and only between
  eligible providers; real attempts are always reported, a failed route is
  never turned into a fake answer.
- **AI health** (`health.mjs`) — `endpoint`, `auth`, `model`, `inference` kept
  separate (`ok | fail | unknown | skipped`). Inference is opt-in and needs `confirm`.
- **Service monitor**, **project monitor**, **tasks**, **timer**, **audit log**
  (redacted, no prompt text), **HTTP API** `/api/command/*`, and a deliberately
  narrow **MCP server** `jarvis_command` (status, tasks, timer — no delete, no
  inference).
- Config in `command.config.json` (see `command.config.example.json`): API keys
  are referenced by *env var name*, never stored.

Run the tests: `npm run test:command` (30 tests, fake `fetch`, no network).

## Jev is a decision layer, not the maestro

Verified from `https://api.typesafe.ai/openapi.json` (v0.2.0): `GET /v1/models`
and `POST /v1/systemone`, Bearer auth. You send `state` (content) and named
`questions` of type `noul` (yes/no probability), `choice` or `score`; it returns
probabilities and a confidence. It does not generate text, plan, or call tools.
So the design is:

```
request -> router.smartRun -> Jev classifies (choice: chat | coding | ...)
                           -> the matching generator (Claude, local LLM) answers
```

The decision is advisory. It is skipped when spend is not confirmed, when fewer
than two generator capabilities exist, when the prompt is marked `sensitive`
(Jev is external), or when confidence is below 0.6. If Jev fails, the default
route still answers and `routing` reports why. Endpoints: `POST
/api/command/ai/decide` and `POST /api/command/ai/ask` (both need `confirm`).
Whether it beats just sending everything to one model must be measured on your
own prompts before it goes into the main flow.

## Module status

| Module | State |
|---|---|
| Provider abstraction + Anthropic adapter | Done, unit-tested; **not run against the real API** |
| Generic OpenAI-compatible adapter | Done, unit-tested; usable only once a server is confirmed to speak that format |
| Router / fallback / spend + sensitivity gates | Done, unit-tested |
| AI health monitor (4 levels) | Done (backend). **No UI panel yet** |
| Service + project monitor | Done (backend). No UI panel yet |
| Tasks, timer | Done (backend + voice tools). No UI panel yet |
| Audit log | Done |
| Jev (TypeSafe System One) adapter + `decide()` + `smartRun()` triage | Done, unit-tested against the **public OpenAPI contract**; **not called for real** (no key, no paid test yet) |
| **Local LLM app** | **Blocked** — placeholder; needs inspection of the app's code |
| Notes-site integration | Not started; needs the app inspected first |
| Maestro (multi-step planner delegating across models) | Not built. Jev cannot be one (see below); the maestro stays Claude, which already plans and calls tools |
| Frontend panels in the JARVIS HUD | Not started; do after the first local run so it can be seen |
| Windows 10 run, voice, full original-feature regression | Not verified |

## Needed from the local machine / the author

1. **Jev**: a `TYPESAFE_API_KEY` in your environment and one controlled paid
   test (`POST /api/command/ai/check` with `inference`, or `ai/decide`). Confirm
   the model name with `GET /v1/models` (`jev-latest` is only the docs example).
   The advertised price (US$ 0.042 per million input tokens) comes from a
   third-party summary and was not verified against the official page.
2. **Local LLM app**: how it receives requests (HTTP route? port? OpenAI-style?).
   If it exposes `/v1/models` + `/v1/chat/completions`, change its config type to
   `openai-compat` and set `baseUrl`.
3. List of projects with ports / health URLs for `services` and `projects`.
4. A first controlled, paid test only after the target and cost are confirmed.

## Continue locally

```
git clone <this repo> && cd <repo> && git checkout claude/beautiful-mccarthy-h03tsc
npm install
cp command.config.example.json command.config.json
npm run test:command
npm start
curl -H "Origin: http://localhost:5173" http://localhost:8787/api/command/overview
```

Or teleport the session: `claude --teleport <session id>` from the repo folder.

## Security notes

- Keys: env vars only; never in config, replies, logs or audit (tested).
- State-changing API calls need `application/json` and an allowed `Origin`
  (or `JARVIS_ALLOW_NO_ORIGIN=1`), the same trust model as the WebSocket.
- Monitors only touch services you list; no discovery or scanning.
- Content returned by providers or monitored services is data and never changes
  permissions: `decideTool()` is untouched apart from allowing `jarvis_command`.
