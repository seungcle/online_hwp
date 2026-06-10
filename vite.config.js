import { defineConfig } from 'vite'

export default defineConfig({
  plugins: [],
  build: {
    rollupOptions: {
      input: {
        main: 'index.html',
        privacy: 'privacy/index.html',
      },
    },
  },
})
