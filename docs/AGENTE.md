# J.A.R.V.I.S. Code (o agente de programação)

Agente de terminal que vem com o app, baseado nas técnicas do **Hermes Agent** (MIT, veja `agente/NOTICE.md`). Ele edita arquivos, roda
comandos, pesquisa na web e conduz tarefas longas até o fim, usando **as APIs que você configurou no JARVIS**. Não precisa de IA local,
de chave própria nem do Claude Code.

## Como abrir
- No app: tela **Programar** → motor **J.A.R.V.I.S. Code** → escolha a pasta → **Iniciar**.
- Fora do app (com o app aberto): `node agente/cli.mjs --pasta=C:\meu\projeto`
- Um pedido só, sem conversa: `node agente/cli.mjs --pasta=. -p "corrija o teste que falha"`

Ele fala com o roteador do app em `127.0.0.1:8787/v1` (chave em `router-token.txt`, que o JARVIS cria). O roteador escolhe a API, troca de
modelo quando a cota de uma acaba e respeita "Grátis"/"Autorizo gasto". Para fixar uma IA use `/modelo` (setas ↑↓ e Enter).

## O que ele tem
| Ferramenta | Para quê |
|---|---|
| `read_file` | ler com números de linha, paginado |
| `write_file` | criar/reescrever; recusa sobrescrever arquivo que não leu; confere por hash; roda lint em `.json/.js/.mjs` |
| `patch` | trocar um trecho com casamento aproximado (9 estratégias) e devolver o diff |
| `search_files` | buscar texto (regex) ou arquivos por nome |
| `terminal` / `process` | comandos em PowerShell (a pasta atual persiste), segundo plano para servidores |
| `web_search` / `web_fetch` | pesquisar e ler páginas (endereços internos bloqueados) |
| `todo_list` | plano de tarefas que sobrevive à compactação do contexto |
| `delegate_task` | subagente com contexto isolado para uma subtarefa |
| `memory` | notas que valem para as próximas sessões |
| `skills_list` / `skill_view` | receitas prontas (`interface-bonita`, `jogo-html5`, `depurar-codigo`); crie as suas em `%APPDATA%\J.A.R.V.I.S\agente\skills\<nome>\SKILL.md` |
| `clarify` | perguntar a você só quando não houver como descobrir |

## Segurança
- Comandos perigosos (apagar recursivo, `git push --force`, `curl | sh`, `reg delete`, ...) **pedem confirmação** (`s` uma vez, `t` para a categoria na sessão, `n` nega).
- Os irremediáveis (formatar disco, apagar a raiz/home/unidade, desligar o PC, bomba de fork) **são sempre bloqueados**, até com `/yolo`.
- `write_file` e `patch` não escrevem em `C:\Windows`, `Program Files`, `.ssh` e pastas de credenciais.
- Texto vindo da web ou de arquivos é dado, não ordem.

## Contexto longo
Quando o prompt passa de ~90k tokens, o agente **poda** resultados antigos de ferramentas (sem usar modelo) e, se ainda for preciso, **resume** o meio da
conversa num texto estruturado (tarefa ativa, ações feitas, arquivos, erros e correções), mantendo o pedido original e as últimas mensagens.
`/compactar [foco]` faz isso na hora.

## Comandos
`/modelo` · `/compactar [foco]` · `/limpar` · `/todo` · `/yolo` · `/skills` · `/memoria` · `/pasta <dir>` · `/tokens` · `/ajuda` · `/sair`. **Esc** interrompe o passo atual.

## Testes
`node --test test/agente/*.test.mjs` (porta do casamento aproximado, aprovação, terminal real, laço com modelo roteirizado, compactação).
