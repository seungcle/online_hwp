/**
 * `samples/local/`의 실제 HWPX에 수정을 적용해 결과 파일을 만든다.
 * 한글에서 직접 열어 서식과 이미지가 살아 있는지 눈으로 확인하기 위한 것이다.
 *
 *   npm run sample:edit
 *
 * AI를 부르지 않는다. 사람이 만든 Edit Plan을 그대로 적용한다.
 * patch engine만 따로 확인하려는 목적이기 때문이다.
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { basename, join, resolve } from 'node:path'
import { loadHwpxBytes } from '../frontend/src/hwpx/package'
import { HwpxDocument } from '../frontend/src/hwpx/session'
import type { EditOperation } from '../frontend/src/hwpx/patch'

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

  const changes = document.apply({ operations, summary: '수동 검증용 표시 삽입' })
  const output = await document.toBytes()
  const target = join(outputDir, `${basename(name, '.hwpx')} (수정).hwpx`)
  writeFileSync(target, output)

  console.log(`\n■ ${name}`)
  console.log(`  원본 ${(bytes.byteLength / 1024 / 1024).toFixed(2)}MB → 결과 ${(output.byteLength / 1024 / 1024).toFixed(2)}MB`)
  console.log(`  문단 ${document.model.stats.paragraphCount} / 표 ${document.model.stats.tableCount} / 이미지 ${document.model.stats.imageCount}`)
  console.log(`  수정 ${changes.length}곳:`)
  for (const change of changes) {
    console.log(`   - ${change.paragraphId} (${change.reason}) : ${clip(change.oldText)}`)
  }
  console.log(`  → ${target}`)
}

console.log('\n한글에서 위 파일을 열어 【수정확인 N】 표시가 붙었는지, 서식과 이미지가 그대로인지 확인하세요.')

function clip(text: string, limit = 46): string {
  return text.length > limit ? `${text.slice(0, limit)}…` : text
}
