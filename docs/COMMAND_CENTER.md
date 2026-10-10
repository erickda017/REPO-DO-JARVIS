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

### Desktop agent, disk analysis, local-AI control, router door (round 4)

- **Agent** (`bridge/agent/`): every free-text request goes to one loop (`agent.mjs`): the model proposes ONE JSON action at a
  time, code enforces permissions and confirmations, tools verify their own results (`verified: true/false/null`), and the
  final status (Concluído / Parcial / Não concluído) is computed from that evidence, never from the model's words. A
  second, independent model call audits the evidence when something was changed (advisory). Plain chat is answered in one
  call without tools. **Honesty guard**: a request that needs a tool (an action, or a measurement of the PC) answered with
  zero tool calls is pushed back twice and then refused; found in live testing, where the local 4B model claimed to have
  created a file and invented RAM numbers.
- **Tools**, by permission group (switch in the **Agente** screen; `apps`, `processes`, `commands` start OFF):
  files (`fs_list/read/search/write/mkdir/move/delete`, `temp_clean`; only inside granted folders; delete goes to the Recycle
  Bin and always asks), web (`web_search` via DuckDuckGo Lite, `web_fetch` through the bridge's SSRF-guarded fetcher,
  `url_open`), apps (`app_list`, `app_open`, verified by a process/window check), system (CPU/RAM summary, top processes,
  temperature, CPU/RAM report, `disk_report`, `disk_largest`, `disk_big_files`, `mem_snapshot`, `mc_locate`), processes
  (`proc_list`, `proc_close`, game profile), commands (`run_command`, always confirmed, with a deny-list).
- **Monitoring** is measured, not estimated: a 10 s sampler over Node's `os` keeps the last hour (CPU %, RAM); disks come from
  WMI; disk activity from `Win32_PerfFormattedData_PerfDisk` (locale independent); per-process CPU is a real 1 s window.
  Temperature is read from ACPI thermal zones or `nvidia-smi` and otherwise reported as **unavailable with the reason**
  (on this PC the Windows thermal WMI is "not supported" and there is no NVIDIA GPU, so the answer is "unavailable").
- **Disk space**: sizes by folder, big files, cleanup candidates (TEMP, npm cache, old big Downloads, Recycle Bin) with real
  numbers; the agent suggests what to delete and why and deletes only after you confirm. A background check every 5 min warns
  (a card) when a drive is under 10 % or 15 GB free, once per drive per 12 h.
- **Safety rules in code**: protected processes (Windows core, security software, JARVIS, local-AI servers) can never be closed;
  caution/unknown ones ask first; closing is the normal "close window" request, force needs a second confirmation; "Modo game"
  never touches antivirus or services, shows the RAM before/after and remembers what it closed.
- **IA local from the app**: the local AI project now lives in `ia-local/` (git-ignored: 15 GB of models, C.R.I.S, secrets). The old
  path `G:\NOVA IA DO UMBRA` is a junction to it, so shortcuts, the Umbra bridge and `PARAR_IA.bat` keep working. The **IA local**
  screen starts/stops the light model, C.R.I.S and the heavy model with the project's own launch commands and its own
  `PARAR_IA.bat`. Backups of the two agent files I edited are in `ia-local/_backup/`.
- **Own agent in Programar**: starts pre-answered (`--pasta=`, `--modo=`) with a compact header, a one-line spinner and
  `● tool` / `⎿ ok` lines instead of repeated warnings. The Desktop shortcut still launches the old compiled `.exe`
  (`dist/agente-codigo.exe`); rebuild it with the project's own pkg step to get the new look there too.
- **Router door** (`/v1/chat/completions`, `/v1/models`, bearer token shown in the IAs screen): any OpenAI-style client, your own
  agent included, gets the quota failover. Paid providers there only if "Permitir provedores pagos por aqui" is on.
- Providers catalogue now includes Claude, Gemini, OpenAI, DeepSeek, OpenRouter, Groq and Mistral (switched off, no model, until a
  key is saved). A loopback server is never "paid", so the local model needs no "autorizo gasto".

### More AIs, quota failover, Programar mode, project networks (round 3)

