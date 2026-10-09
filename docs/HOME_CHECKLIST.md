# Local handover checklist (for the Claude session that runs on the author's PC)

Run these in order. Stop and report at the first failure; do not guess values.

1. **Baseline.** `git status`, `git log --oneline -5`, `npm install`,
   `npm run test:command` (expect 31 passing). Then `npm run build` and
   `npm run lint` to confirm the original app still builds.
2. **Local LLM discovery (read-only).** Find the `agente-codigo` folder
   (author's path was `G:\NOVA IA DO UMBRA\agente-codigo`). Read ONLY the names
   and values of `LOCAL_AI_ENDPOINT` and `LOCAL_AI_MODEL` from its `.env`.
   Never print or copy API keys or any other variable.
3. **Config.** `cp command.config.example.json command.config.json`. Set the
   `local-llm` entry's `baseUrl` and `models` from step 2 and `enabled: true`.
   Leave Jev and Claude API disabled until the author supplies keys.
4. **Start and check.** Make sure the llama-server is running (ask the author
   how they start it if it is not). Start the bridge (`npm run bridge`), then:
   `POST /api/command/ai/check {"providerId":"local-llm"}` with headers
   `Origin: http://localhost:5173` and `Content-Type: application/json`.
   Report endpoint / auth / model separately. This costs nothing.
5. **First real inference** (local, free): `POST /api/command/ai/infer` with
   `{"prompt":"Responda apenas: ok","providerId":"local-llm","confirm":true}`.
6. **Windows 10 check.** `npm start`, open http://localhost:5173 in Chrome, confirm
   the original JARVIS face and the voice still work. Note anything that breaks.
7. **Paid services are out of scope until the author asks:** Jev
   (`TYPESAFE_API_KEY`), Claude API, any other key. Ask before the first paid call.
8. **Then:** inspect the Umbra RPG AI and the notes site only if the author
   asks; update `docs/COMMAND_CENTER.md` with what was verified; commit and push
   to `claude/beautiful-mccarthy-h03tsc`.
