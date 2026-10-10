# Comandos prontos, controle do PC e da interface

Frases simples viram uma **ação pronta, na hora, sem chamar IA** (nada de esperar o modelo, nem gastar cota). Elas passam pelo mesmo caminho de
permissões, confirmações e verificação do resto do agente. Frases com mais de uma parte, ou que não reconheço, vão para a IA normalmente.
Vale por texto, por voz e dentro de uma missão de um passo só (`missão: mude o tema para roxo` conclui sem planejar nem chamar modelo).

## O que entendo
| Peça | Exemplos |
|---|---|
| **Cores do JARVIS** | "mude o tema para vermelho", "deixa tudo roxo", "tema lilás", "quais temas existem?" |
| **Telas** | "abra a tela de conectores", "vá para missões", "abre o sistema" |
| **Chaves da interface** | "desligue a voz", "ative o autorizo gasto", "ligue só APIs" |
| **Informação** | "que horas são?", "como está o meu pc" (cartão na tela), "o que está consumindo memória?", "qual a temperatura", "bateria", "qual é o meu IP", "como estão as IAs" |
| **Volume e mídia** | "volume 40", "aumenta o volume", "muta o som", "pausa a música", "próxima música" |
| **Tela e sessão** | "tire um print" (salva em Imagens\JARVIS), "bloqueie o computador" |
| **Pastas** | "abra a pasta downloads", **"analise a pasta C:\caminho\do projeto"** (tamanho, linguagens, arquivos-chave, `package.json`, README, git, sem IA; se a pasta não está liberada, peço confirmação) |
| **Limpeza e energia** | "esvazie a lixeira", "limpe os temporários", "desligue o pc em 10 minutos", "cancele o desligamento" (todas com confirmação) |
| **Abrir** | "abra o navegador", "abre o discord", "abra o yt music", "procure gatos no youtube" |

## Cores
Botão da paleta na barra do topo (ou peça por texto/voz): **azul, vermelho, laranja, âmbar, verde, turquesa, roxo, lilás, magenta, rosa e gelo**.
Muda o app inteiro, a rede neural 3D, as partículas e o terminal, e fica salvo entre as sessões.

## Controle total pela IA
Quando o pedido não é um comando pronto, a IA também tem as ferramentas: `interface_theme`, `interface_view`, `interface_set`, `interface_card`,
`interface_state` (o que está aberto agora), `ia_status`, `ia_set` (ligar/desligar uma IA, marcar Grátis, trocar o modelo, com confirmação),
`volume_control`, `media_key`, `screenshot`, `lock_pc`, `folder_open`, `power_action`, `recycle_empty`, `project_overview`, `clock_now`…
Grupos novos na tela Agente: **Controle do computador** e **Interface** (ligados por padrão; as ações de risco sempre confirmam).
Chaves de API, conectores e servidores MCP continuam só nas mãos do dono.

## Quando nenhuma IA responde
A mensagem agora diz o motivo de cada uma ("gemini: cota esgotada, volta em ~9 min; groq: paga, marque Grátis…"), a missão **não** repete nem replaneja
(não adianta), e painéis ainda caem para uma tabela quando há dados. Uma resposta vazia de um servidor (ex.: Colab) é refeita sem streaming antes de desistir dele.
