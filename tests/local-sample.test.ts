/**
 * 실제 한글이 만든 HWPX에 대한 통합 테스트.
 *
 * 사내 문서는 저장소에 커밋하지 않는다. `fixtures/local/`(gitignore 대상)에
 * `.hwpx`를 넣으면 자동으로 돌고, 없으면 통째로 건너뛴다.
 * 다른 위치를 쓰려면 `HWPX_FIXTURE_DIR` 환경변수를 지정한다.
 */

import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { loadHwpxBytes } from '../src/hwpx/package'
import { renderDocument } from '../src/preview/render'
import { scanXml, TokenKind, slice, decodeXmlText } from '../src/hwpx/xml'

const directory = resolve(process.env['HWPX_FIXTURE_DIR'] ?? 'fixtures/local')
const samples = existsSync(directory)
  ? readdirSync(directory).filter((name) => name.toLowerCase().endsWith('.hwpx'))
  : []

describe.skipIf(samples.length === 0)('실제 HWPX 샘플', () => {
  for (const name of samples) {
    describe(name, () => {
      const bytes = new Uint8Array(readFileSync(join(directory, name)))

      it('본문을 파싱하고 문단을 찾는다', async () => {
        const result = await loadHwpxBytes(bytes, name)
        expect(result.model.sections.length).toBeGreaterThan(0)
        expect(result.model.stats.textParagraphCount).toBeGreaterThan(0)
        console.log(
          `[${name}] ${(result.meta.fileSize / 1024 / 1024).toFixed(2)}MB, ` +
            `항목 ${result.meta.entryCount}개, 펼친 바이트 ${result.meta.inflatedBytes}, ` +
            `문단 ${result.model.stats.paragraphCount}(텍스트 ${result.model.stats.textParagraphCount}, ` +
            `분할 ${result.model.stats.splitParagraphCount}), 표 ${result.model.stats.tableCount}, ` +
            `총 ${result.timings.total.toFixed(1)}ms ` +
            result.timings.laps.map((lap) => `${lap.name} ${lap.ms.toFixed(1)}ms`).join(' / '),
        )
      })

      it('본문 XML만 펼치고 BinData 등 나머지는 건드리지 않는다', async () => {
        const result = await loadHwpxBytes(bytes, name)
        const { ZipArchive } = await import('../src/hwpx/zip')
        const archive = ZipArchive.open(bytes)
        const sectionBytes = result.meta.sectionNames.reduce(
          (sum, sectionName) => sum + (archive.find(sectionName)?.uncompressedSize ?? 0),
          0,
        )
        // 펼친 바이트가 본문 XML 합계와 정확히 같아야 한다.
        // 이미지를 하나라도 건드렸다면 여기서 어긋난다.
        expect(result.meta.inflatedBytes).toBe(sectionBytes)
      })

      it('문단 조각의 바이트 구간이 원본을 정확히 가리킨다', async () => {
        const result = await loadHwpxBytes(bytes, name)
        // section XML을 한 번 더 직접 읽어 조각을 대조한다.
        const { ZipArchive } = await import('../src/hwpx/zip')
        const archive = ZipArchive.open(bytes)
        for (const section of result.model.sections) {
          const xml = await archive.read(section.name)
          for (const paragraph of section.paragraphs) {
            for (const fragment of paragraph.fragments) {
              expect(fragment.end).toBeGreaterThan(fragment.start)
              const raw = new TextDecoder().decode(xml.subarray(fragment.start, fragment.end))
              expect(decodeXmlText(raw)).toBe(fragment.text)
            }
          }
        }
      })

      it('독립적인 방식으로 다시 세어도 문단 텍스트가 같다', async () => {
        const result = await loadHwpxBytes(bytes, name)
        const { ZipArchive } = await import('../src/hwpx/zip')
        const archive = ZipArchive.open(bytes)
        for (const section of result.model.sections) {
          const xml = await archive.read(section.name)
          expect(independentParagraphTexts(xml)).toEqual(
            section.paragraphs.map((paragraph) => paragraph.text),
          )
        }
      })

      it('실제 문서를 수정해도 이미지와 ZIP 구조가 그대로 남는다', async () => {
        const { HwpxDocument } = await import('../src/hwpx/session')
        const { ZipArchive } = await import('../src/hwpx/zip')
        const loaded = await loadHwpxBytes(bytes, name)
        const document = HwpxDocument.fromLoadResult(loaded)

        // 여러 조각으로 갈라진 문단을 우선 고른다. 가장 위험한 경로다.
        const paragraphs = document.model.sections.flatMap((section) => section.paragraphs)
        const targets = [
          paragraphs.find((p) => p.split && p.text.trim().length > 4),
          paragraphs.find((p) => !p.split && p.text.trim().length > 4),
        ].filter((p): p is NonNullable<typeof p> => p !== undefined)
        if (targets.length === 0) return

        document.apply({
          summary: '테스트',
          operations: targets.map((paragraph) => ({
            type: 'replace_text' as const,
            paragraphId: paragraph.id,
            oldText: paragraph.text,
            newText: `[변경] ${paragraph.text}`,
          })),
        })
        const output = await document.toBytes()

        const before = ZipArchive.open(bytes)
        const after = ZipArchive.open(output)
        expect(after.entries.map((e) => e.name)).toEqual(before.entries.map((e) => e.name))
        expect(after.entries.map((e) => e.compressionMethod)).toEqual(
          before.entries.map((e) => e.compressionMethod),
        )

        const changed: string[] = []
        for (const entry of before.entries) {
          const oldBytes = await before.read(entry.name)
          const newBytes = await after.read(entry.name)
          if (!indexedEqual(oldBytes, newBytes)) changed.push(entry.name)
        }
        // 본문 XML 말고는 아무것도 바뀌면 안 된다. 이미지 포함.
        expect(changed.every((entry) => /^Contents\/section\d+\.xml$/.test(entry))).toBe(true)
        expect(changed.length).toBeGreaterThan(0)

        // 결과 파일이 다시 열리고 수정이 반영돼 있어야 한다.
        const reopened = await loadHwpxBytes(output, `${name} (수정)`)
        const reopenedTexts = reopened.model.sections.flatMap((section) =>
          section.paragraphs.map((paragraph) => paragraph.text),
        )
        for (const paragraph of targets) {
          expect(reopenedTexts).toContain(`[변경] ${paragraph.text}`)
        }
        for (const section of reopened.model.sections) {
          const xml = ZipArchive.open(output)
          ET_wellFormed(await xml.read(section.name))
        }
      })

      it('미리보기 HTML을 만든다', async () => {
        const result = await loadHwpxBytes(bytes, name)
        const html = renderDocument(result.model)
        expect(html).toContain('<section class="pv-section"')
        expect(html).not.toContain('<script')
      })
    })
  }
})

function indexedEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.byteLength !== b.byteLength) return false
  for (let i = 0; i < a.byteLength; i += 1) if (a[i] !== b[i]) return false
  return true
}

/** 결과 XML이 well-formed인지 확인한다. 스캐너가 끝까지 읽히면 통과로 본다. */
function ET_wellFormed(xml: Uint8Array): void {
  let depth = 0
  scanXml(xml, (token) => {
    if (token.kind === TokenKind.Start) depth += 1
    else if (token.kind === TokenKind.End) depth -= 1
    expect(depth).toBeGreaterThanOrEqual(0)
  })
  expect(depth).toBe(0)
}

/**
 * 문서 모델(document.ts)을 거치지 않고 문단 텍스트를 다시 만든다.
 * 모델의 스택/컨테이너 로직에 버그가 생기면 두 결과가 어긋난다.
 */
function independentParagraphTexts(xml: Uint8Array): string[] {
  const paragraphs: string[] = []
  const stack: string[] = []
  const open: { index: number; parts: string[] }[] = []

  scanXml(xml, (token) => {
    if (token.kind === TokenKind.Text) {
      const current = open[open.length - 1]
      const depth = stack.length
      if (
        current &&
        depth >= 3 &&
        stack[depth - 1]?.endsWith(':t') &&
        stack[depth - 2]?.endsWith(':run') &&
        stack[depth - 3]?.endsWith(':p')
      ) {
        current.parts.push(decodeXmlText(slice(xml, token.start, token.end)))
      }
      return
    }
    if (token.kind === TokenKind.Empty) return

    const name = slice(xml, token.nameStart, token.nameEnd)
    if (token.kind === TokenKind.Start) {
      stack.push(name)
      if (name.endsWith(':p')) {
        paragraphs.push('')
        open.push({ index: paragraphs.length - 1, parts: [] })
      }
      return
    }

    stack.pop()
    if (name.endsWith(':p')) {
      const finished = open.pop()
      if (finished) paragraphs[finished.index] = finished.parts.join('')
    }
  })

  return paragraphs
}
