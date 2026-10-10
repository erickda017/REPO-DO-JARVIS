# Servidores MCP

O **MCP (Model Context Protocol)** é o padrão aberto para dar ferramentas a uma IA: há centenas de servidores prontos (arquivos, navegador, bancos de dados, documentação, GitHub, memória…). O JARVIS é cliente MCP: na tela **Servidores MCP** você adiciona servidores e escolhe, **ferramenta por ferramenta**, o que o agente pode usar. Nada vem ligado.

## Como usar
1. **+ Adicionar servidor**. Comece por uma sugestão (arquivos, memória, raciocínio em etapas, Context7, Playwright, fetch, git, hora, GitHub remoto) ou preencha à mão. Confira o comando: o JARVIS mostra a linha exata e pede confirmação antes de qualquer programa rodar.
2. **Ligue** o servidor. Ele inicia, o JARVIS lista as ferramentas dele e **todas aparecem desligadas**.
3. Para cada ferramenta: *Desligada*, *Pedir confirmação* (a cada uso, mostrando a ferramenta e os argumentos) ou *Sem confirmação (leitura)*. O botão "Liberar as marcadas como só leitura" aceita, de uma vez, as dicas `readOnlyHint` do servidor: é uma escolha sua e explícita.
4. O agente passa a ver só o que você ligou (`mcp_<servidor>_<ferramenta>`). O prompt dele não lista ferramentas desligadas.

Dois tipos de servidor:
- **Programa local (stdio):** um comando que roda no seu PC (`npx`, `uvx`, `node`…). Precisa do que o comando exige (Node para `npx`, [uv](https://docs.astral.sh/uv/) para `uvx`). Reinicia sozinho se cair (até 3 vezes), e é encerrado, com os processos filhos, ao desligar ou ao sair do JARVIS.
- **Servidor remoto (HTTP):** um endereço (https; http só para este PC ou a rede local) com cabeçalho de autenticação guardado cifrado. Suporta o transporte *Streamable HTTP* (respostas JSON ou em fluxo SSE, sessão por `Mcp-Session-Id`). Não faz login OAuth do MCP: serve para servidores com token/chave fixo.

## Modelo de confiança
Um servidor é código ou serviço de terceiros. Nada que ele diz é acreditado.
- **Só você adiciona, edita e liga.** O agente não tem ferramenta para isso, e o modelo nunca inicia processo nenhum. Programas locais exigem a sua confirmação, vendo o comando, ao salvar e ao ligar.
- **Tudo desligado por padrão**, inclusive ferramentas que um servidor passe a oferecer depois.
- **As dicas do servidor são só sugestões.** Um servidor pode declarar "só leitura" e apagar arquivos: por isso a dica nunca dispensa a sua escolha.
- **Proteção contra troca de definição ("rug pull").** A descrição e os parâmetros aprovados de cada ferramenta são fixados por hash. Se o servidor mudar qualquer um depois, a ferramenta **volta a desligada e fica marcada** até você olhar de novo.
- **Descrições são texto de terceiros** que entra no prompt do agente: achatadas, cortadas em 160 caracteres e marcadas como texto do servidor; o prompt manda tratá-las como dado. As instruções (`instructions`) que o servidor envia ao iniciar são ignoradas.
- **Resultados são conteúdo externo**: depois de ler um, qualquer alteração pede confirmação extra ("foi você quem pediu?"). Limite de 24 mil caracteres por resultado; imagens e binários são descritos, nunca embutidos.
- **Ambiente mínimo.** O programa recebe só uma lista curta de variáveis do sistema (PATH, TEMP…) mais as que você configurar. **Nunca** as chaves e tokens do JARVIS. Roda numa pasta neutra (`data/mcp-work`), sem shell (no Windows, `.cmd` como `npx` passa por `cmd.exe` só depois de recusar `& | < > ^ % " e crase` em cada argumento).
- **O servidor não alcança o JARVIS.** O cliente não oferece nenhuma capacidade: pedidos do servidor para usar o nosso modelo (*sampling*), listar pastas (*roots*) ou perguntar a você (*elicitation*) são respondidos com "método não encontrado".
- **Segredos** (variáveis marcadas como segredo e valores de cabeçalho) vão para o cofre cifrado (DPAPI), nunca para `mcp.json`, para a tela, para erros ou para o registro. Se um servidor devolver um segredo, ele vira `***`.
- Limites: 12 servidores, 40 ferramentas expostas por servidor, 60 chamadas por minuto, 60 s por chamada, mensagens de até 4 MB. Redirecionamentos HTTP nunca são seguidos. Endereços de metadados de nuvem e link-local são recusados.
- Pedidos marcados como **sensíveis** nunca usam MCP. A auditoria guarda servidor, ferramenta e sucesso, sem argumentos nem saída.
- Nas missões, os papéis "engenharia" e "geral" podem usar MCP; os de leitura/pesquisa não.

## Testes
- `test/agent/mcp.test.mjs` (14), com um servidor MCP de teste real por stdio (`test/fixtures/mcp-fake-server.mjs`) e um servidor HTTP real: handshake, paginação, ruído no stdout, pedido de *sampling* recusado, ambiente isolado, timeout, validação de comando, tudo desligado por padrão, modos por ferramenta, coerção de argumentos por esquema, troca de descrição desligando a ferramenta, limite de tamanho e de taxa, segredo mascarado, reinício após queda, persistência entre execuções, HTTP com sessão/SSE/token errado/redirecionamento e o laço do agente (confirmação negada/aprovada, pedido sensível, prompt só com o que está ligado).
- **Servidor oficial de verdade:** rodei `@modelcontextprotocol/server-filesystem` e `@modelcontextprotocol/server-memory` via `npx` pelo gerenciador e pela API do bridge: listaram ferramentas, executaram (listar pasta, ler arquivo, ler grafo), o servidor recusou uma pasta fora da permitida, desligar a ferramenta a removeu do agente e nenhum processo ficou para trás.

## Limites
- Só **ferramentas**. *Resources*, *prompts*, *sampling* e *elicitation* não são usados.
- Sem login OAuth para servidores remotos (só cabeçalho fixo) e sem o transporte HTTP+SSE antigo (anterior a 2025).
- Se o JARVIS for encerrado à força (sem passar pelo encerramento normal), um servidor local bem-comportado sai sozinho ao perder o canal de entrada, mas um que ignore isso pode ficar vivo: ele aparece no Gerenciador de Tarefas.
- Muitas ferramentas confundem o modelo local pequeno: ligue só as que vai usar.
