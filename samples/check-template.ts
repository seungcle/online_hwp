/**
 * 알려진 양식 경로를 **실제 Worker + 실제 D1 + 실제 AI**로 확인한다.
 *
 *   npm run dev:worker      # 다른 터미널. .dev.vars 에 OPENAI_API_KEY 필요
 *   npm run db:local        # 로컬 D1 에 스키마 적용
 *   npm run template:check
 *
 * 같은 문서를 두 번 올린다. 첫 번째는 miss라 구조 분석까지 두 번 부르고,
 * 두 번째는 hit라 수정 계획만 한 번 부른다. 그 차이가 이 기능의 전부다.
 *
 * 테스트(`tests/template.test.ts`)는 AI를 가짜로 두고 흐름을 본다. 이 스크립트는
 * 진짜 모델과 진짜 D1 바인딩까지 붙여 본다. 둘 다 필요하다.
 */

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { loadHwpxBytes } from '../frontend/src/hwpx/package'
import { computeStructure } from '../frontend/src/hwpx/fingerprint'
import { collectParagraphs } from '../frontend/src/ai/client'
import type { EditPlanDebug } from '../frontend/src/ai/schema'

const endpoint = process.env['AI_CHECK_URL'] ?? 'http://127.0.0.1:8787/api/edit-plan'
const instruction = process.argv[2] ?? '제목을 조금 더 간결하게 다듬어줘.'
const inputDir = resolve(process.env['HWPX_SAMPLE_DIR'] ?? 'samples/local')

if (!existsSync(inputDir)) {
  console.error(`${inputDir} 가 없습니다. 실제 .hwpx를 넣어 주세요.`)
  process.exit(1)
}
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
const structure = computeStructure(loaded.model)
const paragraphs = collectParagraphs(loaded.model, structure)

console.log(`문서   ${file} — 문단 ${paragraphs.length}개`)
console.log(`지문   ${structure.structureHash}`)
console.log(`뼈대   ${structure.skeleton.slice(0, 90)}${structure.skeleton.length > 90 ? '…' : ''}`)
console.log(`대상   ${endpoint}\n`)

const body = {
  instruction,
  paragraphs,
  structure: {
    structureHash: structure.structureHash,
    skeleton: structure.skeleton,
    paragraphCount: structure.paragraphCount,
    tableCount: structure.tableCount,
    imageCount: structure.imageCount,
  },
}

async function once(label: string): Promise<EditPlanDebug | undefined> {
  const startedAt = Date.now()
  const response = await fetch(endpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  const took = Date.now() - startedAt
  if (!response.ok) {
    console.error(`${label}: HTTP ${response.status}`, (await response.text()).slice(0, 200))
    return undefined
  }
  const plan = (await response.json()) as { operations: unknown[]; debug?: EditPlanDebug }
  const debug = plan.debug
  console.log(`${label}`)
  console.log(`  조회        ${debug?.templateLookup}${debug?.templateName ? ` — ${debug.templateName} v${debug.templateVersion}` : ''}`)
  console.log(`  AI 호출     ${debug?.aiCalls.length}회 (${debug?.aiCalls.join(', ')})`)
  console.log(`  구조 분석   ${debug?.aiCalls.includes('structure') ? '했음' : '건너뜀'}`)
  if (debug?.anchorRatio !== undefined) console.log(`  라벨 일치   ${Math.round(debug.anchorRatio * 100)}%`)
  if (debug?.fallback) console.log(`  fallback    ${debug.fallback}`)
  console.log(`  조회 ${debug?.lookupMs ?? '-'}ms · AI ${debug?.aiMs ?? '-'}ms · 왕복 ${took}ms`)
  console.log(`  계획        ${plan.operations.length}건\n`)
  return debug
}

const first = await once('1회차 (처음 보는 양식이어야 한다)')
const second = await once('2회차 (같은 양식이므로 hit여야 한다)')

if (!first || !second) process.exit(1)

const ok =
  !second.aiCalls.includes('structure') &&
  second.templateLookup === 'hit' &&
  first.aiCalls.length > second.aiCalls.length
console.log(
  ok
    ? `결과: AI 호출 ${first.aiCalls.length}회 → ${second.aiCalls.length}회. 구조 분석이 사라졌습니다.`
    : '결과: 기대한 hit 흐름이 아닙니다. 위 debug 를 보세요.',
)
process.exit(ok ? 0 : 1)
