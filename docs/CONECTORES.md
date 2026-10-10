# Conectores

Serviços externos que o JARVIS pode **consultar e, com a sua permissão, alterar**: GitHub, Notion, Slack, Home Assistant e outros. Ficam na tela **Conectores**. Tudo começa desligado.

## Como usar
1. Abra **Conectores**, ache o serviço (há busca) e preencha os campos. A chave é cifrada neste PC (DPAPI) e só é enviada ao próprio serviço. Em "O que o agente poderá fazer" aparece onde achar a chave e a lista exata de recursos.
2. **Salvar** e **Testar** (faz uma chamada de leitura sem efeito, só para confirmar que a chave funciona).
3. Ligue o conector. A partir daí o agente enxerga os recursos de **leitura**.
4. Se quiser que ele também **altere** algo (criar issue, enviar mensagem, mudar um registro), ligue "Permitir alterações". Mesmo assim, cada alteração pede a sua confirmação mostrando o serviço, o método, o endereço e os dados que serão enviados. Ações sem volta (apagar, enviar e-mail) vêm marcadas.

O agente descobre o que existe pela ferramenta `conector_lista`. Nas missões, o papel "engenharia" e o "geral" podem usar conectores; os papéis de leitura/pesquisa não.

## Catálogo (35)
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
| Google (login pelo navegador) | Gmail, Google Drive, Google Agenda, Google Planilhas, Google Docs, Google Tarefas, Google Contatos |
| Genérico | API REST personalizada (qualquer serviço HTTP/JSON: endereço, cabeçalho e chave são seus) |

Cada conector tem de 1 a 10 recursos (136 no total). Os painéis (tela Painéis) também podem usar os recursos de leitura como fonte de dados.

## Login com Google (OAuth, no navegador)
Os sete serviços Google usam **um login só**, feito no **navegador do sistema**: a senha e a verificação em duas etapas nunca passam pelo JARVIS.

**Uma vez (5 minutos):** o JARVIS não traz um "app Google" próprio (isso exigiria revisão do Google e deixaria o seu acesso dependente de terceiros). Você cria o seu: console.cloud.google.com › projeto › APIs e serviços › ative as APIs que for usar › tela de consentimento OAuth (Externo, com o seu e-mail; **publique em "Em produção"**, senão o Google derruba o acesso a cada 7 dias) › Credenciais › ID do cliente OAuth tipo **"App para computador"**. Cole o ID e a chave secreta na tela Conectores › Conta Google. O aviso "app não verificado" que o Google mostra é normal (o app é o seu): Avançado › Continuar.

**Como funciona, com cuidado:**
- Authorization Code + **PKCE (S256)** + `state` aleatório; o retorno vem a um servidor local em `127.0.0.1` numa porta aleatória, que existe só durante o login (5 min), atende um único caminho, confere o cabeçalho Host (contra páginas de DNS rebinding) e o `state` (um pedido forjado é ignorado e não cancela o login de verdade) e fecha ao terminar.
- **Permissões mínimas e em etapas.** Entrar pede só identidade (`openid email`). Ligar um serviço pede só as permissões de **leitura** dele; "Permitir alterações" pede uma **segunda autorização** com as de escrita. Os escopos vêm do catálogo no JARVIS: a tela só pode nomear um serviço e um nível, nunca um escopo. Gmail escreve só com `gmail.compose` (rascunhos e envio), Drive só com `drive.file` (apenas arquivos criados pelo JARVIS), Agenda com `calendar.events`. Contatos é só leitura. Convites a outras pessoas nunca são enviados pela Agenda.
- Só o **refresh token** e a chave secreta ficam guardados, no cofre cifrado (DPAPI). O token de acesso vive só na memória e é renovado 1 minuto antes de vencer (uma renovação por vez). Nenhum token vai para a tela, para um resultado ou para o log.
- **Sair** revoga o acesso no Google e apaga tudo local; todos os serviços Google se desligam na hora. Se o Google encerrar a sessão (você revogou na conta Google, ou o app em modo de teste passou de 7 dias), a conta aparece como desconectada com o motivo, e não há nova tentativa às escondidas.
- Se, na tela do Google, você desmarcar uma permissão (o Google permite), o interruptor **não** liga, nada fica em loop e o cartão da conta explica.
- Gmail: **enviar** é sempre "sem volta" e confirmado; há também **rascunho**. Cabeçalhos com quebra de linha e destinatários fora do formato simples são recusados (injeção de cabeçalho).
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
- `test/agent/google.test.mjs` (10): cliente, PKCE/state/Host, troca de código, negação e tempo esgotado, renovação única e em cache, `invalid_grant`, sair/revogar, consentimento em etapas e parcial, e o Gmail inteiro pelo conector (busca, rascunho, envio com MIME e proteção contra injeção de cabeçalho).
- Chamadas **reais** a serviços: só os quatro sem chave foram exercitados (Wikipedia, Open-Meteo, Hacker News, Câmbio: busca, resumo, previsão e conversão voltaram dados reais). Os demais foram escritos pela documentação pública de cada API e conferidos contra um servidor local, **mas não foram chamados com contas reais**. O botão Testar mostra na hora se alguma chave ou rota não confere.
- Login pelo navegador só existe para o Google. Microsoft 365, Spotify e Dropbox usariam o mesmo molde (google.mjs) e ainda não foram feitos; um cliente MCP para plugar servidores prontos também fica para depois.
- O fluxo do Google foi testado contra um Google simulado (token, renovação, revogação, invalid_grant, consentimento parcial) e o servidor de retorno com requisições reais. Contra o Google de verdade só confirmei que o endereço de autorização gerado é aceito (ele respondeu invalid_client para um ID falso, o esperado); **o login completo com a sua conta é o primeiro teste de verdade, e é seu**.
- O modelo local pequeno escolhe mal entre dezenas de ferramentas: só as dos conectores ligados entram no prompt, e conectores combinam melhor com uma IA mais forte.
