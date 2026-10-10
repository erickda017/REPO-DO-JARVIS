import { AnimatePresence, motion } from 'framer-motion'
import { useApp } from '../store.ts'

/** The assistant's answer as a subtitle: it fades in over the scene, and fades out once the voice has finished. */
export function Caption() {
  const caption = useApp((s) => s.caption)
  return (
    <div className="caption-wrap" aria-live="polite">
      <AnimatePresence mode="wait">
        {caption && (
          <motion.p
            key={caption.id}
            className="caption"
            initial={{ opacity: 0, y: 10, filter: 'blur(6px)' }}
            animate={{ opacity: 1, y: 0, filter: 'blur(0px)' }}
            exit={{ opacity: 0, y: -6, filter: 'blur(6px)', transition: { duration: 0.4 } }}
            transition={{ duration: 0.45, ease: [0.16, 1, 0.3, 1] }}
          >
            {caption.text}
          </motion.p>
        )}
      </AnimatePresence>
    </div>
  )
}
