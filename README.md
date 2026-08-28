# rhwp

한글 `.hwpx` 양식을 그대로 유지한 채 내용만 AI로 바꾸는 웹 서비스.
<https://rhwp.co.kr>

```text
HWPX 업로드 → 미리보기 → 자연어로 수정 요청 → AI가 수정 계획 작성
→ 검증 → 바이트 단위 patch → 수정본 내려받기
```

**텍스트 편집만** 지원한다. 일반 문단과 표 안의 글자를 바꾸고, 이미지·서식·
표 구조·레이아웃은 손대지 않고 그대로 보존한다.

HWPX 파일은 브라우저를 벗어나지 않는다. AI에는 문단 id와 텍스트만 보낸다.

## 실행

```bash
npm install
npm run dev
```

| 명령 | 하는 일 |
|---|---|
| `npm run dev` | 개발 서버 (UI만) |
| `npm run dev:worker` | Worker 로컬 실행. `npm run dev`와 함께 띄우면 `/api`가 연결된다 |
| `npm run build` | 타입 검사 후 `dist/` 생성 (배포용) |
| `npm test` | 테스트 |
| `npm run sample:edit` | `samples/local/`의 실제 HWPX를 수정해 결과 파일 생성 |

주소 뒤에 `?debug=1`을 붙이면 단계별 처리 시간이 화면에 나온다.

## 구조

```text
frontend/          브라우저 코드 전부 (Vite root)
  src/hwpx/          zip · xml · document · patch · zip-writer · session
  src/ai/            Edit Plan 스키마와 Worker 호출
  src/preview/       경량 HTML 렌더러, 이미지 지연 로딩
backend/index.ts   Cloudflare Worker. OpenAI 프록시 + 소유확인 파일 라우팅
docs/              에이전트용 참고 문서
samples/           실제 HWPX와 결과물 (local/ output/ 은 gitignore)
tests/             vitest
```

빌드 결과는 저장소 루트의 `dist/`로 나가고, wrangler가 그걸 정적 자산으로 올린다.

의존성은 개발용(TypeScript, Vite, Vitest, Wrangler)뿐이다. 런타임 의존성은 없다.
ZIP 압축은 표준 `DecompressionStream`/`CompressionStream`, XML은 자체 스캐너를 쓴다.
이유는 [ADR 0001](docs/adr/0001-browser-only-hwpx.md)에 적었다.

## 설계

핵심 원칙 하나로 정리된다. **문서를 다시 그리지 않는다.**

```text
자연어 요청
  → Worker (OpenAI 프록시, API 키는 Secret에만)
  → Edit Plan  (Structured Outputs로 형태 강제)
  → 브라우저에서 스키마 검증
  → patch engine에서 oldText 대조 검증 (oldText는 브라우저가 보관한 원문)
  → 바이트 단위 patch
  → 새 HWPX
```

AI가 정하는 것은 "어느 문단을 무엇으로 바꿀지"까지다. XML이나 파일을 주지 않는다.

검증이 세 겹인 이유는 어느 하나만 뚫려도 문서가 망가지기 때문이다.
`oldText`가 현재 문단 텍스트와 **한 글자라도** 다르면 그 계획은 통째로 버려진다.
이때 `oldText`는 AI 응답이 아니라 브라우저가 AI에게 보여 준 원문 그대로다.
AI는 문단 줄에 적힌 짧은 검증코드만 옮겨 적고, 그 값으로 id와 내용의 짝이 맞는지 확인한다.
부분 적용은 하지 않는다.

### 가장 중요한 기술적 사실

한글 문서에서 한 문장은 XML의 한 텍스트 노드에 들어 있지 않다.
서식이 바뀌면 `hp:run`이 갈라지고, 형광펜 같은 자식 요소가 끼면 `hp:t`
**안에서도** 텍스트가 갈라진다.

```xml
<hp:run><hp:t>사업 기간은 </hp:t></hp:run>
<hp:run><hp:t>1년</hp:t></hp:run>

<hp:t>대상은 <hp:markpenBegin/>중학생<hp:markpenEnd/>입니다.</hp:t>
```

