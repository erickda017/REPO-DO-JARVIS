#!/usr/bin/env node
// Verificação prévia do JARVIS — conselho amigável, rode com `npm run setup`.
//
// Não muda nada e não instala nada. Olha a sua máquina, diz o que está pronto e o que falta
// e mostra como iniciar. Sempre termina com código 0: é um aviso, não uma trava.

import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const ok = '  ok  ';
const aviso = ' nota ';
const info = '  ·   ';

function line(tag, msg) {
  console.log(`[${tag}] ${msg}`);
}

console.log('');
console.log('JARVIS — verificação prévia (nada é alterado)');
console.log('---------------------------------------------');

// --- Sistema -------------------------------------------------------------
if (process.platform === 'win32') line(ok, 'Windows: é o sistema para o qual o aplicativo desktop foi feito.');
else line(aviso, `Sistema ${process.platform}: o aplicativo desktop (terminal, IA local, atalhos) é feito para Windows; parte dele pode não funcionar.`);

// --- Node ----------------------------------------------------------------
const major = Number(process.versions.node.split('.')[0]);
if (Number.isFinite(major) && major >= 20) line(ok, `Node.js ${process.versions.node} (precisa de 20 ou mais).`);
else line(aviso, `Node.js ${process.versions.node} é anterior ao 20. Atualize em https://nodejs.org — o bridge precisa do Node 20 ou mais novo.`);

// --- Dependências --------------------------------------------------------
if (existsSync('node_modules/electron')) line(ok, 'Dependências instaladas (npm install já foi feito).');
else line(aviso, 'Dependências não instaladas. Rode `npm install` nesta pasta.');

// --- Claude Code (opcional) ----------------------------------------------
try {
  const res = spawnSync('claude', ['--version'], { encoding: 'utf8', timeout: 10000, shell: process.platform === 'win32' });
  if (res.status === 0 && res.stdout) line(ok, `Claude Code encontrado (${res.stdout.trim()}). É opcional: só aparece como motor na aba Programar.`);
  else line(info, 'Claude Code não instalado. Tudo bem: é opcional e o JARVIS não depende dele nem de login.');
} catch {
  line(info, 'Claude Code não instalado. Tudo bem: é opcional e o JARVIS não depende dele nem de login.');
}

// --- ElevenLabs (opcional, só na interface web antiga) -------------------
const claudeJson = join(homedir(), '.claude.json');
let el = process.env.ELEVENLABS_API_KEY && process.env.ELEVENLABS_API_KEY.trim() ? 'a variável ELEVENLABS_API_KEY' : null;
if (!el) {
  try {
    const servers = JSON.parse(readFileSync(claudeJson, 'utf8'))?.mcpServers ?? {};
    if (servers.elevenlabs?.env?.ELEVENLABS_API_KEY) el = 'o servidor elevenlabs em ~/.claude.json';
  } catch { /* sem chave à vista */ }
}
if (el) line(ok, `Voz premium disponível (ElevenLabs, via ${el}).`);
else line(info, 'Sem chave ElevenLabs: a voz usa a do Windows/navegador. Está ótimo assim.');

// --- Como rodar ----------------------------------------------------------
console.log('');
console.log('Para abrir o JARVIS (aplicativo desktop):');
console.log('  npm start');
console.log('');
console.log('Depois, na tela IAs, ligue ao menos uma API (cole a chave e escolha o modelo; Gemini, OpenRouter,');
console.log('NVIDIA e Groq têm planos grátis). Marque "Grátis" nas que não cobram.');
console.log('Interface web antiga (precisa do Claude Code instalado e logado): npm run start:web');
console.log('');

process.exit(0);
