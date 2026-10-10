---
name: depurar-codigo
description: Método para achar e consertar um bug com evidência (reproduzir, isolar, consertar na causa, provar com teste)
---
# Depurar com evidência

1. **Reproduza primeiro.** Rode o comando/teste que falha e copie a mensagem exata. Sem reprodução, não há conserto — peça o passo a passo só se não der para descobrir sozinho.
2. **Localize.** `search_files` pelo texto do erro e pelos nomes na pilha; leia o trecho com `read_file` (as linhas ao redor, não só a linha do erro). Procure **todos os chamadores** da função suspeita antes de editar.
3. **Hipótese → prova.** Diga em uma frase a causa provável e confirme com uma leitura ou um comando curto (log, `node -e`, teste mínimo). Não edite no escuro.
4. **Conserte na causa**, no ponto onde todos os caminhos passam, com o menor diff que resolve. Use `patch` (não reescreva o arquivo inteiro) e confira o diff devolvido.
5. **Prove.** Rode de novo o comando que falhava e a suíte relevante; leia a saída. Código de saída 0 só vale se o teste cobre o caso — se não cobre, escreva um teste que falha antes e passa depois.
6. **Relate**: causa, mudança (arquivo:linha), e o resultado real dos testes. Se algo continuar falhando, diga o quê.
