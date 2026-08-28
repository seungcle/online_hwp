# samples

실제 한글이 만든 `.hwpx`를 넣는 곳.

```
local/    입력. 여기에 .hwpx를 넣으면 통합 테스트가 자동으로 찾는다. (gitignore)
output/   npm run sample:edit 결과물. 한글에서 열어 확인한다. (gitignore)
```

두 디렉터리 모두 gitignore 대상이다. **사내 문서가 저장소에 들어가지 않는다.**

```bash
npm run sample:edit      # local/*.hwpx 를 수정해 output/ 에 생성
HWPX_SAMPLE_DIR=~/다른경로 npm test
```

`make-output.ts`는 AI를 부르지 않는다. 사람이 만든 Edit Plan을 그대로 적용해
patch engine만 따로 확인하기 위한 것이다. 여러 조각으로 갈라진 문단, 표 셀,
일반 문단을 골라 `【수정확인 N】` 표시를 붙인다.

한글에서 열어 확인할 것: 오류 없이 열리는지, 표시가 붙었는지, 표·이미지·글꼴·
여백·페이지가 원본과 같은지.
