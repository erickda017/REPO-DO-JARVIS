---
name: jogo-html5
description: Criar um jogo simples completo (Flappy Bird, Snake, Pong, Breakout...) em um único arquivo HTML com canvas
---
# Jogo HTML5 em um arquivo

Use para qualquer pedido do tipo "faça um jogo como X". **Escreva o jogo inteiro de uma vez** — não passe tempo planejando sem criar arquivos.

## Receita
1. Crie `index.html` com `<canvas>` e todo o JS inline. Tamanho lógico fixo (ex.: 400×600) escalado por CSS para caber na janela, `image-rendering` nítido, fundo da página escuro, canvas centralizado com borda arredondada e sombra.
2. **Estrutura do código**: constantes de ajuste no topo (gravidade, impulso, velocidade, espaço entre canos), objeto `state` (`ready | playing | over`), `reset()`, `update(dt)`, `draw()`, e o laço com `requestAnimationFrame` usando delta-time limitado (`Math.min(dt, 1/30)`).
3. **Entrada**: teclado (Espaço/↑), mouse e toque no mesmo handler (`pointerdown`), `preventDefault` para não rolar a página. Tela inicial "Toque para começar" e tela de fim com pontuação, recorde (`localStorage` em try/catch) e "Jogar de novo".
4. **Física e colisão**: integração simples (velocidade += g·dt; posição += v·dt), colisão círculo/retângulo ou AABB, margem de perdão pequena. Pontuar ao passar um obstáculo uma única vez.
5. **Visual sem imagens**: desenhe tudo com formas e gradientes (céu em gradiente, nuvens, canos com borda e brilho, personagem com asa animada, chão em movimento com paralaxe). Fonte do placar em negrito com contorno. Efeitos: leve inclinação do personagem conforme a velocidade, partículas na colisão, "shake" curto.
6. **Som opcional** com WebAudio (bipes curtos para pulo/ponto/batida), iniciado só após o primeiro gesto do usuário.

## Verificação
- Releia o arquivo procurando erros de sintaxe, depois `node --check` não vale para HTML; extraia o `<script>` ou abra no navegador: `Start-Process index.html`.
- Confirme que existe: tela inicial, jogo rodando, game over, reinício, placar e recorde. Só então diga que está pronto.
