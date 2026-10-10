/**
 * How loud JARVIS is speaking right now (0..1), shared by everything that should react to his voice.
 * Real when the app owns the audio (an analyser on the playing element); when the Windows voice speaks there are no
 * samples to read, so a plausible speech-like envelope is used instead. Consumers read `voice.level` every frame
 * (the 3D scene, the particles) or the `--voice` CSS variable on <html> (sidebar, top bar, screen glow on every page).
 * The loop only runs while there is something to show.
 */
export const voice = { level: 0, active: false }

let raf = 0
let ctx: AudioContext | null = null
let analyser: AnalyserNode | null = null
let buf: Uint8Array<ArrayBuffer> | null = null
let synthFrom = -1
let micTarget = 0
const root = typeof document === 'undefined' ? null : document.documentElement

function loop(now: number) {
  let target = 0
  if (analyser && buf) {
    analyser.getByteTimeDomainData(buf)
    let sum = 0
    for (let i = 0; i < buf.length; i++) { const x = (buf[i] - 128) / 128; sum += x * x }
    target = Math.min(1, Math.sqrt(sum / buf.length) * 3.4)
  } else if (synthFrom >= 0) {
    const t = (now - synthFrom) / 1000
    target = 0.28 + 0.4 * Math.abs(Math.sin(t * 7.1)) * (0.65 + 0.35 * Math.sin(t * 2.3)) // syllables riding a slower phrase
  }
  target = Math.max(target, micTarget)
  voice.level += (target - voice.level) * (target > voice.level ? 0.55 : 0.14) // quick attack, soft release
  root?.style.setProperty('--voice', voice.level.toFixed(3))
  if (!voice.active && voice.level < 0.01) {
    voice.level = 0
    root?.style.setProperty('--voice', '0')
    root?.removeAttribute('data-speaking')
    raf = 0
    return
  }
  raf = requestAnimationFrame(loop)
}

function begin() {
  voice.active = true
  root?.setAttribute('data-speaking', '1')
  if (!raf) raf = requestAnimationFrame(loop)
}

function end() {
  voice.active = false
  analyser = null
  buf = null
  synthFrom = -1
}

/** Follow a playing <audio>. Must run BEFORE play(): the element is routed through the analyser from then on. Returns a stop function. */
export async function trackAudio(audio: HTMLAudioElement): Promise<() => void> {
  try {
    ctx ??= new AudioContext()
    if (ctx.state !== 'running') await ctx.resume().catch(() => {})
    if (ctx.state !== 'running') return trackSynthetic() // a suspended context would mute the element: do not route it
    const src = ctx.createMediaElementSource(audio)
    const an = ctx.createAnalyser()
    an.fftSize = 512
    src.connect(an)
    src.connect(ctx.destination)
    analyser = an
    buf = new Uint8Array(an.fftSize)
    begin()
    return end
  } catch {
    return trackSynthetic()
  }
}

/** While the owner talks to JARVIS the interface answers to HIS voice too: push the mic loudness (rms) in, call stop() when listening ends. */
export function trackMic(): { push: (rms: number) => void; stop: () => void } {
  begin()
  return {
    push: (rms) => { micTarget = Math.min(1, rms * 9) },
    stop: () => { micTarget = 0; end() },
  }
}

/** For the OS voice, whose samples the app cannot read. */
export function trackSynthetic(): () => void {
  synthFrom = performance.now()
  begin()
  return end
}
