# IA local, só APIs e "quem respondeu"

## Desligar a IA local de verdade
O botão **Desligar tudo** (tela IA local) roda o `PARAR_IA.bat` do projeto da IA e depois **confere**: olha quem ainda escuta nas portas 8080/8081/8082. O que sobrar e for da IA local (`llama-server`, ou o servidor Node da C.R.I.S) é encerrado à força, com os filhos; uma segunda olhada pega o que voltar sozinho. Programas que **não** são da IA local nunca são encerrados. Se algo continuar de pé, o botão mostra o motivo com o nome e o PID (por exemplo "porta 8082: llama-server.exe (PID 1234), religou sozinho"), em vez de dizer que deu certo. Testes com processos reais: `test/app/ia-stop.test.ts`.

## Usar só as APIs
Na tela **IAs** (e no topo da tela IA local) há o interruptor **Usar só as APIs**. Ligado, nenhuma resposta, agente, missão, painel ou chamada do roteador `/v1` usa a IA local; só as APIs ligadas. Ao ligar, o app oferece desligar a IA local para liberar RAM.
- Provedores pagos continuam exigindo "Autorizo gasto" no pedido (ou ser marcados como **Grátis**). A mensagem de bloqueio diz isso.
- Pedidos marcados como **Sensíveis** não funcionam nesse modo (eles nunca saem do PC): o erro explica.
- Sem nenhuma API pronta o erro diz o que falta (ligar uma na tela IAs, com chave e modelo), em vez de uma recusa genérica.
- As funções de agente (conversa com ferramentas, missões, painéis) não dependem da IA local: elas usam o roteador, e o roteador usa o que estiver disponível.

## Qual modelo respondeu
Cada resposta do agente registra o provedor e o modelo que **realmente** responderam (e todos, em ordem, se um falhou e outro assumiu). Aparece na legenda da tela inicial ("respondido por gemini · gemini-2.5-flash") e na linha de detalhes de cada mensagem do histórico.

## Pesquisa na internet
Ler a internet não pede autorização. Enquanto busca, o JARVIS mostra (e fala, se a voz estiver ligada) "Só um momento, buscando na web…"; a resposta abre com "Isto foi o que consegui encontrar:" e fecha com as páginas que as ferramentas realmente devolveram. Escrever algo no PC depois de ler a internet continua pedindo confirmação (proteção contra instruções escondidas em páginas).

## Agente do terminal (pasta `ia-local\agente-codigo`, fora do git)
- `/modelo` abre uma lista para escolher com **↑ ↓ e Enter** (Esc cancela): as IAs do JARVIS (`jarvis · auto` ou uma API específica), `externo` e os modelos locais, com ● respondendo / ○ desligado.
- **Não depende da IA local.** Ao abrir, se o modelo escolhido não responde, o agente passa sozinho para o próximo que responde (as APIs do JARVIS, depois os modelos do `.env`) e avisa. O modo `jarvis` usa o roteador do app (`http://127.0.0.1:8787/v1`) com a chave que o JARVIS guarda; não precisa de `.env`. Cada resposta mostra `via provedor/modelo`.
- Buscar na web e ler páginas **não pedem permissão** (só trazem texto, marcado como dado); mostra "Só um momento, buscando na web…" e fecha com "Isto foi o que consegui encontrar na web." e as fontes. Baixar arquivo e consultar modelo externo continuam pedindo.
- Testes: `node --test` dentro da pasta (53, incluindo o menu e o modo JARVIS). Verificado também com um bridge real e uma API de teste (a IA local desligada, a busca real na web) e a lista `/modelo` navegada em um pseudo-terminal real.
