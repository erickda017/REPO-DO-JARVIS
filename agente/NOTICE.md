# Aviso de atribuição

O agente **J.A.R.V.I.S. Code** reimplementa, em JavaScript, técnicas e partes do código do **Hermes Agent**, de Nous Research
(<https://github.com/NousResearch/hermes-agent>), distribuído sob a licença MIT:

```
MIT License

Copyright (c) 2025 Nous Research

Permission is hereby granted, free of charge, to any person obtaining a copy of this software and associated documentation
files (the "Software"), to deal in the Software without restriction, including without limitation the rights to use, copy,
modify, merge, publish, distribute, sublicense, and/or sell copies of the Software, and to permit persons to whom the Software
is furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES
OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE
LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN
CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.
```

## O que veio do Hermes

| Arquivo aqui | Origem no Hermes | O que foi portado |
|---|---|---|
| `lib/fuzzy.mjs`, `lib/difflib.mjs` | `tools/fuzzy_match.py` | As 9 estratégias de casamento aproximado das edições, as guardas contra escapes duplicados, o reajuste de indentação, a preservação de tipografia Unicode e as dicas "quis dizer?" |
| `lib/tools/files.mjs` | `tools/file_tools.py`, `file_operations*.py` | `read_file` (LINHA\|CONTEÚDO, paginação, cortes), `write_file` (recusa sobrescrever sem leitura atual, verificação por hash, lint), `patch`, `search_files` |
| `lib/tools/terminal.mjs` | `tools/terminal_tool.py`, `process_registry.py` | Descrição e regras do `terminal`, primeiro plano/segundo plano, corte de saída com arquivo completo, `process` |
| `lib/approval.mjs` | `tools/approval_detection.py` | Padrões de comando perigoso (camada Windows/PowerShell e POSIX) e a distinção entre "pede aprovação" e "bloqueado sempre" |
| `lib/todo.mjs` | `tools/todo_tool.py` | Lista de tarefas revisionada e reinjeção depois da compactação |
| `lib/compress.mjs` | `agent/context_compressor.py` | Poda de resultados antigos sem modelo, resumo estruturado do meio da conversa, resumo determinístico de reserva, cauda protegida sem separar chamada e resultado |
| `lib/prompt.mjs` | `agent/prompt_builder.py` | Blocos de orientação: uso obrigatório de ferramentas, disciplina de execução, "terminar o trabalho", chamadas em paralelo, diretivas operacionais |
| `lib/loop.mjs` | `agent/conversation_loop.py`, `tool_executor.py` | Laço com chamadas de ferramenta nativas, execução concorrente das leituras, orçamento de passos com chamada final, recuperação de resposta vazia e de "prometeu e não fez" |
| `lib/tools/misc.mjs` | `tools/memory_tool*.py`, `skills_tool.py`, `delegate_tool.py` | Memória persistente, skills (`SKILL.md`), subagente com contexto isolado |

O resto (roteador de APIs com troca automática, interface do terminal, integração com o app) é do projeto J.A.R.V.I.S.
