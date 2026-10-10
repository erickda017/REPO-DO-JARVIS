import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import '@fontsource/chakra-petch/500.css'
import '@fontsource/chakra-petch/600.css'
import '@fontsource/chakra-petch/700.css'
import '@fontsource/barlow-semi-condensed/400.css'
import '@fontsource/barlow-semi-condensed/500.css'
import '@fontsource/barlow-semi-condensed/600.css'
import './styles.css'
import { MotionConfig } from 'framer-motion'
import { App } from './App.tsx'
import { ErrorBoundary } from './ui/ErrorBoundary.tsx'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <MotionConfig reducedMotion="user">
      <ErrorBoundary>
        <App />
      </ErrorBoundary>
    </MotionConfig>
  </StrictMode>,
)
