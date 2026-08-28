import { defineConfig } from 'vite'

// 배포 파이프라인은 기존 그대로다. `npm run build` → `dist/`.
// Cloudflare 쪽 설정을 바꾸지 않기 위해 빌드 명령과 출력 경로를 유지한다.
export default defineConfig({
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
