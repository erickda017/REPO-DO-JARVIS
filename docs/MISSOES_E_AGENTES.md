# Missões, agentes especializados e ambiente autônomo

Este documento é a entrega da missão "ambiente autônomo de engenharia e execução de tarefas": a auditoria que veio antes (Fase A), o que já existia e foi reaproveitado, o que foi implementado, como usar, configurações, testes e limitações.

## 1. Auditoria (Fase A) — mapa técnico

Feita por leitura do código (dois inventários independentes, conferidos por mim nos pontos que viraram decisão) mais a execução real dos testes (`test:command`, `test:agent`, `test:app`).

| Camada | Arquivos | O que existe de verdade |
|---|---|---|
| Bridge base (voz + Claude Code) | `bridge/server.mjs`, `chrome.mjs`, `panels.mjs`, `page.mjs`, `net.mjs`, `vision.mjs` | Servidor WebSocket/HTTP em loopback com o Agent SDK do Claude Code; ~34 tools MCP (painéis HUD, UI, 16 de Chrome, câmera, `jarvis_command`); `/tts` `/stt` (ElevenLabs); SSRF bem tratado em `net.mjs`. **Limites:** controle do Chrome depende da extensão do Claude e usa socket em `/tmp` (provavelmente não funciona no Windows, não validado); não há captura de tela do desktop nem exec de shell nessa camada. |
| Roteador de IAs | `bridge/command/router.mjs`, `providers/*`, `health.mjs`, `settings.mjs` | Prioridade, capacidade, custo (`paid`), sensível, cooldown, failover antes do 1º token, streaming SSE, porta `/v1`. **Faltava:** preferência por custo/capacidade (cheap/strong), métricas por provedor, orçamento. |
| Agente do Windows | `bridge/agent/*` | Laço de um JSON por passo, permissões por grupo, confirmações no código, status por evidência, guarda contra injeção de prompt, 29 ferramentas (arquivos, web, apps, processos, sistema, comando). **Faltava:** ferramentas de desenvolvimento, planos, subagentes, persistência/retomada, memória, orçamento, detecção de "sucesso repetido". |
| App desktop | `app/electron`, `app/renderer` | Electron + React, terminal PTY, telas. **Faltava:** bandeja, início com o Windows, microfone, tela de acompanhamento de missões. |

Riscos que a auditoria apontou e o que foi feito:

| Risco encontrado | Situação |
|---|---|
| `run_command` e `proc_*` não passam pela validação de caminho; denylist contornável | Mantido (a confirmação é a defesa real). Novas ferramentas de desenvolvimento usam lista **fechada** de programas, sem shell e com argumentos restritos. |
| `profile_stop` declarava `verified: true` fixo | Corrigido: `verified: null` com evidência honesta. |
| Regex do `fs_write` para executáveis sem escapar o ponto (`.(bat|…)`) | Corrigido (`\.`). |
| Repetição só bloqueava chamada idêntica *que falhou* | Também bloqueia a mesma chamada que já deu certo 2 vezes. |
| Sem persistência de jobs | Missões são gravadas em disco e retomáveis. |
| Sem orçamento/métricas | Limite de tokens e tempo por missão e por job; métricas e gasto estimado por provedor. |
| Rotas HTTP do bridge base sem token (modo avulso) | No modo app todas exigem o token por execução. |
| Brechas na lista de verbos dos MCP externos do bridge base, `Read/Glob/Grep` sem restrição de caminho no bridge de voz | **Não alterado** (é o projeto base original); registrado como limitação. |
| `diskscan.cleanTemp` exportado e sem uso | Código morto, não alterado. |

## 2. O que foi reaproveitado

O laço do agente (`agent.mjs`), as ferramentas e permissões (`tools.mjs`, `access.mjs`), o roteador e os provedores, a auditoria (`audit.jsonl`), as confirmações da interface, o monitor, o cofre DPAPI. Nada foi reconstruído; as novidades se encaixam nesses pontos.

## 3. O que foi implementado