- **Providers**: Google Gemini (native adapter, contract checked against Google's discovery document), OpenRouter and
  OpenAI (OpenAI-compatible adapter; OpenAI uses `max_completion_tokens`), next to local, Anthropic and Jev. They ship
  disabled with no model; in the **IAs** screen paste the key (stored in `data/settings.json`, never shown again), run
  Checar, pick a model from the provider's own catalogue and switch it on. Keys are only accepted for names a provider
  declares in `apiKeyEnv`.
- **Quota failover**: HTTP 402, or a 429 whose body talks about quota/billing/credit, is classified `quota`; the router
  moves to the next eligible provider by priority and keeps the exhausted one out for 10 minutes. This is deterministic
  code; Jev only classifies the request kind in `smartRun`.
- **Programar**: xterm.js on a ConPTY (`@lydell/node-pty`, prebuilt, no compiler needed) running **Claude Code**, **your own
  agent** (`agente.js`, set once with "Definir agente") or a PowerShell, inside a folder you authorised. The side panel
  reads Claude Code's own transcript files (`~/.claude/projects/<folder>/*.jsonl`, only appended bytes, only after the terminal
  started): tokens in/out/cache, responses, tools, plan, files touched, recent actions, sub-agent calls. Your own agent
  and the shell have no metrics. No hooks are installed into Claude's settings.
  GhosttyEXTREME was studied as inspiration only (macOS-only Zig/Swift, AGPL-3.0): no code was copied.
- **Project networks**: "Projetos" authorises a folder (native picker). It is scanned read-only (max 700 items, skips
  node_modules/.git/dist, never follows symlinks, git branch and remote without credentials) into folders, files,
  relative imports and key files (README, manifests, CI). Each project is a satellite network around the core; files the
  agent touches light up.
- **UI**: stats moved to the title bar, the command box is a rounded pill with icon toggles, rounder panels and cards,
  ambient particles over the whole interface (off with reduced-motion), main network smaller.
- **Security note**: a real key pasted into `apiKeyEnv` is discarded with a warning (never echoed) and installers only embed
  a sanitised default config.

### Installer (Windows)

`npm run app:dist` builds into `release/out/` (git-ignored; env `JARVIS_VERSION`, `JARVIS_TARGETS=msi,portable,nsis`):
- `J.A.R.V.I.S <version>.msi` (~214 MB), per-user Windows Installer package (no admin rights, desktop and Start-menu
  shortcuts). **Running a newer MSI over an installed version updates it in place**: same folder, one uninstall entry, the
  old files replaced, your data untouched. Verified here: 0.2.2 -> 0.2.3 by `msiexec /i ... /qn`, exit code 0, a single
  entry `J.A.R.V.I.S 0.2.3.0`, same `%LOCALAPPDATA%\Programs\J.A.R.V.I.S`, `%APPDATA%\J.A.R.V.I.S\command.config.json`
  unchanged, and the updated app launches and reaches the bridge. Install: double-click, or `msiexec /i "<file>.msi" /qn`.
- `JARVIS-Portable-<version>.exe`, single file, no install (unpacks to a temp folder on each launch, so it starts slowly).
- NSIS (`.exe` installer) is no longer built by default: its 3.0.4.1 stub crashed with 0xC0000374 on this PC and an
  update over an existing install hung after removing the old version. Add `nsis` to `JARVIS_TARGETS` to build it anyway.

Installed builds keep config and data per user in `%APPDATA%\J.A.R.V.I.S\` (`command.config.json` copied on first run from a
sanitised default, `data/` with tasks, timer, audit, ElevenLabs key and API keys, `projects.json`, `code.json`).
Known issues: the WiX linker prints a harmless-looking `light.exe` cleanup error (`DeleteTempFiles`) after producing the
MSI, so the build script exits non-zero even though the `.msi` is complete and installs fine; binaries are **not
code-signed** (SmartScreen warns); the Claude Agent SDK (~264 MB unpacked) is bundled because the bridge imports it;
the icon is a generated placeholder; a granted project folder belongs to one installation (the installed app starts
with none).
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
