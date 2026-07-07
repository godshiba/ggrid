import React from 'react'
import ReactDOM from 'react-dom/client'
// Self-hosted fonts (woff2, build-time bundled + compressed).
import '@fontsource/saira/200.css'
import '@fontsource/saira/300.css'
import '@fontsource/saira/400.css'
import '@fontsource/saira/500.css'
import '@fontsource/jetbrains-mono/400.css'
import '@fontsource/jetbrains-mono/500.css'
import '@fontsource/jetbrains-mono/700.css'
import App from './App'
import './index.css'

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
)
