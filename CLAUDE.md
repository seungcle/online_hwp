# rhwp

HWPX 양식을 유지한 채 텍스트만 AI로 수정하는 웹 서비스. https://rhwp.co.kr

## 구조

```
frontend/   브라우저 코드 전부. Vite root. (src/hwpx, src/ai, src/preview)
backend/    Cloudflare Worker 하나. OpenAI 프록시 + 알려진 양식 조회 + 소유확인 라우팅.
migrations/ D1 스키마. 알려진 양식만 저장한다. 문서 내용은 넣지 않는다.
docs/       에이전트용 참고 문서. 코드만 봐서는 안 나오는 배경.
samples/    실제 HWPX와 결과물. local/ output/ 은 gitignore.
tests/      vitest. 프론트·백 양쪽을 함께 본다.
```

빌드 출력은 저장소 루트의 `dist/`. wrangler가 그걸 정적 자산으로 올린다.

## 명령

```bash
npm run dev          # UI만
npm run dev:worker   # Worker. dev와 함께 띄우면 /api 연결
npm test
npm run build        # tsc --noEmit && vite build → dist/
npm run sample:edit  # samples/local/*.hwpx 를 수정해 samples/output/ 에 생성 (AI 없이)
npm run db:local     # 로컬 D1 에 마이그레이션 적용
npm run ai:check     # AI를 실제로 불러 왕복 확인. .dev.vars 에 OPENAI_API_KEY 필요
npm run template:check  # 같은 문서를 두 번 올려 miss → hit 를 확인
```

## 깨뜨리면 안 되는 것

1. **section XML을 다시 직렬화하지 마라.** 수정 대상 바이트 구간만 교체한다.
   그래야 서식·표·이미지·레이아웃이 원본 그대로 남는다.
2. **바뀌지 않은 ZIP 항목은 재압축하지 마라.** 압축된 바이트를 그대로 복사한다.
   엔트리 순서, 항목별 압축 방식, 타임스탬프도 원본에서 옮긴다.
   `mimetype`은 첫 항목이고 무압축이어야 한다.
3. **치환 단위는 문단(`hp:p`)이다.** 한 문장이 여러 `hp:run`으로, 또 `hp:t` 안에서
   text/tail로 갈라진다(실측 15%). 텍스트 노드 하나만 보고 바꾸면 실패한다.
4. **`oldText`가 현재 문단 텍스트와 한 글자라도 다르면 계획 전체를 버린다.**
   부분 적용은 없다. 이 규칙은 **문서가 바뀌었을 때**를 위한 것이다(`patch.ts`의
   `validatePlan`). 그때는 모든 수정이 낡은 문서를 보고 세워진 것이라 한 건도
   믿을 수 없다. 단 `oldText`는 **AI가 아니라 브라우저가 채운다** —
   AI에게 보여 준 그 문자열을 그대로 들고 있다가 쓴다. 모델에게 원문을 받아
   적게 하면 들여쓰기 공백이 뭉개져 멀쩡한 문서가 거부당한다(실측 27%).
5. **검증코드가 어긋난 수정은 그 건만 건너뛴다.** "AI가 다른 문단을 보고 이 id를
   적었는가"는 짧은 검증코드로 확인하는데(`client.ts`의 `resolveEditPlan`),
   여기서는 계획 전체를 버리지 않는다. 각 수정은 자기 문단의 코드로 따로
   확인되므로 어긋난 건만 버려도 안전하다. 전부 버리면 안전이 늘지 않고 사용자
   작업만 사라진다 — 실측으로 개별 오류율은 0.3%인데 넓은 요청의 10%가 통째로
   실패했고, 멀쩡한 47건이 어긋난 2건에 끌려갔다. **건너뛴 건은 화면에 알린다.**
   id가 문서에 아예 없을 때만 검증코드로 대상을 되살린다. id가 있는데 코드가
   어긋나면 어느 쪽이 틀렸는지 알 수 없으므로 고르지 않는다.
