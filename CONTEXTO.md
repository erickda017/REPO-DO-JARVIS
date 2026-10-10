# CONTEXTO — J.A.R.V.I.S (para uma sessão nova continuar sem o histórico)

Atualizado em 2026-10-09. Dono: Erick (Windows 10, 16 GB RAM, Xeon E5-2650 v4, RX 550). Fale em português do Brasil, direto.
Pasta de trabalho: `G:\JARIVS` (branch `claude/beautiful-mccarthy-h03tsc`, remoto `erickda017/repo-do-jarvis`). A IA local fica em `G:\NOVA IA DO UMBRA`.
Regras do dono: pode editar/criar à vontade neste repo; **gastos com APIs, credenciais, deploy e operações destrutivas exigem aviso/autorização**; não inventar capacidades; mostrar erros reais.

## O que é
Centro de comando pessoal multi-IA, inspirado no JARVIS. Base: `adewaskar/jarvis` (MIT, importada sem alteração no commit `0bd72f1`; a interface por voz original depende do Claude Code). Em cima dela:
1. **Bridge Node** (`bridge/`, porta 8787) com a camada de IAs em `bridge/command/` e a API `/api/command/*`.
2. **App desktop** Electron + React + TypeScript (`app/`), identidade holograma HUD (ver `PRODUCT.md`, `DESIGN.md`).

## Mapa do código
- `bridge/command/` — `providers/` (anthropic, openai-compat [serve OpenAI/OpenRouter/llama-server], gemini, jev, unverified, registry), `router.mjs` (capacidade+prioridade, gates de gasto/sensível, failover, cota esgotada = 10 min fora), `health.mjs` (4 níveis: endpoint/auth/modelo/inferência), `settings.mjs` (chaves de API e overrides pelo app, só nomes declarados em `apiKeyEnv`), `voice.mjs` (ElevenLabs), `services.mjs`, `projects.mjs`, `tasks.mjs`, `timer.mjs`, `audit.mjs`, `config.mjs`, `api.mjs`, `mcp.mjs` (tools de voz `jarvis_command`).
- `app/electron/` — `main.ts` (janela, bridge filho, IPC, PTY), `preload.ts` (única ponte segura), `projects.ts` (scanner read-only de pastas autorizadas), `transcripts.ts` (métricas lidas dos `.jsonl` do Claude Code em `~/.claude/projects/<pasta>`).
- `app/renderer/src/` — `App.tsx`, `store.ts` (zustand), `api.ts`, `intents.ts` (comandos por regra), `neural/` (cena 3D: `Scene.tsx`, `graph.ts`, `projectGraph.ts`), `ui/` (Floating cartões, CommandBar, Views, CodeView [xterm], ProjectsView, Particles).
- `scripts/` — `package-app.mjs` (instaladores), `build-electron.mjs`, `make-icon.mjs`, `app-shot.ps1` (screenshot do app real para verificar UI).
- `docs/COMMAND_CENTER.md` — status por módulo (fonte de verdade técnica). `docs/HOME_CHECKLIST.md` — passos antigos.

