# Command centre â€” status and handover

Work done remotely, **without access to the author's local machine, projects or
the Jev AI service**. Everything below was verified against fake network
responses only. No real provider, token or paid API was called.

## Phase A â€” audit of the base (`adewaskar/jarvis`, MIT)

Imported unmodified in the first commit, so `git diff` against it shows exactly
what the command centre added.

| Area | Finding |
|---|---|
| Frontend | React 19 + Vite + Three.js/GLSL face, Zustand store, voice (Porcupine wake word, local VAD, browser STT/TTS, optional ElevenLabs, Kokoro) |
| Backend | `bridge/server.mjs` (Node â‰¥ 20): HTTP + WebSocket on `:8787`, runs the **Claude Agent SDK** (`query()`), i.e. Claude Code headless on the user's Claude login |
| Tools | Every MCP server in `~/.claude.json` is passed in by hand, plus in-process servers `jarvis` (HUD), `jarvis_ui`, `jarvis_chrome`, `jarvis_eyes` |
| Permissions | `decideTool()` is default-deny for effectful tools; `settingSources: []` makes it the only authority; writes need `JARVIS_ALLOW_WRITES=1` |
| Network safety | Origin allow-list on HTTP and WebSocket, SSRF-guarded `/img` `/media` `/file`, CSP, DOMPurify on model HTML |
| Multi-provider | **None.** The brain is Claude only. Other models are reachable today only as MCP tools (e.g. `openrouter`) |
| Windows 10 | Not verified here (Linux container). Needs a local run |

Risks noted: `claude-opus-5` default model id and `JARVIS_EFFORT` are the base's
choices and unverified by me; `probeUrl` is an unused import in the base.

## What was added (all under `bridge/command/`, one wiring edit in `server.mjs`)

- **Provider layer** â€” `providers/{anthropic,openaiCompat,unverified,registry}.mjs`.
  One adapter interface (`probe()`, `infer()`), normalised `ProviderError`
  kinds, per-request timeout, size cap, no redirect following.
- **Router** (`router.mjs`) â€” capability + priority selection; sensitive data
  never goes to external providers unless `allowSensitive`; paid calls need
  `confirmSpend`; fallback only after retryable errors and only between
  eligible providers; real attempts are always reported, a failed route is
  never turned into a fake answer.
- **AI health** (`health.mjs`) â€” `endpoint`, `auth`, `model`, `inference` kept
  separate (`ok | fail | unknown | skipped`). Inference is opt-in and needs `confirm`.
- **Service monitor**, **project monitor**, **tasks**, **timer**, **audit log**
  (redacted, no prompt text), **HTTP API** `/api/command/*`, and a deliberately
  narrow **MCP server** `jarvis_command` (status, tasks, timer â€” no delete, no
  inference).
- Config in `command.config.json` (see `command.config.example.json`): API keys
  are referenced by *env var name*, never stored.

Run the tests: `npm run test:command` (34 tests, fake `fetch`, no network).

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

## Verified on the author's PC (Windows 10, 2026-10-09)

- `npm install`, `npm run build` and `npm run test:command` (31/31) pass; lint
  shows only the two warnings that already existed in the base.
- The local AI project (`G:\NOVA IA DO UMBRA`) runs llama-server in three places:
  **8080** Node chat + C.R.I.S panel, **8081** heavy router (`modos.ini`, one mode
  loaded at a time, ~13 GB RAM), **8082** light model `0-leve-conversa`
  (Qwen3.5-4B, ~3 GB). The config uses the light one by default; the heavy one is
  in `command.config.json` but `enabled: false`, because with 16 GB RAM it cannot
  coexist with a browser and loading a mode takes up to ~2 min.
- Real run through the router: `ai/check` on `local-leve` gave endpoint ok, model
  ok, auth `unknown` (keyless server); `ai/infer` and `ai/ask` returned real
  answers in ~1.3 s. Service checks against `:8082` and the bridge report `up`.
- Browser panel: `http://localhost:5173/command.html` (served by Vite, talks to
  the bridge on `:8787`). The page script passes a syntax check and its API calls
  were exercised with curl-style requests incl. CORS; it was **not** visually
  inspected in a browser (headless screenshot failed on this machine).
- Still never called: Jev, Claude API (no keys supplied), the heavy model, the
  Umbra RPG AI, the notes site.

## Desktop app (Electron + React + TypeScript)

`npm run app` builds the renderer and the Electron shell and opens the window
(`npm run app:build` to only build). Electron starts the bridge itself unless
one is already listening on 8787, and serves the UI from `127.0.0.1:5174`
(inside the range the bridge accepts as an origin). Sources: `app/electron`
(main process), `app/renderer/src` (UI). Tests: `npm run test:app` (neural
graph, activity spreading, health tone, command parsing). Preview: `docs/app-home.png`.

