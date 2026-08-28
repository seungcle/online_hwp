import { defineConfig } from 'vite'

// 배포 파이프라인은 기존 그대로다. `npm run build` → `dist/`.
// Cloudflare 쪽 설정을 바꾸지 않기 위해 빌드 명령과 출력 경로를 유지한다.
export default defineConfig({
  // 브라우저 코드는 frontend/ 안에만 있다. 빌드 결과는 저장소 루트의 dist/로 나간다.
  root: 'frontend',
  publicDir: 'public',
  server: {
    // `npm run dev`는 UI만 띄운다. AI까지 함께 확인하려면 다른 터미널에서
    // `npm run dev:worker`를 띄우면 /api 요청이 그쪽으로 넘어간다.
    proxy: {
      '/api': { target: 'http://127.0.0.1:8787', changeOrigin: true },
    },
  },
  build: {
    outDir: '../dist',
    emptyOutDir: true,
    target: 'es2022',
    rollupOptions: {
      // rollup input은 설정 파일 위치 기준이라 frontend/ 를 붙인다.
      input: {
        main: 'frontend/index.html',
        privacy: 'frontend/privacy/index.html',
        guide: 'frontend/guide/index.html',
        faq: 'frontend/faq/index.html',
        about: 'frontend/about/index.html',
      },
    },
  },
  test: {
    root: '.',
    environment: 'node',
    include: ['tests/**/*.test.ts'],
  },
})