## Como rodar
`npm install` · `npm run app` (build + abre o app) · `npm run app:dist` (instaladores em `release/out/`; variáveis `JARVIS_TARGETS=nsis,portable,msi`, `JARVIS_VERSION`) · testes: `npm run test:command` (≈38) e `npm run test:app` (7) · tipos: `npx tsc -p app/tsconfig.json --noEmit`.
Verificação visual: `powershell -File scripts\app-shot.ps1 -Out .impeccable\review\x.png -Exec "<js>" -Delay 9000` (ignorado pelo git).
Config local (gitignored): `command.config.json`, `data/` (tasks, timer, audit, `voice.json`, `settings.json` com chaves). No app instalado: `%APPDATA%\J.A.R.V.I.S\` (`command.config.json`, `data/`, `projects.json`, `code.json`).

## IA local (verificado)
`llama-server`: **8082** modelo leve `0-leve-conversa` (Qwen3.5-4B, ~3 GB, provedor `local-leve`, padrão), **8081** roteador do modelo pesado 35B (`modos.ini`, ~13 GB RAM, `local-pesado` fica desligado), **8080** chat/C.R.I.S em Node. Iniciar: `G:\NOVA IA DO UMBRA\INICIAR_IA.bat`. O agente do dono: `G:\NOVA IA DO UMBRA\agente-codigo\agente.js` (roda no modo PROGRAMAR > "Meu agente", pede a pasta a autorizar).

## Funcionalidades prontas (todas verificadas por testes e/ou captura real)
IAs: local, Anthropic, Gemini, OpenRouter, OpenAI, Jev (decisão; **não gera texto**) — chaves e modelo pela tela IAs; failover por cota. Chat sem Claude (histórico). Cartões flutuantes por comandos ("como estão as IAs?", "minhas tarefas", "timer de 5 min", "criar tarefa: …", "mostre <url imagem/vídeo>"; mídia sugerida por IA só carrega após clique). Rede neural 3D menor, pulsos reais, uma rede por **pasta autorizada** (arquivos, pastas, importações, git, arquivos-chave; arquivos tocados pelo Claude acendem). Modo **Programar**: terminal real (xterm+ConPTY) com Claude Code / meu agente / PowerShell + painel de uso, ferramentas, plano, arquivos e ações (só Claude Code gera métricas). Telas Projetos, IAs, Sistema, Voz (ElevenLabs), partículas ambiente, caixas arredondadas, estatísticas no topo.

## Decisões e fatos importantes
- **GhosttyEXTREME** (referência pedida) é só macOS (Zig/Swift) e **AGPL-3.0**: foi usado só como inspiração (ler transcripts `.jsonl`, deduplicar uso por id); nenhum código copiado. Não instalamos hooks em `~/.claude/settings.json`.
- Jev (TypeSafe, contrato lido do OpenAPI público): classifica, não gera. `smartRun` usa Jev só para escolher a capacidade; **o failover por cota é código determinístico**, não o Jev. Nunca testado com chamada paga real.
- Segredos: chaves só em `data/settings.json`/`voice.json` (0600, gitignored), nunca devolvidas pela API; `apiKeyEnv` na config precisa ser um NOME de variável (a chave colada ali é descartada com aviso).
- **INCIDENTE (tratado):** o dono colou a chave do Jev no campo `apiKeyEnv` do `command.config.json`. Ela apareceu numa captura (apagada) e foi embutida nos primeiros instaladores `0.1.0` (não distribuídos, nem commitados). Migrada para `data/settings.json`; os instaladores novos usam config sanitizada. **Recomendar ao dono trocar essa chave** (ela também passou pelo contexto desta sessão).
- Instalador: o NSIS 3.0.4.1 do electron-builder **trava/crasha (0xC0000374)** nesta máquina; a atualização "por cima" via NSIS removeu a versão antiga e travou. Por isso foi adicionado alvo **MSI** (upgrade nativo, `upgradeCode` fixo) e o portátil. Sem assinatura digital (SmartScreen avisa). Ver estado final em `docs/COMMAND_CENTER.md`.
- Armadilhas do ambiente: `npm` 12 bloqueia scripts de pacotes (`allowScripts` no package.json); a extração do Electron falha com EPERM (usa `electronDist` local); `Start-Process -Wait` em instaladores com `runAfterFinish` pode travar; heredoc `python` no Bash desta máquina pendura; PowerShell 5 grava BOM em JSON (leitores já removem).

## Pendências / ideias
Conferir o modo Programar com uma sessão Claude real digitando; ícone final; assinar o instalador; ligar o Jev de verdade (precisa da chave dele no app, 1 teste pago controlado); streaming de tokens na rede neural; palavra de ativação no app; revisão final de design (subagentes `impeccable` não foram executados); integração com o site de notas e a IA do Umbra (RPG) ainda não iniciadas.
