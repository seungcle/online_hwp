/**
 * 미리보기 추출이 문서 크기에 따라 비정상적으로 느려지지 않는지 확인한다.
 *
 * 절대 시간은 기계마다 다르므로 임계값은 넉넉하게 잡았다. 이 테스트가 잡으려는
 * 건 "빠른가"가 아니라 **"어디선가 O(n^2)로 터지지 않는가"** 다.
 */

import { describe, expect, it } from 'vitest'
import { buildHwpx, cell, para, run, table, text } from './helpers/hwpx-fixture'
import { loadHwpxBytes } from '../src/hwpx/package'
import { renderDocument } from '../src/preview/render'

const NS = [
  'xmlns:hs="http://www.hancom.co.kr/hwpml/2011/section"',
  'xmlns:hp="http://www.hancom.co.kr/hwpml/2011/paragraph"',
].join(' ')

function bigSection(paragraphCount: number, tableCount: number): string {
  const parts: string[] = []
  for (let i = 0; i < paragraphCount; i += 1) {
    // 실제 문서처럼 일부는 여러 run으로 갈라 둔다.
    parts.push(
      i % 5 === 0
        ? para(run(text(`${i}번 문단 앞부분 `), '1') + run(text('뒷부분입니다.'), '2'))
        : para(run(text(`${i}번 문단입니다. 실제 문서와 비슷한 길이의 한국어 문장을 넣는다.`))),
    )
  }
  for (let i = 0; i < tableCount; i += 1) {
    parts.push(
      para(
        run(
          table([
            cell(para(run(text('항목'))), 0, 0) + cell(para(run(text(`값 ${i}`))), 1, 0),
            cell(para(run(text('비고'))), 0, 1) + cell(para(run(text('없음'))), 1, 1),
          ]),
        ),
      ),
    )
  }
  return `<?xml version="1.0" encoding="UTF-8"?><hs:sec ${NS}>${parts.join('')}</hs:sec>`
}

async function measure(paragraphCount: number, tableCount: number, imageBytes = 0) {
  const bytes = await buildHwpx({
    sections: [bigSection(paragraphCount, tableCount)],
    imageBytes,
  })
  const started = performance.now()
  const result = await loadHwpxBytes(bytes, 'big.hwpx')
  const parsed = performance.now()
  const html = renderDocument(result.model)
  const rendered = performance.now()
  return {
    result,
    html,
    parseMs: parsed - started,
    renderMs: rendered - parsed,
    totalMs: rendered - started,
  }
}

describe('미리보기 추출 성능', () => {
  it('2000 문단 + 100 표 문서를 1초 안에 처리한다', async () => {
    const { result, html, parseMs, renderMs, totalMs } = await measure(2000, 100)
    expect(result.model.stats.paragraphCount).toBeGreaterThan(2000)
    expect(result.model.stats.tableCount).toBe(100)
    expect(html.length).toBeGreaterThan(0)
    console.log(
      `[perf] 2000문단/100표: 파싱 ${parseMs.toFixed(1)}ms, 렌더 ${renderMs.toFixed(1)}ms, 합계 ${totalMs.toFixed(1)}ms`,
    )
    expect(totalMs).toBeLessThan(1000)
  })

  it('문단 수가 4배가 되어도 시간이 제곱으로 늘지 않는다', async () => {
    const small = await measure(500, 10)
    const large = await measure(2000, 40)
    const ratio = large.totalMs / Math.max(small.totalMs, 0.5)
    console.log(
      `[perf] 500→2000 문단 배율 ${ratio.toFixed(2)}x ` +
        `(${small.totalMs.toFixed(1)}ms → ${large.totalMs.toFixed(1)}ms)`,
    )
    // 선형이면 4배. 여유를 둬서 10배를 넘으면 실패로 본다.
    expect(ratio).toBeLessThan(10)
  })

  it('10MB짜리 이미지가 들어 있어도 본문 처리 시간이 늘지 않는다', async () => {
    const withoutImage = await measure(1000, 20)
    const withImage = await measure(1000, 20, 10_000_000)
    console.log(
      `[perf] 이미지 없음 ${withoutImage.totalMs.toFixed(1)}ms / ` +
        `10MB 이미지 포함 ${withImage.totalMs.toFixed(1)}ms ` +
        `(펼친 바이트 ${withImage.result.meta.inflatedBytes})`,
    )
    expect(withImage.result.meta.fileSize).toBeGreaterThan(10_000_000)
    expect(withImage.result.meta.inflatedBytes).toBeLessThan(2_000_000)
    expect(withImage.totalMs).toBeLessThan(withoutImage.totalMs + 400)
  })
})