### 3.1 Orquestrador de missões (`bridge/agent/orquestrador.mjs`)
Ciclo: **entender → planejar → executar → observar/avaliar → corrigir → verificar → finalizar**.
- **Plano**: o modelo (tier `strong`) devolve critérios de sucesso e até 8 etapas com papel e dependências; o plano é validado (papéis conhecidos, dependências existentes, sem ciclos). Plano inválido → uma etapa geral (nunca trava).
- **Agentes especializados** (papéis reutilizáveis, não dezenas de agentes): `engenheiro`, `diagnostico`, `auditor`, `pesquisador`, `windows`, `seguranca`, `geral`. Cada um = instruções + conjunto **menor** de ferramentas + tier de modelo. Um papel só estreita o que o dono liberou, nunca amplia.
- **Execução**: uma etapa = um job do laço do agente existente. Só papéis **somente leitura** rodam em paralelo (máx. 2); quem edita roda sozinho, para dois agentes nunca mexerem nos mesmos arquivos. Etapas trocam **resumos + referência a arquivo** (`data/missions/<id>/<etapa>-<tentativa>.json`), não o contexto inteiro.
- **Correção**: etapa que falha é repetida uma vez com a falha como feedback; mesma falha duas vezes = **sem progresso**, para. Depois, até 2 replanejamentos só para o que falta.
- **Verificação independente**: no fim um auditor (sem confiar no relato) confere o estado real e termina com `VEREDITO: confere | divergente | inconclusivo`. `concluída` só com todas as etapas feitas **e** `confere`. `divergente` dispara uma rodada corretiva; se persistir, o resultado é `parcial`.
- **Limites** (`DEFAULT_LIMITS`): 30 min, 8 etapas, 2 replanejamentos, 400 mil tokens, 1 retentativa por etapa, 2 em paralelo; configuráveis por missão (teto 4×). Cancelamento a qualquer momento (corta também a chamada HTTP ao modelo).
- **Persistência**: `data/missions/*.json` a cada mudança. Após reiniciar, missões em andamento viram `interrompida`; **Retomar** continua sem refazer etapas concluídas.
- **Memória**: erros e soluções que funcionaram vão para a memória operacional; o planejador consulta antes de planejar.

### 3.2 Memória operacional (`bridge/agent/memoria.mjs`, `data/memory.jsonl`)
Fatos, hipóteses (nunca gravadas como confirmadas), decisões, erros e soluções, com origem, data e confiança. Segredos são removidos antes de gravar, texto cortado em 600 caracteres, arquivo limitado a 1500 entradas. Ferramentas `memory_remember` / `memory_recall`; painel na tela Missões.

### 3.3 Ferramentas de desenvolvimento (`bridge/agent/devtools.mjs`)
| Ferramenta | Grupo | Risco | Notas |
|---|---|---|---|
| `git_status`, `git_diff`, `git_log` | files | leitura | dentro de pastas liberadas |
| `git_checkpoint` | files | escrita | ponto de recuperação em `refs/jarvis/checkpoints/*` **sem tocar nos arquivos** |
| `project_run` | dev | perigo (confirma) | testes/lint/build; lista fechada de programas, sem shell, argumentos restritos, timeout ≤ 300 s; exit code é relatado, nunca vira "deu certo" |
| `server_start` / `server_status` / `server_stop` / `http_local` | dev | perigo / leitura | servidor em segundo plano (máx. 4), espera ficar pronto, só consulta 127.0.0.1 |
| `screen_capture` | screen | escrita | PNG em `data/captures`; analisar a imagem exige modelo com visão (não incluído) |
| `memory_remember`, `memory_recall`, `jarvis_perfil` | system | — | memória e perfil de si |

Grupos novos `dev` e `screen` começam **desligados**. **Autonomia de desenvolvimento** (chave `autoDev`, tela Missões): com ela ligada, `project_run` e `server_start` rodam sem pedir a cada comando (continuam restritos às pastas liberadas e à lista de programas; qualquer coisa que apaga/sobrescreve continua confirmando; a guarda contra instrução escondida continua valendo).

### 3.4 Roteador: custo, capacidade, métricas
`tier: 'cheap' | 'strong'` na requisição reordena os provedores sem quebrar as travas (pago só com "autorizo gasto", sensível nunca sai). Provedor ganha `tier` (padrão: externo = strong, local = cheap) e `price {in,out}` opcional (USD por 1M tokens) só para **estimar** gasto. `GET /api/command/ai/stats` devolve chamadas, taxa de sucesso, latência média, tokens e gasto estimado por provedor. O agente de cada papel pede o tier do papel.

