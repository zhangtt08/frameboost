import React from 'react'
import { createRoot } from 'react-dom/client'
import App from './App'
import './styles.css'
import { installDevMock } from './devMock'

// 普通浏览器中预览 UI 时注入模拟 API（生产构建静态消除）
if (import.meta.env.DEV && !window.api) installDevMock()

createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
)
