# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Stack

Desktop app: Electron shell + React 19 + TypeScript + Vite, Three.js via @react-three/fiber for the neural visualization. Confirmed by the user (prefers TypeScript, a real app over a single HTML page). Backend is the existing Node bridge (`bridge/`) and its `/api/command/*` API.

## Users

One person (the owner) on a Windows 10 PC (16 GB RAM, modest GPU) running a local llama.cpp model and several API providers, commanding them from one place by text and voice.

## Product Purpose

A personal multi-AI command center, inspired by JARVIS: talk to whichever AI is eligible (local model by default, paid APIs only when authorized), see the health of AIs, services and projects, and manage tasks and a timer. It must keep working without a Claude Code subscription.

## Positioning

Not a chatbot skin: a router and monitor over the owner's own AIs, with honest status (reachable / authenticated / model present / inference worked) and spend/privacy gates.

## Operating Context

Bridge on 127.0.0.1:8787, local llama-server on 8081/8082 (see docs/COMMAND_CENTER.md). Provider status, chat, tasks, timer and ElevenLabs voice settings come from `/api/command/*`.

## Capabilities and Constraints

- The interface must reflect real state; never fake a working AI. Unknown stays "unknown".
- Neural visualization: large nodes are real entities (router core, AIs, services, projects, tasks) with pulses on real requests/checks; the surrounding dense cloud of small neurons is decorative and must be labeled as a metaphor in the UI.
- Dynamic surface: when the owner asks JARVIS something, information appears as floating bubbles, text boxes, images and videos over the neural scene.
- Secrets (API keys) never reach rendered UI; only configured/last-4.
- Performance on a modest PC matters; effects must be bounded.

## Brand Commitments

Name: J.A.R.V.I.S. Holographic HUD identity (user's choice): cyan on near-black, fine lines, technical typography, readable hierarchy.

## Evidence on Hand

Real data from the running bridge. No screenshots of an approved design exist yet. Do not fabricate metrics or status.

## Product Principles

1. Truth over spectacle: visuals are driven by real events, decoration is declared.
2. Local first, paid and external only on explicit authorization.
3. Works without any single vendor.
4. One calm, readable surface that stays responsive on modest hardware.

## Accessibility & Inclusion

Brazilian Portuguese UI. Keyboard operable; respect reduced motion; do not rely on color alone for status.
