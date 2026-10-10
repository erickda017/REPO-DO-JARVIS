import { useEffect, useRef, useState } from 'react'
import { Palette } from 'lucide-react'
import { useApp } from '../store.ts'
import { THEMES } from '../theme.ts'

/** The colour of the whole interface, one click. The agent can change it too ("mude o tema para roxo"). */
export function ThemePicker() {
  const theme = useApp((s) => s.theme)
  const setTheme = useApp((s) => s.setTheme)
  const [open, setOpen] = useState(false)
  const box = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!open) return
    const off = (e: MouseEvent) => { if (!box.current?.contains(e.target as Node)) setOpen(false) }
    const key = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false) }
    document.addEventListener('mousedown', off)
    document.addEventListener('keydown', key)
    return () => { document.removeEventListener('mousedown', off); document.removeEventListener('keydown', key) }
  }, [open])
  return (
    <div className="theme-picker nodrag" ref={box}>
      <button className="icon-btn" onClick={() => setOpen((o) => !o)} aria-label="Cores do JARVIS" aria-haspopup="true" aria-expanded={open} title="Cores do JARVIS">
        <Palette size={17} />
      </button>
      {open && (
        <div className="theme-pop" role="menu" aria-label="Escolha o tema de cores">
          <p className="dim small">Cores · você também pode pedir: “mude o tema para roxo”</p>
          <div className="theme-grid">
            {THEMES.map((t) => (
              <button key={t.id} role="menuitemradio" aria-checked={theme === t.id} className="theme-chip" data-on={theme === t.id} onClick={() => { setTheme(t.id); setOpen(false) }}>
                <span className="theme-dot" style={{ background: t.swatch, boxShadow: `0 0 12px ${t.swatch}88` }} aria-hidden />
                {t.label}
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}
