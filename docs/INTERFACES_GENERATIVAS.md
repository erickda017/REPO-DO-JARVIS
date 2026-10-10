# Interfaces generativas e adaptativas (Painéis)

O JARVIS pode montar interfaces próprias para a tarefa em vez de responder só com texto: gráficos, tabelas, listas de arquivos com ações, painéis de execução com progresso, formulários, dashboards ao vivo. Ficam na tela **Painéis**.

## 1. Auditoria que antecedeu a implementação

| Ponto existente | Situação | Decisão |
|---|---|---|
| Cartões flutuantes da Home (`Floating.tsx`, `CardBody`) | só texto, status, tarefas, timer, mídia; sem layout, dados vivos nem ações | mantidos (respostas curtas); painéis são outra camada |
| Painéis HUD do bridge base (`panels.mjs`, "blades" HTML) | o modelo escreve **HTML** e o front o exibe; só na interface de voz original, fora do app | não reaproveitado: HTML do modelo é exatamente o que esta feature evita |
| Rota `agent/tool` + confirmações | executa uma ferramenta com permissão e confirmação | **reaproveitada**: toda ação de painel passa pelas mesmas regras |
| Agente (`agent.mjs`) e ferramentas (`tools.mjs`) | único ponto onde o modelo "pede" coisas | o modelo pede painéis por **ferramentas** (`ui_*`), sem canal novo |
| Roteador | prioridade, tier, sensível, gasto | reaproveitado para gerar a especificação (`tier cheap` ou `strong`) |
| Orquestrador de missões | estado ao vivo da missão | ganhou um painel automático ligado ao estado real |
| Monitor, `fs_search`, `disk_*` | dados reais | fontes de dados dos painéis |

## 2. Arquitetura (definição, dados e ações separados)

```
 modelo / usuário                      bridge                                 app (renderer)
 ────────────────                      ──────                                 ──────────────
 ui_quick / ui_show / ui_update ─►  genui.mjs  ── validateSpec (shared) ──►  /ui/panel (só o que mudou)
 POST ui/generate (router)            │ spec   (specRev)                       │
                                      │ data   (rev por fonte)                 ├─ PanelHost: poll 1 s, estado local dos controles
                                      │ actions ─► tools reais + permissões    ├─ componentes fixos (components.tsx)
                                      └ fontes vivas: tool(leitura)|monitor|mission └─ ações → POST ui/action → confirmação
```

- **Especificação** (`shared/genui/spec.mjs`): JSON declarativo v1 validado por um único módulo, usado pelo bridge (autoridade) e pelo renderer (defesa em profundidade: uma spec inválida nunca é desenhada). Estrutura estrita (tipo de componente desconhecido = erro), decoração tolerante (propriedade desconhecida é descartada com aviso), limites de tamanho/profundidade/nós.
- **Ligações** (`shared/genui/resolve.mjs`): `{ref:"data.x"}`, `{{state.q}}`, condições `{ref, eq|ne|gt|lt}`. É só leitura de caminho em objeto simples: não há `eval`, não alcança a cadeia de protótipos nem funções.
- **Componentes** (21, `app/renderer/src/genui/`): `stack grid split tabs card · text stat kv alert progress steps empty · table list chart log files results · form control button`. Gráficos em SVG puro (`bar hbar line area pie donut spark`), cores só por *tom* da paleta.
- **Dados**: `data` estático e `sources` vivas (`tool` só de **leitura**, `monitor`, `mission`) atualizadas pelo bridge com intervalo mínimo; cada fonte tem revisão própria, então o renderer só recebe o que mudou. Erro de fonte (ex.: grupo desligado) aparece no painel.
- **Ações** (`actions` na spec): `tool` (com `into`/`pick` para gravar o resultado em `data.*`), `state`, `ask` (manda texto ao chat), `mission`, `missionop`, `refresh`, `close`.
- **Atualização incremental** (`ui_update`): `setData`, `appendData`, `setStatus`, `setState`, `patchNode`, `addNode`, `removeNode`, `addAction`, `addSource`. Mudança estrutural revalida a spec inteira; patch inválido **não altera nada**. Dados não reenviam a spec; spec não reenvia dados.
- **Estado dos controles** (filtros, abas, campos): fica no cliente, sobrevive a atualizações da spec (só preenche chaves que faltam) e a trocas de aba; nos painéis **fixados** o bridge guarda e restaura.
- **Ciclo de vida**: até 12 painéis abertos, os não fixados somem em 24 h; **Fixar** grava spec + estado em `data/ui/` e reabre após reiniciar (um painel salvo que deixou de validar é ignorado, nunca desenhado pela metade).

