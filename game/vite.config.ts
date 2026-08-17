import { defineConfig } from 'vite'
import { fileURLToPath, URL } from 'node:url'

export default defineConfig({
  resolve: {
    alias: {
      '@sim': fileURLToPath(new URL('./src/sim', import.meta.url)),
      '@render': fileURLToPath(new URL('./src/render', import.meta.url)),
      '@data': fileURLToPath(new URL('./src/data', import.meta.url)),
    },
  },
  server: { port: 5173, host: true },
  build: { target: 'es2022', sourcemap: true },
  test: {
    globals: true,
    environment: 'node',
    include: ['test/**/*.test.ts'],
  },
} as never)
