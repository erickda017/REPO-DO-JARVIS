# Design — J.A.R.V.I.S desktop app (holographic HUD)

Recorded from the built app (`app/renderer`), not from intention.

## World
Near-black blue field with a faint cyan glow, fine cyan line work and corner brackets, status carried by green / amber / red / hollow rings. The centre of the product is a 3D neural scene; everything else is quiet furniture around it. Dark by use scene: a desk in a dim room, long sessions, a screen that should not glare.

## Tokens (`styles.css :root`)
- Field: `--bg #02060a`, `--bg-2 #05101a`, panels `rgba(7,22,34,.78)`.
- Line: `--line rgba(92,214,255,.2)`, `--line-strong rgba(92,214,255,.55)`.
- Accent: `--cyan #4fd8ff`, `--cyan-hi #bff4ff`. Text `#d7f3ff`, dim `#8fb2c1`.
- Status: ok `#3ff0b0`, warn `#ffcb5c`, bad `#ff7189`, off `#4b6a78`; unknown is a hollow ring, never a colour alone.
- Motion ease: `cubic-bezier(.16,1,.3,1)`; `prefers-reduced-motion` stops the scene rotation, ambient firing and all transitions.

## Type
Chakra Petch (500/600/700) for labels, headings, numerals; Barlow Semi Condensed (400/500/600) for body. Headings uppercase with tracking; body 15 px; `tabular-nums` throughout.

## Components
- **Corner-bracket card** (`.float-card`): gradient panel, 1 px line, two 12 px cyan corner brackets, blur-in entrance, draggable, flows down the left edge and wraps instead of overlapping.
- **Command bar**: panel with a cyan send button, option chips (Sensível / Autorizo gasto / Falar) as pressed-state toggles, suggested commands under it.
- **Sidebar**: 5 items, active state = brighter text + tinted fill + strong line.
- **Status dot**: solid for ok/warn/bad, hollow ring for unknown.
- **Neural scene** (`neural/Scene.tsx`): large nodes are real entities coloured by measured state; the 320-neuron cloud is decorative and labelled as such on screen. Pulses travel core → node on real bridge events, then fire through nearby neurons.

## Rules that must survive redesigns
Unknown never renders as healthy. Secrets never render. Model-supplied media URLs load only after a click. Cloud neurons never carry data.
