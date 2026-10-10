import { BASE } from '../api.ts'

/**
 * One spoken request: opens the microphone, waits for speech, stops by itself after a pause, and sends ONE
 * 16 kHz mono WAV to the bridge's /stt (ElevenLabs Scribe). Nothing is recorded while the state is idle, and the
 * microphone is released the moment this returns. Voice-activity detection runs locally: only the words go out.
 */
export interface ListenOptions {
  signal?: AbortSignal
  onLevel?: (rms: number) => void
  onSpeech?: () => void // first speech detected
  onProcessing?: () => void // recording ended, sending for transcription
  noSpeechMs?: number // give up if nobody speaks (default 8 s)
  silenceMs?: number // pause that ends the sentence (default 1.4 s)
  maxMs?: number // hard cap (default 45 s)
}
export type ListenResult = { ok: true; text: string } | { ok: false; error: string; code: 'denied' | 'no-key' | 'no-speech' | 'cancelled' | 'failed' }

const TARGET_RATE = 16_000

/** Linear-interpolation downsample to 16 kHz: speech recognition does not need more. */
export function downsample(input: Float32Array, from: number, to = TARGET_RATE): Float32Array {
  if (from <= to) return input
  const ratio = from / to
  const out = new Float32Array(Math.floor(input.length / ratio))
  for (let i = 0; i < out.length; i++) {
    const pos = i * ratio
    const i0 = Math.floor(pos)
    const frac = pos - i0
    out[i] = input[i0] * (1 - frac) + (input[Math.min(i0 + 1, input.length - 1)] ?? 0) * frac
  }
  return out
}

/** 16-bit PCM WAV container. */
export function encodeWav(samples: Float32Array, rate = TARGET_RATE): Blob {
  const buf = new ArrayBuffer(44 + samples.length * 2)
  const v = new DataView(buf)
  const str = (o: number, s: string) => [...s].forEach((c, i) => v.setUint8(o + i, c.charCodeAt(0)))
  str(0, 'RIFF'); v.setUint32(4, 36 + samples.length * 2, true); str(8, 'WAVE'); str(12, 'fmt ')
  v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true)
  v.setUint32(24, rate, true); v.setUint32(28, rate * 2, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true)
  str(36, 'data'); v.setUint32(40, samples.length * 2, true)
  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]))
    v.setInt16(44 + i * 2, s < 0 ? s * 0x8000 : s * 0x7fff, true)
  }
  return new Blob([buf], { type: 'audio/wav' })
}

export async function listenOnce(opts: ListenOptions = {}): Promise<ListenResult> {
  const { noSpeechMs = 8000, silenceMs = 1400, maxMs = 45_000 } = opts
  let stream: MediaStream
  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true } })
  } catch (e) {
    return { ok: false, code: 'denied', error: `Sem acesso ao microfone (${(e as Error).name}). Libere em Configurações do Windows › Privacidade › Microfone.` }
  }
  const ctx = new AudioContext()
  const src = ctx.createMediaStreamSource(stream)
  const proc = ctx.createScriptProcessor(4096, 1, 1) // deprecated but universal; AudioWorklet is the upgrade if this ever misbehaves
  const chunks: Float32Array[] = []
  let speaking = false, lastVoice = 0, noise = 0, calib = 0
  const t0 = performance.now()

  const finished = new Promise<'speech' | 'silent' | 'cancelled'>((resolve) => {
    proc.onaudioprocess = (e) => {
      const d = e.inputBuffer.getChannelData(0)
      let sum = 0
      for (let i = 0; i < d.length; i++) sum += d[i] * d[i]
      const rms = Math.sqrt(sum / d.length)
      opts.onLevel?.(rms)
      const now = performance.now()
      if (calib < 5) { noise = Math.max(noise, rms); calib++ } // first ~0.4 s: measure the room
      const threshold = Math.max(0.018, noise * 2.5)
      if (rms > threshold) {
        if (!speaking) { speaking = true; opts.onSpeech?.() }
        lastVoice = now
      }
      chunks.push(new Float32Array(d))
      if (!speaking && chunks.length > 6) chunks.shift() // before the first word keep only ~0.5 s of lead-in
      if (speaking && now - lastVoice > silenceMs) resolve('speech')
      else if (!speaking && now - t0 > noSpeechMs) resolve('silent')
      else if (now - t0 > maxMs) resolve(speaking ? 'speech' : 'silent')
    }
    opts.signal?.addEventListener('abort', () => resolve('cancelled'), { once: true })
  })
  src.connect(proc)
  proc.connect(ctx.destination) // required for onaudioprocess to fire; the output is silent (we never write to outputBuffer)

  const how = await finished
  const rate = ctx.sampleRate
  proc.disconnect(); src.disconnect()
  stream.getTracks().forEach((t) => t.stop()) // microphone off, immediately
  void ctx.close()
  if (how === 'cancelled') return { ok: false, code: 'cancelled', error: 'Escuta cancelada.' }
  if (how === 'silent') return { ok: false, code: 'no-speech', error: 'Não ouvi nada.' }

  const total = chunks.reduce((n, c) => n + c.length, 0)
  const all = new Float32Array(total)
  let o = 0
  for (const c of chunks) { all.set(c, o); o += c.length }
  opts.onProcessing?.()
  const wav = encodeWav(downsample(all, rate))
  try {
    const res = await fetch(`${BASE}/stt`, {
      method: 'POST',
      headers: { 'content-type': 'audio/wav', ...(window.jarvis?.token ? { 'x-jarvis-token': window.jarvis.token } : {}) },
      body: wav,
      signal: AbortSignal.timeout(40_000),
    })
    if (res.status === 503) return { ok: false, code: 'no-key', error: 'Sem chave de transcrição. Cole a chave do ElevenLabs na tela Voz.' }
    if (!res.ok) return { ok: false, code: 'failed', error: `A transcrição falhou (HTTP ${res.status}).` }
    const text = String(((await res.json()) as { text?: string }).text ?? '').trim()
    return text ? { ok: true, text } : { ok: false, code: 'no-speech', error: 'Não consegui entender o áudio.' }
  } catch {
    return { ok: false, code: 'failed', error: 'Não consegui falar com o bridge para transcrever.' }
  }
}
