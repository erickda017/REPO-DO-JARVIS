# J.A.R.V.I.S.

Centro de comando pessoal para Windows, com várias IAs, uma interface holográfica com uma rede neural 3D que reage ao que
está acontecendo (requisições, voz, agente) e um assistente que conversa por voz ou texto e **faz coisas de verdade** no
seu PC: abre e organiza arquivos, pesquisa na web, usa serviços como Gmail, Drive e Calendar, e roda servidores MCP.

Você traz as suas próprias contas: **cada pessoa usa as próprias chaves de API**, guardadas só no computador dela.

---

## O que você precisa

- **Windows 10 ou 11.**
- **Node.js 20 ou mais novo** (grátis, <https://nodejs.org>).
- **Pelo menos uma chave de API de IA.** Há planos grátis em Google Gemini, OpenRouter (modelos `:free`), NVIDIA NIM e Groq.
  Você também pode usar um modelo seu rodando no Google Colab (veja abaixo).

Não precisa de Claude Code, de login em nada da Anthropic, de GPU, nem de IA local. Tudo isso é opcional.

Rode `npm run setup` para uma verificação em linguagem simples do que está pronto na sua máquina.

---

## Começando

```bash
git clone <endereço deste repositório>
cd <pasta>
npm install
npm start
```

`npm start` compila e abre o aplicativo desktop. Na primeira vez demora um pouco.

### Primeiros passos dentro do app

1. Abra a tela **IAs**.
2. Escolha um provedor (por exemplo Gemini), cole a **chave**, clique em **Salvar chave** e depois em **Checar**.
3. Escolha o **modelo** na lista e clique em **Usar modelo**. Ligue o interruptor **Ligada**.
4. Se o modelo não cobra, marque **Grátis**. Sem isso, o JARVIS só usa uma IA paga quando você marca "Autorizo gasto" no pedido.
5. Pronto: escreva ou fale na barra de comandos da tela inicial.

### Dicas sobre as IAs

- **Modelos permitidos:** em cada provedor você lista os modelos que aceita usar, em ordem. Se a cota de um acabar, o JARVIS
  passa para o próximo da lista e depois para o próximo provedor, sozinho.
- **Mais de uma chave:** o botão **+ Outra chave** cria outra entrada do mesmo serviço (Gemini, OpenRouter...) com chave própria.
- **Usar só as APIs:** interruptor no topo da tela IAs. Ignora qualquer IA local.
- **Qual IA respondeu:** a legenda mostra "respondido por provedor · modelo", e o histórico também.
- **Pedidos sensíveis** (marcados como tal) nunca saem do seu PC: só uma IA local pode responder.
- **Colab (túnel Cloudflare):** se você roda um modelo no Google Colab com `llama-cpp-python` e `cloudflared`, abra o cartão
  "Colab" na tela IAs, cole a URL `https://algo.trycloudflare.com` e salve. A URL muda a cada sessão do Colab: é só colar a nova,
  sem reiniciar o JARVIS. Se ela parar de responder, o JARVIS avisa.

Detalhes em [docs/IA_LOCAL_E_APIS.md](docs/IA_LOCAL_E_APIS.md).

---

## O que ele faz

- **Conversa e agente:** responde por texto ou voz e usa ferramentas do PC (arquivos, processos, disco, janelas) com um sistema de
  permissões. Leitura é livre; **qualquer mudança pede a sua confirmação**.
- **Pesquisa na web:** ler a internet não pede autorização. Ele avisa "Só um momento, buscando na web…" e mostra as fontes.
- **Missões:** tarefas maiores divididas entre agentes especializados.
- **Painéis:** o JARVIS desenha painéis na tela com dados reais.
- **Voz:** ouve pelo microfone (escolha o microfone e teste o nível na tela de Voz) e fala. Atalho global: `Ctrl+Alt+J`.
- **Bandeja do sistema:** fica ao lado do relógio e pode iniciar junto com o Windows (menu da bandeja → "Iniciar com o Windows").
- **Tarefas, cronômetro, projetos e serviços:** monitores e listas com a rede neural reagindo.
- **Programar:** um terminal dentro do app com o **J.A.R.V.I.S. Code**, um agente de programação que já vem com o app (edita arquivos com
  casamento aproximado, roda comandos com aprovação, pesquisa na web, mantém um plano de tarefas, compacta o contexto e usa
  subagentes). Ele usa as suas APIs pelo roteador, sem chave própria nem IA local. É baseado nas técnicas do Hermes Agent (MIT); veja
  [docs/AGENTE.md](docs/AGENTE.md). Também há o Terminal comum e, se estiver instalado, o Claude Code.

### Conectores

Serviços que a IA pode ler e, com a sua permissão separada, alterar: Google (Gmail, Drive, Calendar, Sheets, Docs, Tasks,
Contatos), GitHub, Notion, Slack, Wikipedia, clima e muitos outros. Cada um liga e desliga sozinho; **escrever sempre pede
confirmação** mostrando o que vai ser enviado. Veja [docs/CONECTORES.md](docs/CONECTORES.md).

**Login Google:** feito no navegador, com OAuth + PKCE. Você cria o **seu próprio** cliente OAuth ("Aplicativo para computador")
no Google Cloud, cola o ID e o segredo no app, e autoriza no navegador. Só o token de renovação é guardado, cifrado.
O passo a passo está em [docs/CONECTORES.md](docs/CONECTORES.md).

### Servidores MCP

Tela **Servidores MCP**: adicione servidores locais (stdio) ou remotos (HTTP). Tudo começa desligado, ferramenta por ferramenta,
e se um servidor mudar a descrição de uma ferramenta aprovada ela volta a desligada. Veja [docs/MCP.md](docs/MCP.md).

### IA local (opcional)

Se você tem um projeto de IA local (llama-server com `INICIAR_IA.bat` e `PARAR_IA.bat`), aponte a pasta na tela **IA local**
(ou coloque-a em `ia-local/`, que o git ignora). O JARVIS liga, desliga e confere se desligou de verdade. Sem isso, nada muda: ele
usa as APIs.

### Usar o roteador em outros programas

O JARVIS expõe as suas IAs como um servidor no formato OpenAI em `http://127.0.0.1:8787/v1`, só neste PC e com uma chave
(tela IAs → "Roteador para outros programas"). Qualquer ferramenta que fale esse formato ganha a troca automática de IA quando a
cota de uma acaba.

---

## Gerar o instalador (MSI)

```bash
npm run app:dist
```

Gera o MSI e a versão portátil em `release/out/`. Para escolher a versão: `JARVIS_VERSION=1.0.0` (no PowerShell,
`$env:JARVIS_VERSION='1.0.0'`). O MSI instala por usuário, sem pedir administrador, e instalar uma versão nova por cima atualiza a
anterior.

A **assinatura digital é opcional**. Sem certificado o instalador funciona, mas o Windows mostra um aviso de "editor
desconhecido". Para assinar, defina `JARVIS_SIGN_SHA1` (impressão digital de um certificado do seu repositório do Windows) ou
`JARVIS_SIGN_PFX` + `JARVIS_SIGN_PASSWORD`. Veja `scripts/sign-win.cjs`.

---

## Onde ficam os seus dados

Tudo o que é seu fica na pasta de dados do app (`%APPDATA%\J.A.R.V.I.S\data` no app instalado, ou `data/` aqui no modo de
desenvolvimento), que **não vai para o git**:

- chaves de API e segredos dos conectores, cifrados com o Windows (DPAPI), nunca mostrados de volta;
- configurações, tarefas, memória, histórico, log de auditoria;
- a chave do roteador local.

Para desinstalar sem deixar rastro, apague essa pasta.

---

## Segurança

- O bridge só aceita conexões do próprio PC (`127.0.0.1`).
- Chaves ficam cifradas no disco e nunca voltam para a tela; só aparecem os 4 últimos caracteres.
- Escrita em arquivos, serviços e MCP sempre pede confirmação; pedidos sensíveis bloqueiam a web, os conectores e o MCP.
- Texto vindo da internet ou de servidores de terceiros é tratado como **dado**, nunca como instrução.
- Conectores só falam com os endereços fixos de cada serviço, em HTTPS, com limite de tamanho e de ritmo.

---

## Testes

```bash
npm run test:command   # roteador, provedores, configurações
npm run test:agent     # agente, conectores, Google, MCP
npm run test:app       # partes puras do app e o botão de desligar a IA local
```

---

## Interface web antiga

O JARVIS começou como uma página no navegador com palavra de ativação ("Hey Jarvis"), gestos de mão e cérebro no Claude Code.
Ela ainda está em `src/` e roda com `npm run start:web`. **Só ela** exige o Claude Code instalado e logado
(`npm install -g @anthropic-ai/claude-code`, depois `claude` uma vez). O aplicativo desktop não precisa disso.

---

## Documentação

- [docs/COMMAND_CENTER.md](docs/COMMAND_CENTER.md): visão geral do centro de comando e limites
- [docs/IA_LOCAL_E_APIS.md](docs/IA_LOCAL_E_APIS.md): IAs, só APIs, desligar a IA local, pesquisa na web
- [docs/CONECTORES.md](docs/CONECTORES.md): conectores e login Google
- [docs/MCP.md](docs/MCP.md): servidores MCP

---

## Licença

MIT. Os sons de `public/audio/` acompanham o projeto para demonstração: se você for monetizar algo feito a partir dele, liberar
os direitos desse áudio é responsabilidade sua.
