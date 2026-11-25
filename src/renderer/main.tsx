import React from 'react'
import ReactDOM from 'react-dom/client'
import 'allotment/dist/style.css'
import '@xterm/xterm/css/xterm.css'
import './index.css'
import { installSystemClipboardPolyfill } from './utils/clipboardBridge'
import App from './App'

installSystemClipboardPolyfill()

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
)