실제 업무 문서 실측: 텍스트가 있는 문단 136개 중 **20개(약 15%)** 가 두 조각
이상으로 갈라져 있었고, 한 문단이 최대 10조각까지 나뉘었다.

그래서 치환 단위를 텍스트 노드가 아니라 **문단(`hp:p`)** 으로 잡았다. 문단 안의
조각을 이어붙여 논리 문자열을 만들고, 각 조각이 원본 바이트에서 차지한 구간을
함께 들고 다닌다. 수정할 때는 그 구간만 갈아끼운다.

자세한 관찰 기록은 [docs/hwpx-structure.md](docs/hwpx-structure.md).

## 성능

| 문서 | 크기 | 파일 읽기 → 화면 표시 |
|---|---|---|
| 실제 사내 제안서 (164 문단, 표 6개, 이미지 4장) | 4.83 MB | **9–13 ms** |
| 합성 대형 문서 (2,000 문단, 표 100개) | — | 17 ms (Node) |

5 MB 문서에서 실제로 압축을 푼 바이트는 155 KB다. `BinData/` 이미지는 아예
건드리지 않기 때문이다. 수정 후 재패키징에서도 바뀐 section XML만 다시 쓴다.

번들 30.7 KB (gzip 11.7 KB).

## 테스트

```bash
npm test
```

실제 한글이 만든 HWPX로 검증하려면 `samples/local/`에 `.hwpx`를 넣는다.
gitignore 대상이라 **사내 문서가 저장소에 들어가지 않는다.** 없으면 건너뛴다.

```bash
HWPX_SAMPLE_DIR=~/hwpx-samples npm test
```

실제 파일이 있을 때는 문서 모델과 다른 경로로 문단 텍스트를 다시 만들어 대조하고,
수정 후에도 이미지와 ZIP 구조가 바이트 단위로 보존되는지 확인한다.

## 배포

master에 push하면 Cloudflare Workers Builds가 자동 배포한다.

| 단계 | 명령 |
|---|---|
| 빌드 | `npm run build` → `dist/` |
| 배포 | `npx wrangler deploy` (설정: [`wrangler.jsonc`](wrangler.jsonc)) |

Worker 이름 `online-hwp`은 `rhwp.co.kr` 도메인이 붙어 있는 기존 서비스 이름이라
바꾸면 안 된다. 배포 전 확인:

```bash
npm run build && npx wrangler deploy --dry-run
```

### AI 기능에 필요한 Secret

키가 없으면 `/api/edit-plan`이 503과 함께 안내 문구를 돌려주고,
업로드·미리보기·내려받기는 그대로 동작한다.

```bash
npx wrangler secret put OPENAI_API_KEY
```

모델을 바꾸려면(기본 `gpt-4.1-mini`):

```bash
npx wrangler secret put OPENAI_MODEL
```

## 알려진 한계

- `.hwpx` 전용. 구형 `.hwp`(OLE 바이너리)는 열면 변환 안내를 띄운다.
- 미리보기는 글꼴·색·정렬·페이지 나눔을 재현하지 않는다. 내용 확인이 목적이다.
- 이미지는 **보여 주기만** 한다. 생성·삽입·삭제·교체·이동·크기 조정을 하지 않는다.
- 표 구조(행·열 추가/삭제/병합)와 도형·레이아웃은 바꾸지 않는다.
- 문단을 나누거나 합칠 수 없다. 수정 텍스트의 줄바꿈은 공백으로 바뀐다.
- 빈 문단에는 글자를 넣을 수 없다(넣을 자리가 되는 run이 없기 때문).
- 머리말·꼬리말, 각주, 메모, 글상자 안의 텍스트는 아직 다루지 않는다.
- 줄 배치 캐시(`hp:linesegarray`)와 미리보기 캐시(`Preview/PrvText.txt`)를
  갱신하지 않는다. 본문에는 영향이 없다.
- 문서 크기 상한 1,500 문단 / 120,000자. 넘으면 AI 요청 전에 막는다.
- ZIP64와 XML CDATA는 지원하지 않는다(HWPX에서 관측되지 않았고, 만나면 오류를 낸다).
- `DecompressionStream`이 없는 구형 브라우저에서는 동작하지 않는다.
