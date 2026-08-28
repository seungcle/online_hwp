# HWPX 내부 구조 — 실제 문서 관찰 기록

에이전트용 참고 문서. 추측이 아니라 한컴오피스 한글 12.0.0.535가 저장한 실제
업무 문서(제안서, 164 문단 / 표 6 / 이미지 4 / `section0.xml` 155KB)를 직접 열어
확인한 내용이다. 코드의 여러 결정이 여기서 나왔다.

## ZIP 구성

```
mimetype                 19 B   stored(무압축), 항상 첫 항목, "application/hwp+zip"
version.xml             309 B   stored
Contents/header.xml             deflated
Contents/section0.xml           deflated   ← 본문
Contents/content.hpf            deflated   ← OPF manifest (그림 경로가 여기 있다)
META-INF/container.xml          deflated
BinData/image1.bmp              deflated
BinData/image3.png              stored     ← 이미 압축된 포맷은 그대로 저장
Preview/PrvText.txt, Preview/PrvImage.png, Scripts/*.js, settings.xml
```

**항목마다 압축 방식이 다르다.** 전부 deflate로 다시 묶으면 원본과 달라진다.
타임스탬프도 대부분 1980-01-01로 고정돼 있고 일부만 실제 시각이다.

→ `frontend/src/hwpx/zip-writer.ts`가 순서·압축 방식·타임스탬프·권한 비트를
그대로 옮기고, 바뀌지 않은 항목은 **압축된 바이트를 그대로 복사**한다.
아무것도 수정하지 않고 다시 쓰면 모든 항목이 원본과 바이트 단위로 같다.

## 본문 계층

```
hs:sec
└ hp:p                      문단
  ├ hp:run (charPrIDRef)    서식 단위
  │ ├ hp:t                  글자
  │ ├ hp:tbl                표
  │ └ hp:pic                그림
  └ hp:linesegarray         줄 배치 캐시 (레이아웃 결과물)
```

표 안 텍스트도 결국 같은 구조다.

```
hp:p > hp:run > hp:tbl > hp:tr > hp:tc > hp:subList > hp:p > hp:run > hp:t
```

일반 문단과 표 셀을 다르게 처리할 필요가 없다.

## 텍스트 분할 — 가장 중요한 사실

실측: 텍스트가 있는 문단 136개 중 **20개(약 15%)** 가 두 조각 이상으로 갈라져 있었다.
한 문단 최대 10조각.

**(a) run이 나뉜다** — 문단 중간에 서식이 바뀌면 갈라진다.

```xml
<hp:p><hp:run charPrIDRef="21"><hp:t>□ </hp:t></hp:run>
      <hp:run charPrIDRef="13"><hp:t>Agent 활용 도구 </hp:t></hp:run></hp:p>
```

**(b) `hp:t` 안에서 text/tail로 갈라진다** — 형광펜 같은 자식 요소가 끼면.

```xml
<hp:t>Orchestrator 1은<hp:markpenBegin/> 실제임상자료 등<hp:markpenEnd/>에서 …</hp:t>
```

→ 그래서 치환 단위가 텍스트 노드가 아니라 문단이다.
`frontend/src/hwpx/document.ts`가 문단 안의 조각을 이어붙여 논리 문자열을 만들고,
각 조각의 원본 바이트 구간(`TextFragment`)을 함께 들고 다닌다.

## 표 셀 메타데이터

`colAddr`/`rowAddr`는 `hp:tc`의 **속성이 아니라 자식 요소**다.

```xml
<hp:tc ...><hp:subList>…</hp:subList>
  <hp:cellAddr colAddr="1" rowAddr="0"/>
  <hp:cellSpan colSpan="1" rowSpan="1"/>
  <hp:cellSz width="20000" height="2000"/></hp:tc>
```

## 그림

본문은 `binaryItemIDRef="image1"`로만 가리킨다. 실제 경로와 MIME 타입은
`Contents/content.hpf`에 있다. **`header.xml`에는 목록이 없다.**

```xml
<opf:item id="image1" href="BinData/image1.bmp" media-type="image/bmp" isEmbeded="1"/>
```

표시 크기는 `hp:pic > hp:curSz`의 HWPUNIT(1/7200인치). 96dpi 기준 px = HWPUNIT / 75.
BMP가 섞여 있는데 브라우저가 정상 디코딩한다.

## 네임스페이스

`hp`(paragraph), `hc`(core), `hs`(section), `hh`(head). 한글은 늘 이 접두사를 쓰지만
코드는 루트의 `xmlns` 선언에서 URI로 찾는다. 접두사에 기대지 않는다.

## 확인하지 못한 것

- **강제 줄나눔 요소의 실물 사례.** 이 문서에 `lineBreak`가 하나도 없었다.
  그래서 수정 텍스트의 줄바꿈은 공백으로 바꾼다. 추측으로 XML 요소를 만들지 않는다.
- **`hp:linesegarray` 캐시.** 텍스트 길이가 바뀌면 옛 값이 남는다. 한글이 열면서
  다시 계산하는 것으로 보이나 확인하지 못했다.
- **`Preview/PrvText.txt`** 를 갱신하지 않는다. 본문에는 영향이 없지만
  탐색기 미리보기에는 옛 내용이 보일 수 있다.
- 머리말·꼬리말, 각주, 메모, 글상자 안의 텍스트 구조.
