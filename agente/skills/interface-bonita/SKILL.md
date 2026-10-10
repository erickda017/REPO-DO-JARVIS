---
name: interface-bonita
description: Telas e páginas que parecem profissionais (login, dashboard, landing, formulários) em HTML/CSS/JS de um arquivo só
---
# Interface bonita em um arquivo

Use quando o pedido for uma tela, página ou componente visual. O objetivo é um resultado que parece produto de verdade, não HTML cru.

## Receita
1. Escreva **um único `index.html`** autocontido (CSS no `<style>`, JS no `<script>`), sem dependências externas. Fontes: `system-ui, -apple-system, "Segoe UI", Roboto, sans-serif`.
2. **Tokens no `:root`**: cores (fundo, superfície, texto, texto-suave, primária, perigo, borda), raio (`--r: 14px`), sombra suave, espaçamentos em múltiplos de 4/8. Suporte a tema escuro com `@media (prefers-color-scheme: dark)`.
3. **Layout**: `body { min-height: 100vh; display: grid; place-items: center; }`, cartão central com `max-width: 400px; width: min(92vw, 400px)`, padding 32–40px, fundo em gradiente sutil ou malha de cores desfocadas atrás do cartão.
4. **Tipografia**: título 28–32px peso 650–700, subtítulo na cor suave, rótulos 13–14px, `letter-spacing` leve nos títulos.
5. **Campos**: altura 44–48px, borda 1px, raio 10–12px, ícone ou rótulo flutuante, `:focus-visible` com anel de 3–4px na cor primária (translúcido). Botão principal largura total, altura 46–48px, gradiente ou cor sólida forte, `transition` de 150ms, `:hover` levanta 1px, `:active` afunda, estado `disabled`/carregando com spinner.
6. **Comportamento real**: validação inline (e-mail válido, senha mínima), mensagem de erro abaixo do campo com `aria-live`, botão de mostrar/ocultar senha, "lembrar de mim", link de recuperação, estado de carregamento simulado ao enviar. Acessibilidade: `<label for>`, `autocomplete`, contraste ≥ 4.5:1, foco visível, `prefers-reduced-motion`.
7. **Detalhes que fazem diferença**: animação de entrada do cartão (fade + 8px de subida), alinhamento ótico, ícones em SVG inline, favicon em data-URI, `<meta name="viewport">`.

## Verificação
- Abra o arquivo (`Start-Process index.html`) e confira em largura de celular (≈375px) e desktop. Se houver ferramenta de captura, tire print; senão revise o CSS para não haver overflow horizontal.
- Não declare pronto sem ter escrito o arquivo completo e conferido que carrega sem erro no console.