### 3.5 Segundo plano, voz e personalidade
- **Início com o Windows** (`--hidden`, só no instalado; chave em `HKCU\...\Run`), **bandeja** (fechar a janela esconde; "Sair" no menu da bandeja encerra), segunda abertura traz a janela de volta, **atalho global** Ctrl+Alt+J.
- **Escutar**: dizer/digitar `ouvir`, clicar no microfone ou usar o atalho. Grava WAV 16 kHz só durante a escuta (detecção de voz local, para sozinho após 1,4 s de pausa), envia a `/stt` (ElevenLabs Scribe) e a frase vira mensagem normal.
- **Personalidade e perfil de capacidades**: `personalidade/JARVIS.md` (editável). A parte `persona` entra em toda conversa e no agente; `jarvis_perfil` junta o texto com a tabela **ao vivo** das ferramentas (gerada do registro, não pode listar o que não existe).
- **Terminal (Programar)**: corrigido o corte da última linha (padding no elemento errado) e o vazamento da interface do Claude Code para os outros terminais (`reset()` + saída de modos de TUI).

### 3.6 Interface
Tela **Missões**: objetivo, lista, plano com status por etapa, papel e tentativas, agentes ativos e ferramentas em andamento, confirmações pendentes (Autorizar/Negar), modelo/tokens/replanejamentos, verificação, resultado, Cancelar/Retomar, memória. Comando `missão: <objetivo>` na caixa de comando. Tela Voz: teste do microfone e opções de segundo plano.

## 4. Como usar
1. Tela **Agente**: libere uma pasta de projeto e ligue os grupos que a missão precisa (`dev` para testes/servidores).
2. Tela **Missões** (ou `missão: …` na caixa de comando): descreva o objetivo e inicie. Acompanhe, autorize o que for pedido, cancele se quiser.
3. Para IAs pagas na missão, ligue "autorizo gasto" (senão só as locais/gratuitas são usadas).

## 5. Configuração
- `data/settings.json` (flags): `autoDev` (autonomia de desenvolvimento), `routerSpend`.
- `command.config.json` por provedor: `tier` (`cheap`/`strong`), `price` (`{"in":3,"out":15}`).
- Ambiente: `JARVIS_SIGN_SHA1`/`JARVIS_SIGN_PFX` (assinatura do instalador), `JARVIS_DATA_DIR`, `JARVIS_BRIDGE_PORT`.
- App (`%APPDATA%\J.A.R.V.I.S\app.json`): `autostart`, `closeToTray`, `hotkey`.

## 6. Testes executados
- `test/agent/orquestrador.test.mjs` (13): validação do plano; missão ponta a ponta com projeto real que falha → diagnóstico, correção (dono confirmando a sobrescrita), testes, verificação; negar a confirmação não altera o arquivo; retentativa com feedback e par erro/solução na memória; mesma falha 2× = para (chamadas limitadas); ferramenta indisponível não gera laço; plano inválido; orçamento de tokens; cancelamento; **persistência e retomada sem refazer etapas**; auditor discordando → parcial, nunca sucesso; papel somente leitura não escreve; instrução escondida num README não faz a missão agir.
- `test/agent/devtools.test.mjs` (9, **reais**): git em repositório temporário, `project_run` com comandos reais e timeout, servidor local iniciado/consultado/encerrado, servidor que morre ao subir, **captura de tela real**, memória, perfil.
- `test/command/selecao.test.mjs` (4): capacidade, tier, travas de gasto/sensível, métricas, chave de API nunca em erro/saúde/auditoria.
- Real: bandeja e início escondido testados com o Electron de verdade (janela escondida no `--hidden`, reaparece na 2ª abertura, fechar esconde sem encerrar); registro de início com o Windows confirmado no `HKCU\...\Run` com `--hidden`; missão real pelo HTTP com o modelo local leve.

## 7. Limitações
- O modelo local leve é lento e erra: numa missão real o planejador e as etapas funcionaram, mas as etapas relataram coisas inconsistentes (ex.: "0 linhas" para um arquivo de 2) — por isso existe a verificação — e a verificação passou de 70 s. Para missões sérias, ligue uma IA forte.
- Transcrição de voz exige a chave do ElevenLabs; **não há** transcrição offline (o Windows deste PC não tem reconhecedor de fala instalado). Alternativas (Gemini, whisper local) não foram incluídas.
- `screen_capture` captura, mas **não analisa** a imagem.
- Controle do Chrome pelo agente do app não existe (só no bridge de voz original, não validado no Windows).
- Etapas que editam rodam uma por vez (sem paralelismo de escrita).
- O agente usa protocolo de JSON em texto, não function calling nativo dos provedores.
- Anthropic/Gemini/OpenRouter: failover e streaming testados só com respostas simuladas no formato documentado.

## 8. Próximos passos de maior valor
Chave real de uma IA forte para validar missões longas; transcrição local (whisper.cpp) para o microfone offline; análise de screenshot com modelo de visão; function calling nativo nos provedores que suportam; painel de gasto real com orçamento que bloqueia.
