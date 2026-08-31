/**
 * `samples/local/`의 실제 HWPX에 수정을 적용해 결과 파일을 만든다.
 * 한글에서 직접 열어 서식과 이미지가 살아 있는지 눈으로 확인하기 위한 것이다.
 *
 *   npm run sample:edit
 *
 * AI를 부르지 않는다. 사람이 만든 Edit Plan을 그대로 적용한다.
 * patch engine만 따로 확인하려는 목적이기 때문이다.
 *
 * 두 가지를 함께 넣는다.
 *
 *  1. 【수정확인 N】 — 이미 글자가 있는 문단을 고친다. 여러 조각으로 갈라진
 *     문단, 표 셀, 일반 문단을 골고루 고른다.
 *  2. 【빈칸확인 N】 — **비어 있던 값 칸**을 채운다. 이쪽은 비어 있던 요소를
 *     텍스트를 담은 요소로 넓히는 경로라, 눈으로 봐야 할 것이 더 많다.
 *     칸이 제자리에 채워졌는지, 표가 밀리지 않았는지, 옆의 라벨이 그대로인지.
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { basename, join, resolve } from 'node:path'
import { loadHwpxBytes } from '../frontend/src/hwpx/package'
import { HwpxDocument } from '../frontend/src/hwpx/session'
import type { EditOperation } from '../frontend/src/hwpx/patch'
import { collectParagraphs } from '../frontend/src/ai/client'

const inputDir = resolve(process.env['HWPX_SAMPLE_DIR'] ?? 'samples/local')
const outputDir = resolve('samples/output')

if (!existsSync(inputDir)) {
  console.error(`${inputDir} 가 없습니다. 실제 .hwpx를 넣어 주세요.`)
  process.exit(1)
}

const samples = readdirSync(inputDir).filter((name) => name.toLowerCase().endsWith('.hwpx'))
if (samples.length === 0) {
  console.error(`${inputDir} 에 .hwpx 파일이 없습니다.`)
  process.exit(1)
}

mkdirSync(outputDir, { recursive: true })

for (const name of samples) {
  const bytes = new Uint8Array(readFileSync(join(inputDir, name)))
  const loaded = await loadHwpxBytes(bytes, name)
  const document = HwpxDocument.fromLoadResult(loaded)

  // 실제로 손대는 문단을 고른다.
  //  - 여러 조각으로 갈라진 문단 (가장 위험한 경로)
  //  - 표 셀 안의 짧은 문단
  //  - 일반 문단
  const paragraphs = document.model.sections.flatMap((section) => section.paragraphs)
  const split = paragraphs.filter((p) => p.split && p.text.trim().length > 4)
  const plain = paragraphs.filter((p) => !p.split && p.text.trim().length > 10)
  const short = paragraphs.filter((p) => !p.split && p.text.trim().length > 0 && p.text.length <= 12)

  const picks = [split[0], plain[0], short[0], split[1], short[1]].filter(
    (p): p is NonNullable<typeof p> => p !== undefined,
  )
  const seen = new Set<string>()
  const operations: EditOperation[] = []
  for (const paragraph of picks) {
    if (seen.has(paragraph.id)) continue
    seen.add(paragraph.id)
    operations.push({
      type: 'replace_text',
      paragraphId: paragraph.id,
      oldText: paragraph.text,
      newText: `【수정확인 ${operations.length + 1}】 ${paragraph.text}`,
      reason: paragraph.split ? '여러 조각으로 갈라진 문단' : '단일 조각 문단',
    })
  }

  // 비어 있던 값 칸을 채운다. 라벨이 붙어 있는 칸을 먼저 고른다 — 어느 자리가
  // 채워졌는지 한글에서 바로 알아볼 수 있어야 한다.
  const blanks = collectParagraphs(document.model).filter((p) => p.text.length === 0)
  const labelled = blanks.filter((p) => labelOf(p.where) !== '')
  let filled = 0
  for (const blank of [...labelled, ...blanks].slice(0, 5)) {
    if (seen.has(blank.id)) continue
    seen.add(blank.id)
    filled += 1
    const label = labelOf(blank.where)
    operations.push({
      type: 'replace_text',
      paragraphId: blank.id,
      oldText: '',
      newText: `【빈칸확인 ${filled}】${label ? ` ${label}` : ''}`,
      reason: `비어 있던 값 칸 (${blank.where})`,
    })
  }

  const changes = document.apply({ operations, summary: '수동 검증용 표시 삽입' })
  const output = await document.toBytes()
  const target = join(outputDir, `${basename(name, '.hwpx')} (수정).hwpx`)
  writeFileSync(target, output)

  console.log(`\n■ ${name}`)
  console.log(`  원본 ${(bytes.byteLength / 1024 / 1024).toFixed(2)}MB → 결과 ${(output.byteLength / 1024 / 1024).toFixed(2)}MB`)
  console.log(`  문단 ${document.model.stats.paragraphCount} / 표 ${document.model.stats.tableCount} / 이미지 ${document.model.stats.imageCount}`)
  console.log(`  수정 ${changes.length}곳 (그중 빈 칸 채우기 ${filled}곳):`)
  for (const change of changes) {
    const before = change.oldText === '' ? '(비어 있던 칸)' : clip(change.oldText)
    console.log(`   - ${change.paragraphId} (${change.reason}) : ${before}`)
  }
  console.log(`  → ${target}`)
}

console.log('\n한글에서 위 파일을 열어 확인할 것:')
console.log('  1. 오류 없이 열리는가.')
console.log('  2. 【수정확인 N】 표시가 원래 문장 앞에 붙었는가.')
console.log('  3. 【빈칸확인 N】이 **비어 있던 칸 안에** 들어갔는가.')
console.log('     옆 라벨이 그대로 남아 있고, 표의 행·열이 밀리지 않아야 한다.')
console.log('  4. 표·이미지·글꼴·여백·페이지 수가 원본과 같은가.')

/** 위치 힌트에서 같은 행 첫 칸의 라벨만 꺼낸다. */
function labelOf(where: string): string {
  return /이 행 첫 칸 "(.+?)"/.exec(where)?.[1] ?? ''
}

function clip(text: string, limit = 46): string {
  return text.length > limit ? `${text.slice(0, limit)}…` : text
}