## 3. Como o modelo cria uma interface
- Ferramentas (grupo **Painéis**, ligado por padrão): `ui_catalog` (formato e componentes), `ui_quick` (tabela, barras, linha, área, pizza, **comparação**, números, arquivos, etapas, log — a partir de dados reais; é o caminho para modelos pequenos), `ui_show` (spec completa: formulários, abas, fontes vivas, botões), `ui_update`, `ui_close`. O prompt do agente orienta: use painel quando comparar números, listar arquivos com ações, acompanhar progresso ou pedir dados.
- `POST ui/generate` / botão **Gerar painel**: dados tabulares com tipo óbvio → painel **sem modelo**; senão o roteador gera a spec (tier `cheap`, ou `strong` com "autorizo gasto"), com **uma** rodada de reparo que mostra ao modelo os erros de validação e, no pior caso, um painel de tabela com os dados. Funciona com qualquer provedor compatível.
- Modelos prontos: **Sistema ao vivo** (monitor) e **Procurar arquivos**. Missões ganham automaticamente um painel ligado ao estado real da missão.
- A tela abre sozinha quando o agente cria um painel (nunca tira você do terminal).

## 4. Segurança
- O modelo **nunca** envia código ou HTML: só nomes de componentes registrados e nomes de ferramentas registradas. Todo texto é renderizado como texto; links só `http(s)`.
- Ferramentas proibidas em botões: `run_command`, `proc_close`, `profile_apply`, `memory_remember` e qualquer `ui_*` (painel não cria painel). Fontes de dados só podem ser ferramentas de **leitura**.
- Ação de painel = mesmas regras do agente: ferramenta existe, grupo ligado, a própria ferramenta valida parâmetros e caminhos (pasta liberada). Em painéis criados por modelo, **qualquer ação que não seja leitura pede confirmação** mostrando a ferramenta e os argumentos reais ("o texto do botão não conta"). Painéis do próprio sistema (missão) só controlam aquela missão.
- Limites: 5 ações/s por painel, 3 simultâneas, dados do painel ≤ 300 KB, spec ≤ 200 nós. Auditoria: `ui.create`, `ui.action`, `ui.close` (sem argumentos).

## 5. Testes
- `test/command/genui.test.mjs` (14): validação (todos os tipos, erros com caminho, limites, segurança), ligações (protótipo/funções inalcançáveis), construtores rápidos, **3 casos reais**:
  1. **Comparação com gráfico**: dados reais medidos por `disk_largest`; fonte viva ligada a `fs_list` real; nada reenviado enquanto nada muda.
  2. **Painel de execução**: atualizações incrementais (dados/estado/nós), só o que mudou chega ao renderer; painel de **missão real** acompanhando-a até o fim.
  3. **Gerenciar arquivos**: formulário → `fs_search` real → ver/apagar/mover com permissões (fora da pasta recusado, grupo desligado recusado, confirmação obrigatória, arquivo realmente apagado/movido e verificado).
  + persistência/fixar, geração pelo roteador com reparo, ferramentas `ui_*`.
- `test/app/genui-render.test.mjs` (5): o **renderer real** (esbuild + `react-dom/server`): todos os gráficos com dica de cada marca, tabela/lista/arquivos/etapas/log/resultados/stat/progresso, **HTML nos dados aparece como texto**, `javascript:` não vira link, condições, erro ligado, abas, spec inválida não é desenhada.
- `test/app/pure.test.ts`: estado preservado, ordenação/filtro, validação de formulário, formatação.
- Real, no app de verdade: painéis de comparação (dados de `disk_largest`), sistema ao vivo (CPU/RAM/discos do monitor), arquivos (busca real em `docs/`), execução (os testes do app rodando de fato, progresso ao vivo) e a caixa de confirmação do botão "Apagar" mostrando `fs_delete` e o caminho; o **agente com o modelo local real** montou um painel via `ui_quick` a partir de dados reais de `disk_largest`.

## 6. Limitações
- O modelo local pequeno só acerta o caso simples (`ui_quick`); specs complexas dependem de uma IA mais forte.
- Gráficos: sem zoom/seleção; mais de ~300 pontos são cortados. Sem exportação de painel.
- `ui_update` por modelo é por operações (não reescreve a spec); ações `ask` mandam texto ao chat e saem da tela de painéis.
- Painéis abertos não sobrevivem a reiniciar, a menos que fixados; dados de painéis fixados são buscados de novo.
