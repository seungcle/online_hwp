import { defineConfig } from 'vite'

import { cloudflare } from "@cloudflare/vite-plugin";

export default defineConfig({
  plugins: [cloudflare()],
  build: {
    rollupOptions: {
      input: {
        main: 'index.html',
        privacy: 'privacy/index.html',
        guide: 'guide/index.html',
        faq: 'faq/index.html',
        about: 'about/index.html',
      },
    },
  },
})