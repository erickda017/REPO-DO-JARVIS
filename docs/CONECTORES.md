# Conectores

Serviços externos que o JARVIS pode **consultar e, com a sua permissão, alterar**: GitHub, Notion, Slack, Home Assistant e outros. Ficam na tela **Conectores**. Tudo começa desligado.

## Como usar
1. Abra **Conectores**, ache o serviço (há busca) e preencha os campos. A chave é cifrada neste PC (DPAPI) e só é enviada ao próprio serviço. Em "O que o agente poderá fazer" aparece onde achar a chave e a lista exata de recursos.
2. **Salvar** e **Testar** (faz uma chamada de leitura sem efeito, só para confirmar que a chave funciona).
3. Ligue o conector. A partir daí o agente enxerga os recursos de **leitura**.
4. Se quiser que ele também **altere** algo (criar issue, enviar mensagem, mudar um registro), ligue "Permitir alterações". Mesmo assim, cada alteração pede a sua confirmação mostrando o serviço, o método, o endereço e os dados que serão enviados. Ações sem volta (apagar, enviar e-mail) vêm marcadas.

O agente descobre o que existe pela ferramenta `conector_lista`. Nas missões, o papel "engenharia" e o "geral" podem usar conectores; os papéis de leitura/pesquisa não.

## Catálogo (28)
| Categoria | Conectores |
|---|---|
| Código | GitHub, GitLab (gitlab.com ou o seu servidor), Sentry |
| Nuvem e hospedagem | Vercel, Netlify, Cloudflare (DNS) |
| Dados | Supabase (tabelas via REST), Airtable |
| Produtividade | Notion, Todoist, Trello, Asana, Linear, ClickUp, Jira Cloud |
| Mensagens | Slack, Discord (bot), Discord (webhook), Telegram (bot), ntfy (notificação no celular), Resend (e-mail) |
| Casa | Home Assistant (luzes, tomadas, sensores, cenas) |
| IA e dados | Hugging Face |
| Consulta aberta (sem conta nem chave) | Wikipedia, Open-Meteo (clima), Hacker News, Câmbio |
| Genérico | API REST personalizada (qualquer serviço HTTP/JSON: endereço, cabeçalho e chave são seus) |

Cada conector tem de 1 a 10 recursos (109 no total). Os painéis (tela Painéis) também podem usar os recursos de leitura como fonte de dados.

## Regras de segurança (valem para todos)
- **Desligado por padrão**, e as permissões são separadas: ligar (ler) ≠ permitir alterações. Retirar a permissão remove as ferramentas de escrita na hora.
- **Confirmação em toda alteração**, com os dados reais. Depois de ler conteúdo externo, o agente pergunta de novo ("foi você quem pediu?").
- **Só vai para o servidor do serviço** (lista fixa por conector, sempre https). Nos serviços que você hospeda (Home Assistant, GitLab próprio, ntfy, REST) vale o endereço que você digitou, menos endereços de metadados de nuvem/link-local. **Redirecionamentos nunca são seguidos** (levariam a chave a outro servidor).
- Parâmetros de caminho são codificados e `..` é recusado; filtros não aceitam quebra de linha.
- Respostas limitadas a 1,5 MB (e a 24 mil caracteres para o modelo); **20 s** de limite; **40 chamadas por minuto** por conector.
- A chave nunca aparece em resultado, erro, lista da tela ou log de auditoria (o log guarda só conector, ferramenta e status). Se a API devolver a própria chave, ela é trocada por `***`.
- Pedidos marcados como **sensíveis** nunca usam conectores.
- O que um serviço devolve é **dado, nunca ordem**.

## Como acrescentar um serviço
É dado, não código: uma entrada em `bridge/agent/conectores.catalog.mjs` (endereço base, hosts permitidos, campos, tipo de autenticação e a lista de recursos com método, caminho, parâmetros e risco). O motor (`conectores.mjs`) transforma isso em requisições reais e registra as ferramentas `<conector>_<recurso>` só enquanto o conector estiver ligado. O teste `test/agent/conectores.test.mjs` percorre todo o catálogo e falha se uma entrada violar as regras acima.

## Testes e limites
- `test/agent/conectores.test.mjs` (11): estrutura do catálogo, **todas** as requisições de todos os recursos (host permitido, https, credencial no lugar certo, nada `undefined`), ciclo ligar/escrever/apagar, texto de confirmação, HTTP real contra um servidor local (cabeçalho, query, corpo JSON, evidência), redirecionamento recusado, resposta gigante, segredo ecoado, endereços proibidos, limite de chamadas, auditoria sem segredos e o laço do agente (leitura, confirmação negada/aprovada, pedido sensível).
- Chamadas **reais** a serviços: só os quatro sem chave foram exercitados (Wikipedia, Open-Meteo, Hacker News, Câmbio: busca, resumo, previsão e conversão voltaram dados reais). Os demais foram escritos pela documentação pública de cada API e conferidos contra um servidor local, **mas não foram chamados com contas reais**. O botão Testar mostra na hora se alguma chave ou rota não confere.
- Não há login OAuth (Google Drive/Gmail/Calendário, Microsoft 365, Spotify, Dropbox): exigem fluxo no navegador e tokens que expiram. São o próximo passo natural, junto de um cliente MCP para plugar centenas de servidores prontos.
- O modelo local pequeno escolhe mal entre dezenas de ferramentas: só as dos conectores ligados entram no prompt, e conectores combinam melhor com uma IA mais forte.
