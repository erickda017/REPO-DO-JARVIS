/** Microphone choice (kept per device in localStorage), device list, the short beeps that tell you what the mic is doing, and a live level meter for testing. */

const KEY_ID = 'jarvis.micId'
const KEY_SOUNDS = 'jarvis.micSounds'
const read = (k: string) => { try { return localStorage.getItem(k) } catch { return null } }
const write = (k: string, v: string) => { try { localStorage.setItem(k, v) } catch { /* private window: the choice just is not remembered */ } }

export const getMicId = () => read(KEY_ID) || ''
export const setMicId = (id: string) => write(KEY_ID, id)
export const getMicSounds = () => read(KEY_SOUNDS) !== 'off'
export const setMicSounds = (on: boolean) => write(KEY_SOUNDS, on ? 'on' : 'off')

/** getUserMedia audio constraints for the chosen microphone; an unplugged choice falls back to the system default. */
export function micConstraints(deviceId = getMicId()): MediaTrackConstraints {
  return { channelCount: 1, echoCancellation: true, noiseSuppression: true, ...(deviceId ? { deviceId: { exact: deviceId } } : {}) }
}
export async function openMicStream(deviceId = getMicId()): Promise<MediaStream> {
  try {
    return await navigator.mediaDevices.getUserMedia({ audio: micConstraints(deviceId) })
  } catch (e) {
    if (deviceId && (e as Error).name === 'OverconstrainedError') return navigator.mediaDevices.getUserMedia({ audio: micConstraints('') })
    throw e
  }
}

export interface MicDevice { id: string; label: string }
/** Labels are empty until the app has had microphone permission once, so a throwaway stream is opened first when needed. */
export async function listMics(): Promise<MicDevice[]> {
  let all = await navigator.mediaDevices.enumerateDevices()
  if (all.some((d) => d.kind === 'audioinput' && !d.label)) {
    try { (await navigator.mediaDevices.getUserMedia({ audio: true })).getTracks().forEach((t) => t.stop()); all = await navigator.mediaDevices.enumerateDevices() } catch { /* denied: ids without names */ }
  }
  return all.filter((d) => d.kind === 'audioinput' && d.deviceId !== 'communications').map((d, i) => ({ id: d.deviceId, label: d.label || `Microfone ${i + 1}` }))
}

let beepCtx: AudioContext | null = null
/** Short synthetic beeps: start = rising (I am listening), stop = falling (got it / stopped listening), error = low (heard nothing / failed). */
export function chime(kind: 'start' | 'stop' | 'error'): Promise<void> {
  if (!getMicSounds()) return Promise.resolve()
  try {
    beepCtx ??= new AudioContext()
    const c = beepCtx
    void c.resume().catch(() => {})
    const notes = kind === 'start' ? [[660, 0], [990, 0.09]] : kind === 'stop' ? [[880, 0], [587, 0.09]] : [[220, 0], [165, 0.12]]
    const t0 = c.currentTime + 0.01
    for (const [f, at] of notes) {
      const o = c.createOscillator(), g = c.createGain()
      o.type = 'sine'; o.frequency.value = f
      g.gain.setValueAtTime(0.0001, t0 + at)
      g.gain.exponentialRampToValueAtTime(0.16, t0 + at + 0.015)
      g.gain.exponentialRampToValueAtTime(0.0001, t0 + at + 0.12)
      o.connect(g).connect(c.destination)
      o.start(t0 + at); o.stop(t0 + at + 0.13)
    }
    return new Promise((r) => setTimeout(r, 260)) // callers wait this long so the mic never records the beep
  } catch {
    return Promise.resolve()
  }
}

export interface Meter { stop: () => void; label: string; rate: number }
/** Opens the microphone and reports its loudness ~30x/s: rms (0..1) and the recent peak. Nothing is recorded or sent anywhere. */
export async function openMeter(deviceId: string, onLevel: (rms: number) => void): Promise<Meter> {
  const stream = await openMicStream(deviceId)
  const ctx = new AudioContext()
  const an = ctx.createAnalyser()
  an.fftSize = 1024
  ctx.createMediaStreamSource(stream).connect(an)
  const buf = new Uint8Array(an.fftSize)
  const timer = setInterval(() => {
    an.getByteTimeDomainData(buf)
    let s = 0
    for (let i = 0; i < buf.length; i++) { const x = (buf[i] - 128) / 128; s += x * x }
    onLevel(Math.sqrt(s / buf.length))
  }, 33)
  return {
    label: stream.getAudioTracks()[0]?.label ?? '',
    rate: ctx.sampleRate,
    stop: () => { clearInterval(timer); stream.getTracks().forEach((t) => t.stop()); void ctx.close() },
  }
}

/** rms -> 0..1 on a dB scale (-60 dB .. 0 dB), the way a mixer meter reads. */
export const meterPct = (rms: number) => Math.max(0, Math.min(1, (20 * Math.log10(Math.max(rms, 1e-5)) + 60) / 60))
