# rhwp

한글 `.hwpx` 양식을 그대로 유지한 채 내용만 바꾸는 웹 서비스.
<https://rhwp.co.kr>

> 이 저장소는 이전의 `@rhwp/editor` 기반 HWP 온라인 편집기를 대체한다.
> Git 이력, 도메인, Cloudflare 배포 연결은 그대로 쓰고 애플리케이션만 새로 만들었다.

## 지금 되는 것 (마일스톤 1)

HWPX 업로드 → 구조 분석 → 경량 미리보기. 전부 브라우저 안에서 돌고
서버로 가는 요청은 하나도 없다.

AI 수정은 다음 단계다. [docs/ROADMAP.md](docs/ROADMAP.md) 참고.

## 실행

```bash
npm install
npm run dev
```

| 명령 | 하는 일 |
|---|---|
| `npm run dev` | 개발 서버 |
| `npm run build` | 타입 검사 후 `dist/` 생성 (배포용) |
| `npm run test` | 테스트 |
| `npm run preview` | 빌드 결과 확인 |

`?debug=1`을 붙이면 단계별 처리 시간이 화면에 나온다. 개발 모드에서는 항상 나온다.

## 설계

핵심 원칙 하나로 정리된다. **문서를 다시 그리지 않는다.**

```text
자연어 요청
  → AI            (판단만: 어느 문단을 무엇으로 바꿀지)
  → Edit Plan     (검증된 JSON)
  → patch engine  (실제 파일 수정, 결정적)
  → 새 HWPX
```

AI에게 HWPX XML을 만들거나 고치게 하지 않는다.

### 가장 중요한 기술적 사실

한글 문서에서 한 문장은 XML의 한 텍스트 노드에 들어 있지 않다.
서식이 바뀌면 `hp:run`이 갈라지고, 형광펜 같은 자식 요소가 끼면 `hp:t`
**안에서도** 텍스트가 갈라진다.

```xml
<hp:run><hp:t>사업 기간은 </hp:t></hp:run>
<hp:run><hp:t>1년</hp:t></hp:run>

<hp:t>대상은 <hp:markpenBegin/>중학생<hp:markpenEnd/>입니다.</hp:t>
```

실제 업무 문서 실측: 텍스트가 있는 문단 136개 중 **20개(약 15%)** 가
두 조각 이상으로 갈라져 있었다. 한 문단이 최대 10조각까지 나뉘었다.

그래서 치환 단위를 텍스트 노드가 아니라 **문단(`hp:p`)** 으로 잡았다.
문단 안의 조각을 이어붙여 하나의 논리 문자열을 만들고, 각 조각이 원본
바이트에서 차지한 구간을 함께 들고 다닌다. 수정할 때는 그 구간만 갈아끼운다.

## 구조

```text
src/
├─ hwpx/
│  ├─ zip.ts        의존성 없는 ZIP 리더. 필요한 항목만 펼친다
│  ├─ xml.ts        바이트 오프셋을 유지하는 XML 스캐너
│  ├─ document.ts   section XML → 문단/표 모델 (조각 인식)
│  └─ package.ts    HWPX 검증 + 로딩 + 단계별 시간 측정
├─ preview/render.ts  모델 → 경량 HTML
├─ perf.ts            처리 시간 측정
└─ main.ts            화면 연결
```

의존성은 개발용(TypeScript, Vite, Vitest)뿐이다. 런타임 의존성은 없다.
ZIP 압축 해제는 표준 `DecompressionStream`, XML은 자체 스캐너를 쓴다.
이유는 [ADR 0001](docs/adr/0001-browser-only-hwpx.md)에 적었다.

## 성능

측정은 `?debug=1`로 언제든 재현할 수 있다.

| 문서 | 크기 | 파일 읽기 → 화면 표시 |
|---|---|---|
| 실제 사내 제안서 (164 문단, 표 6개, 이미지 4개) | 4.83 MB | **9.2 ms** |
| 합성 대형 문서 (2,000 문단, 표 100개) | — | 17 ms (Node) |

5 MB 문서에서 실제로 압축을 푼 바이트는 155 KB다.
`BinData/` 이미지는 아예 건드리지 않기 때문이다.

## 테스트

```bash
npm run test
```

실제 한글이 만든 HWPX로 검증하려면 `fixtures/local/`에 `.hwpx`를 넣는다.
이 디렉터리는 gitignore 대상이라 **사내 문서가 저장소에 들어가지 않는다.**
파일이 없으면 해당 테스트는 건너뛴다.

```bash
HWPX_FIXTURE_DIR=~/hwpx-samples npm run test
```

실제 파일이 있을 때는 문서 모델과 다른 경로로 문단 텍스트를 다시 만들어
두 결과가 일치하는지 대조한다. 어느 한쪽에 버그가 생기면 잡힌다.

## 배포

Cloudflare Workers Builds가 GitHub `master` push를 받아 자동 배포한다.

| 단계 | 명령 |
|---|---|
| 빌드 | `npm run build` → `dist/` |
| 배포 | `npx wrangler deploy` (설정: [`wrangler.jsonc`](wrangler.jsonc)) |

빌드 명령과 출력 디렉터리는 이전과 동일하게 유지했다.
`wrangler.jsonc`는 배포 대상(`dist/`)과 SPA fallback 동작을 명시한다.
Worker 이름 `online-hwp`은 `rhwp.co.kr` 도메인이 붙어 있는 기존 서비스 이름이므로 바꾸면 안 된다.

배포 전 설정 확인:

```bash
npm run build && npx wrangler deploy --dry-run
```

`ads.txt`, 네이버 사이트 인증, `robots.txt`, `sitemap.xml`, 파비콘은
도메인에 묶인 자산이라 그대로 유지했다.

## 알려진 한계

- `.hwpx` 전용. 구형 `.hwp`(OLE 바이너리)는 지원하지 않고, 열면 변환 안내를 띄운다.
- 미리보기는 글꼴·색·정렬·페이지 나눔을 재현하지 않는다. 내용 확인이 목적이다.
- 머리말·꼬리말, 각주, 메모, 글상자 안의 텍스트는 아직 다루지 않는다.
- ZIP64 아카이브와 XML CDATA는 지원하지 않는다(HWPX에서 관측되지 않았고,
  만나면 조용히 넘기지 않고 오류를 낸다).
- `DecompressionStream`이 없는 구형 브라우저에서는 동작하지 않는다.
