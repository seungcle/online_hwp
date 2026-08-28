import { defineConfig } from 'vite'

// 배포 파이프라인은 기존 그대로다. `npm run build` → `dist/`.
// Cloudflare 쪽 설정을 바꾸지 않기 위해 빌드 명령과 출력 경로를 유지한다.
export default defineConfig({
  server: {
    // `npm run dev`는 UI만 띄운다. AI까지 함께 확인하려면 다른 터미널에서
    // `npm run dev:worker`를 띄우면 /api 요청이 그쪽으로 넘어간다.
    proxy: {
      '/api': { target: 'http://127.0.0.1:8787', changeOrigin: true },
    },
  },
  build: {
    target: 'es2022',
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
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
  },
})
