import { describe, expect, it } from 'vitest'
import { buildHwpx, buildHwpxFile, SECTION_XML } from './helpers/hwpx-fixture'
import { buildZip } from './helpers/zip-builder'
import { HwpxError, loadHwpx, loadHwpxBytes } from '../frontend/src/hwpx/package'

describe('loadHwpx', () => {
  it('정상 HWPX를 열고 문서 모델을 만든다', async () => {
    const result = await loadHwpxBytes(await buildHwpx(), 'sample.hwpx')
    expect(result.model.sections).toHaveLength(1)
    expect(result.model.stats.tableCount).toBe(1)
    expect(result.meta.sectionNames).toEqual(['Contents/section0.xml'])
  })

  it('한글 버전 정보를 읽는다', async () => {
    const result = await loadHwpxBytes(await buildHwpx(), 'sample.hwpx')
    expect(result.meta.application).toContain('Hancom Office Hangul')
  })

  it('여러 section을 번호 순서대로 처리한다', async () => {
    const result = await loadHwpxBytes(
      await buildHwpx({ sections: [SECTION_XML, SECTION_XML, SECTION_XML] }),
      'multi.hwpx',
    )
    expect(result.meta.sectionNames).toEqual([
      'Contents/section0.xml',
      'Contents/section1.xml',
      'Contents/section2.xml',
    ])
    expect(result.model.sections.map((section) => section.index)).toEqual([0, 1, 2])
    expect(result.model.sections[1]!.paragraphs[0]!.id).toBe('s1-p0')
  })

  it('이미지는 압축을 풀지 않는다', async () => {
    const imageBytes = 3_000_000
    const result = await loadHwpxBytes(await buildHwpx({ imageBytes }), 'big.hwpx')
    expect(result.meta.fileSize).toBeGreaterThan(imageBytes)
    // 실제로 펼친 바이트는 본문 XML 몇 KB 수준이어야 한다.
    expect(result.meta.inflatedBytes).toBeLessThan(100_000)
  })

  it('단계별 소요 시간을 남긴다', async () => {
    const result = await loadHwpxBytes(await buildHwpx(), 'sample.hwpx')
    expect(result.timings.laps.map((lap) => lap.name)).toEqual([
      'ZIP 목록 읽기',
      '본문 압축 해제',
      'XML 파싱',
      '문서 모델 생성',
    ])
    expect(result.timings.total).toBeGreaterThan(0)
  })

  it('원본 바이트를 그대로 들고 있는다 (patch engine이 쓴다)', async () => {
    const bytes = await buildHwpx()
    const result = await loadHwpxBytes(bytes, 'sample.hwpx')
    expect(result.source).toBe(bytes)
  })

  it('구형 .hwp를 확장자로 거부한다', async () => {
    const file = new File([new Uint8Array([1, 2, 3]) as BlobPart], 'old.hwp')
    await expect(loadHwpx(file)).rejects.toThrow(/HWPX.*변환/s)
  })

  it('확장자를 바꿔 놔도 .hwp 내용을 알아본다', async () => {
    const ole = new Uint8Array(64)
    ole.set([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1])
    await expect(loadHwpxBytes(ole, 'disguised.hwpx')).rejects.toThrow(/구형 .hwp/)
  })

  it('hwpx가 아닌 확장자를 거부한다', async () => {
    const file = new File([new Uint8Array([1]) as BlobPart], 'note.txt')
    await expect(loadHwpx(file)).rejects.toThrow(/\.hwpx 파일만/)
  })

  it('ZIP이 아니면 안내 메시지를 준다', async () => {
    const bytes = new TextEncoder().encode('이건 그냥 텍스트입니다'.repeat(10))
    await expect(loadHwpxBytes(bytes, 'broken.hwpx')).rejects.toThrow(HwpxError)
  })

  it('필수 항목이 빠지면 무엇이 없는지 알려준다', async () => {
    const bytes = await buildHwpx({ omit: ['Contents/header.xml'] })
    await expect(loadHwpxBytes(bytes, 'partial.hwpx')).rejects.toThrow(
      /Contents\/header\.xml/,
    )
  })

  it('mimetype이 다르면 거부한다', async () => {
    const bytes = await buildHwpx({ mimetype: 'application/zip' })
    await expect(loadHwpxBytes(bytes, 'fake.hwpx')).rejects.toThrow(/mimetype/)
  })

  it('본문이 없으면 거부한다', async () => {
    const bytes = await buildHwpx({ sections: [] })
    await expect(loadHwpxBytes(bytes, 'empty.hwpx')).rejects.toThrow(/본문/)
  })

  it('HWPX 구조를 흉내낸 다른 ZIP도 걸러낸다', async () => {
    const bytes = await buildZip([{ name: 'hello.txt', data: 'hi' }])
    await expect(loadHwpxBytes(bytes, 'other.hwpx')).rejects.toThrow(/필수 구성요소/)
  })

  it('File 입력을 그대로 처리한다', async () => {
    const file = await buildHwpxFile('제안서.hwpx')
    const result = await loadHwpx(file)
    expect(result.meta.fileName).toBe('제안서.hwpx')
    expect(result.timings.laps[0]!.name).toBe('파일 읽기')
  })
})