### Installer (Windows)

`npm run app:dist` builds, into `release/out/` (git-ignored):
- `JARVIS-Setup-0.1.0.exe` (~192 MB), per-user NSIS installer (no admin rights, choose folder, desktop shortcut, uninstaller).
- `JARVIS-Portable-0.1.0.exe` (~192 MB), single file, no install; it unpacks to a temp folder on every launch so the first screen takes a while.

Packaging uses a small staging project (`release/stage`) so only the bridge's three runtime packages ship. Installed
builds keep their config and data in `%APPDATA%\J.A.R.V.I.S\` (`command.config.json`, copied on first run from the
config that existed when the installer was built, and `data/` with tasks, timer, audit log and the ElevenLabs key).
Edit that copy to change providers, ports or services.

Verified on this PC: the unpacked app, the portable exe, and a silent install / launch / uninstall cycle of the
installer (files, Start-menu and desktop shortcuts, registry entry and removal all correct).
Known issues: **the installer process exits with code `-1073740940` (0xC0000374) in silent mode** after finishing the
install, reproduced three times, cause not found (the GUI wizard path was not exercised); the binaries are **not
code-signed**, so Windows SmartScreen will warn; it still bundles the Claude Agent SDK (~264 MB unpacked) because the
bridge imports it, so the original Claude-driven HUD brain stays available; the icon is a generated placeholder.

- **Home** is a 3D neural scene. Big nodes = real entities (router core, AIs,
  services, projects, tasks, timer, voice) coloured by measured state; a pulse
  travels from the core to the AI/service that actually did the work (read from
  the bridge audit log, or immediately after a chat). The surrounding cloud of
  small neurons is decorative and says so on screen.
- **Dynamic panels**: commands such as "como estão as IAs?", "minhas tarefas",
  "timer de 5 min", "criar tarefa: …", "mostre <url de imagem/vídeo>" are handled
  by plain rules and open draggable floating cards (status, tasks, timer, image,
  video). Anything else is chat through the router; the reply floats too. Image or
  video links written by a model load only after a click (loading would reveal this
  PC's address to that host).
- On start it runs the free health checks (no inference, no spend) so the state
  shown is measured.
- Views: Rede neural, Conversa, IAs (4-level health), Sistema (services,
  projects, tasks, timer), Voz (ElevenLabs).
- **Not done / limits**: no installer yet (`electron-builder` not configured), no
  HUD-style voice wake word in this app (the original HUD still has it and still
  needs Claude Code), pulses come from audit events and chats only (no per-token
  streaming), the `impeccable` finish review and documenter subagents were not run
  (design detector ran in degraded mode and found nothing; `DESIGN.md` was written
  by hand from the build).

## Mode without Claude, and ElevenLabs voice

- **Chat without Claude.** `POST /api/command/ai/chat` takes `messages` (up to 40
  user/assistant turns, last one from the user) and answers through the router
  with a short Brazilian-Portuguese JARVIS persona. The panel's chat box uses it,
  so the command centre (chat, monitors, tasks, timer) keeps working with no
  Claude Code subscription. The HUD with wake word and tools does **not**: its brain
  is the Claude Agent SDK. Verified with the local llama-server (history kept:
  it answered the name given two turns earlier).
- **ElevenLabs from the panel.** "Voz Â· ElevenLabs" saves the key (and optionally a
  voice) to `data/voice.json` (gitignored, never returned by any endpoint: only
  `configured`, `source`, last 4 characters). Precedence: saved in panel > env
  `ELEVENLABS_API_KEY` > the base's `~/.claude.json` lookup. "Testar" lists the
  account's voices (free call) to pick one. The bridge's existing `/tts` and
  `/stt` use this key, so the HUD picks it up after the page is reloaded. The
  chat's "falar resposta" uses `/tts`, or the browser voice if no key is set.
  Not verified against the real ElevenLabs API (no key was supplied).
- The key is stored in plain text in `data/voice.json`; on Windows the file
  permissions are those of the folder.

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
| Local LLM (`agente-codigo`'s llama-server) | Configured as `openai-compat` from evidence in the other session's code; **port and model id unverified**, never run |
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
2. **Local LLM**: the other project's gateway (`agente-codigo/lib/gateway.js`)
   registers the local model as a `llama-server` reached at
   `${LOCAL_AI_ENDPOINT}/chat/completions`, no API key. Read the real
   `LOCAL_AI_ENDPOINT` / `LOCAL_AI_MODEL` from its `.env` and put them in
   `command.config.json` (`local-llm`). That project already has its own
   multi-account gateway; JARVIS only needs to *monitor and call* the
   llama-server, not duplicate that gateway. The separate Umbra RPG AI has not
   been looked at.
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