6. **비어 있는 값 칸은 채운다.** 양식의 값 칸은 `<hp:run charPrIDRef="30"/>`처럼
   `hp:t`가 없다. 이런 칸을 목록에서 빼면 AI가 고를 것이 라벨밖에 없어 **라벨을
   값으로 덮어쓴다**(실측). 빈 요소를 텍스트를 담은 요소로 넓히되, 새 문단이나
   run을 지어내지는 않는다. 넣을 자리가 아예 없으면 그때는 거절한다.
7. **AI에게 XML이나 파일을 주지 마라.** 문단 id·텍스트·위치 힌트만 보낸다.
   응답은 Structured Outputs로 강제하고, 받은 뒤 브라우저에서 다시 검증한다.
8. **사내 HWPX를 커밋하지 마라.** `samples/local/`에 두면 테스트가 알아서 찾는다.
9. **D1에 문서 내용을 넣지 마라.** 남기는 것은 구조 해시·뼈대·필드 위치와 이름·
   라벨 문구·값의 해시뿐이다. 원본 HWPX, 이미지, 본문, 필드에 적힌 값은 넣지 않는다.
   경계는 [ADR 0002](docs/adr/0002-known-template-store.md)와 `tests/template.test.ts`가 지킨다.
10. **알려진 양식이어도 `oldText` 검증을 건너뛰지 마라.** 양식 기억은 AI 호출을
   줄이는 장치다. 라벨이 어긋나면 자동으로 고치지 말고 재분석해 새 version으로 남긴다.

## 배포

master push → Cloudflare Workers Builds가 `npm run build` 후 `npx wrangler deploy`.

배포가 끝났는지는 GitHub가 받아 두는 빌드 결과로 확인한다. 로컬에 Cloudflare
토큰이 없어도 되고, Worker만 고쳐 프론트 번들 해시가 그대로일 때도 알 수 있다.

```bash
gh api repos/seungcle/online_hwp/commits/<sha>/check-runs \
  --jq '.check_runs[] | "\(.name): \(.conclusion)"'
```

- Worker 이름 `online-hwp`은 `rhwp.co.kr`이 붙어 있다. **바꾸면 도메인이 끊긴다.**
- 모델은 `gpt-5.6-terra`(균형 등급) + `reasoning_effort: low`. `OPENAI_MODEL`,
  `OPENAI_REASONING_EFFORT`로 바꿀 수 있다. 추론을 지원하지 않는 모델을 쓸 때는
  `OPENAI_REASONING_EFFORT`를 빈 값으로 둬야 400이 안 난다.
- **저장소가 공개다.** 비밀번호·키를 코드나 `wrangler.jsonc`에 적으면 그대로 노출된다.
  `APP_USER`/`APP_PASSWORD`는 AI 호출을 쓸 수 있는 아이디와 비밀번호이고
  Cloudflare Secret으로만 둔다. 설정되지 않으면 `/api/edit-plan`이 503으로 닫힌다
  (조용히 열려 있는 것보다 낫다). 막는 곳은 Worker다 — 화면의 로그인은 자격증명을
  들고 있는 자리일 뿐이라 그것만으로는 아무것도 막지 못한다.
  `/api/edit-plan`에만 건다. `ads.txt`·네이버 소유확인·`robots.txt`·`sitemap.xml`은
  크롤러가 읽어야 하고, 미리보기는 브라우저에서만 돌아 돈이 들지 않는다.

  ```bash
  npx wrangler secret put APP_USER
  npx wrangler secret put APP_PASSWORD
  ```
- `OPENAI_API_KEY`는 Cloudflare Secret. 번들에 절대 넣지 않는다.
  로컬에서는 `.dev.vars`(gitignore)에 두면 `wrangler dev`가 읽는다. `.dev.vars.example` 참고.
  없으면 `/api/edit-plan`이 503을 주고 나머지 기능은 정상 동작한다.
- `ads.txt`, 네이버 소유확인, `robots.txt`, `sitemap.xml`은 도메인 자산이다. 지우지 마라.
- D1 `TEMPLATES` 바인딩이 없어도 서비스는 그대로 돈다. 매번 처음 보는 문서로
  처리될 뿐이다. 바인딩이 빠졌다고 편집이 막히면 안 된다.

## 안 하는 것

이미지·표 구조·도형·레이아웃 편집, `.hwp`, 한글과 동일한 렌더링, 문단 분리/병합.
