/**
 * 실제 문서로 AI 왕복을 한 번 돌려 보고, 계획이 그대로 적용되는지 확인한다.
 *
 *   npm run dev:worker      # 다른 터미널. .dev.vars 에 OPENAI_API_KEY 필요
 *   npm run ai:check
 *   npm run ai:check -- "기간을 3개월로 바꿔줘"
 *
 * 기본 대상은 로컬 wrangler(127.0.0.1:8787)다. 실서비스를 보려면:
 *   AI_CHECK_URL=https://rhwp.co.kr/api/edit-plan npm run ai:check
 *
 * `make-output.ts`가 patch engine만 보는 것과 달리, 여기서는 **AI를 실제로
 * 부른다.** 눈으로 봐야 하는 것은 두 가지다.
 *
 *  1. 검증코드가 전부 맞는가 — 모델이 문단을 제대로 짚었는가.
 *  2. 원문의 들여쓰기가 결과에 남아 있는가 — 서식이 조용히 바뀌지 않았는가.
 *
 * 예전에 실서비스를 막았던 것이 정확히 이 두 축이었다. 모델은 원문을 공백까지
 * 옮겨 적지 못하고, 문장을 다듬으면서 앞 공백을 지운다. 지금은 원문 대조값을
 * 브라우저가 채우고 들여쓰기를 기계적으로 되돌리므로, 이 스크립트는 그 두
 * 장치가 실제 모델 응답에도 통하는지 본다.
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { loadHwpxBytes } from '../frontend/src/hwpx/package'
import { HwpxDocument } from '../frontend/src/hwpx/session'
import { collectParagraphs, resolveEditPlan } from '../frontend/src/ai/client'
import { paragraphChecksum, parseEditPlanResponse } from '../frontend/src/ai/schema'
import { PatchError } from '../frontend/src/hwpx/patch'

const endpoint = process.env['AI_CHECK_URL'] ?? 'http://127.0.0.1:8787/api/edit-plan'
const instruction = process.argv[2] ?? '문서 전체의 문장을 더 간결하고 명확하게 다듬어줘.'
const inputDir = resolve(process.env['HWPX_SAMPLE_DIR'] ?? 'samples/local')
const outputDir = resolve('samples/output')

if (!existsSync(inputDir)) {
  console.error(`${inputDir} 가 없습니다. 실제 .hwpx를 넣어 주세요.`)
  process.exit(1)
}
// 기본값은 제일 큰 파일이다. 문단이 많고 서식이 복잡한 쪽이 확인할 것이 많다.
// 특정 파일을 보려면 HWPX_SAMPLE_FILE=이름.hwpx.
const chosen = process.env['HWPX_SAMPLE_FILE']
const [file] = chosen
  ? [chosen]
  : readdirSync(inputDir)
      .filter((name) => name.toLowerCase().endsWith('.hwpx'))
      .sort((a, b) => statSync(join(inputDir, b)).size - statSync(join(inputDir, a)).size)
if (!file) {
  console.error(`${inputDir} 에 .hwpx 파일이 없습니다.`)
  process.exit(1)
}

const loaded = await loadHwpxBytes(new Uint8Array(readFileSync(join(inputDir, file))), file)
const document = HwpxDocument.fromLoadResult(loaded)
const paragraphs = collectParagraphs(document.model)
const sent = new Map(paragraphs.map((paragraph) => [paragraph.id, paragraph.text]))

console.log(`문서   ${file} — 문단 ${paragraphs.length}개`)
console.log(`요청   ${instruction}`)
console.log(`대상   ${endpoint}\n`)

const response = await fetch(endpoint, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ instruction, paragraphs }),
}).catch((error: unknown) => {
  console.error(`연결 실패: ${String(error)}`)
  console.error('로컬이라면 다른 터미널에서 npm run dev:worker 를 먼저 띄워 주세요.')
  process.exit(1)
})

if (!response.ok) {
  console.error(`HTTP ${response.status}`, await response.text())
  process.exit(1)
}
const plan = parseEditPlanResponse(await response.json())
console.log(`요약   ${plan.summary}`)
console.log(`계획   ${plan.operations.length}건\n`)
if (plan.operations.length === 0) process.exit(0)

// 1. 모델이 검증코드를 제대로 옮겨 적었나.
let matched = 0
for (const operation of plan.operations) {
  const text = sent.get(operation.paragraphId)
  if (text !== undefined && paragraphChecksum(text) === operation.checksum) {
    matched += 1
    continue
  }
  console.log(`  검증코드 어긋남 ${operation.paragraphId}`)
}
console.log(`검증코드 일치 ${matched}/${plan.operations.length}`)

// 2. 원문의 들여쓰기가 결과에 남았나.
const lead = (text: string): string => text.slice(0, text.length - text.trimStart().length)
let resolved
try {
  resolved = resolveEditPlan(plan, paragraphs)
} catch (error) {
  if (!(error instanceof PatchError)) throw error
  console.error(`\n적용하지 않았습니다 — ${error.message}`)
  for (const issue of error.issues) console.error(`  [${issue.kind}] ${issue.paragraphId}`)
  process.exit(1)
}
let indented = 0
let kept = 0
for (const operation of resolved.operations) {
  if (lead(operation.oldText).length === 0) continue
  indented += 1
  if (lead(operation.newText) === lead(operation.oldText)) kept += 1
  else console.log(`  들여쓰기 유실 ${operation.paragraphId}`)
}
console.log(`들여쓰기 유지 ${kept}/${indented}`)

// 3. 실제로 적용되고, 다시 열었을 때 그대로인가.
const changes = document.apply(resolved)
mkdirSync(outputDir, { recursive: true })
const bytes = await document.toBytes()
const outPath = join(outputDir, file.replace(/\.hwpx$/i, ' (AI 확인).hwpx'))
writeFileSync(outPath, bytes)

const again = await loadHwpxBytes(bytes, file)
const after = new Map(collectParagraphs(again.model).map((paragraph) => [paragraph.id, paragraph.text]))
const same = changes.filter((change) => after.get(change.paragraphId) === change.newText).length
console.log(`적용 ${changes.length}건 · 재파싱 후 일치 ${same}/${changes.length}`)

const before = loaded.model.stats
const now = again.model.stats
const intact =
  before.paragraphCount === now.paragraphCount &&
  before.tableCount === now.tableCount &&
  before.imageCount === now.imageCount
console.log(`문단·표·이미지 수 ${intact ? '동일' : '달라짐 ⚠'}`)
console.log(`\n결과 파일 ${outPath}`)
for (const change of changes.slice(0, 3)) {
  console.log(`\n  ${change.paragraphId}`)
  console.log(`    전: ${JSON.stringify(change.oldText.slice(0, 60))}`)
  console.log(`    후: ${JSON.stringify(change.newText.slice(0, 60))}`)
}
