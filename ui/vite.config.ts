import path from 'node:path'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: { '@': path.resolve(import.meta.dirname, './src') },
  },
  build: {
    outDir: '../web',
    emptyOutDir: true,
    rolldownOptions: {
      output: {
        codeSplitting: {
          groups: [
            { name: 'react', test: /node_modules[\\/](react|react-dom|scheduler)[\\/]/ },
            // three chỉ cần khi mở khung 3D nên tách riêng, không nằm trong gói nạp lúc mở trang.
            { name: 'three', test: /node_modules[\\/]three[\\/]/ },
            { name: 'vendor', test: /node_modules/ },
          ],
        },
      },
    },
  },
  server: {
    proxy: {
      '/api': 'http://127.0.0.1:7790',
      '/ws': { target: 'ws://127.0.0.1:7790', ws: true },
      '/mcp': 'http://127.0.0.1:7790',
      '/openapi.json': 'http://127.0.0.1:7790',
      '/llms.txt': 'http://127.0.0.1:7790',
      '/.well-known': 'http://127.0.0.1:7790',
    },
  },
})
