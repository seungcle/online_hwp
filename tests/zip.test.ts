import { describe, expect, it } from 'vitest'
import { buildZip } from './helpers/zip-builder'
import { COMPRESSION_DEFLATE, COMPRESSION_STORED, ZipArchive, ZipError } from '../src/hwpx/zip'

describe('ZipArchive', () => {
  it('중앙 디렉터리 순서를 그대로 보존한다', async () => {
    const bytes = await buildZip([
      { name: 'mimetype', data: 'application/hwp+zip', stored: true },
      { name: 'Contents/header.xml', data: '<h/>' },
      { name: 'Contents/section0.xml', data: '<s/>' },
    ])
    const archive = ZipArchive.open(bytes)
    expect(archive.entries.map((entry) => entry.name)).toEqual([
      'mimetype',
      'Contents/header.xml',
      'Contents/section0.xml',
    ])
    expect(archive.entries.map((entry) => entry.index)).toEqual([0, 1, 2])
  })

  it('항목별 압축 방식을 구분해서 보존한다', async () => {
    const bytes = await buildZip([
      { name: 'mimetype', data: 'application/hwp+zip', stored: true },
      { name: 'Contents/section0.xml', data: '<s>'.repeat(200) },
    ])
    const archive = ZipArchive.open(bytes)
    expect(archive.find('mimetype')?.compressionMethod).toBe(COMPRESSION_STORED)
    expect(archive.find('Contents/section0.xml')?.compressionMethod).toBe(COMPRESSION_DEFLATE)
  })

  it('무압축 항목을 읽는다', async () => {
    const archive = ZipArchive.open(
      await buildZip([{ name: 'mimetype', data: 'application/hwp+zip', stored: true }]),
    )
    expect(await archive.readText('mimetype')).toBe('application/hwp+zip')
  })

  it('deflate 항목을 읽는다', async () => {
    const payload = '가나다'.repeat(500)
    const archive = ZipArchive.open(await buildZip([{ name: 'a.txt', data: payload }]))
    expect(await archive.readText('a.txt')).toBe(payload)
  })

  it('한글이 포함된 UTF-8 내용을 정확히 복원한다', async () => {
    const payload = '문서 ☎ 特殊 😀'
    const archive = ZipArchive.open(await buildZip([{ name: 'a.txt', data: payload }]))
    expect(await archive.readText('a.txt')).toBe(payload)
  })

  it('타임스탬프와 CRC를 보존한다 (재패키징에 필요)', async () => {
    const archive = ZipArchive.open(
      await buildZip([{ name: 'mimetype', data: 'x', stored: true }]),
    )
    const entry = archive.find('mimetype')!
    expect(entry.dosDate).toBe(0x0021) // 1980-01-01
    expect(entry.crc32).toBeGreaterThan(0)
    expect(entry.uncompressedSize).toBe(1)
  })

  it('압축 해제 크기가 다르면 오류를 낸다', async () => {
    const bytes = await buildZip([{ name: 'a.txt', data: 'hello world '.repeat(50) }])
    // 중앙 디렉터리의 uncompressedSize를 망가뜨린다.
    const archive = ZipArchive.open(bytes)
    const view = new DataView(bytes.buffer)
    // 로컬 헤더의 uncompressedSize 위치(offset 22)를 바꿔도 read는 중앙 값을 쓴다.
    const centralOffset = bytes.byteLength - 22
    const central = view.getUint32(centralOffset + 16, true)
    view.setUint32(central + 24, 999999, true)
    const broken = ZipArchive.open(bytes)
    await expect(broken.read('a.txt')).rejects.toThrow(ZipError)
    expect(archive.entries.length).toBe(1)
  })

  it('ZIP이 아니면 명확히 거부한다', () => {
    expect(() => ZipArchive.open(new TextEncoder().encode('그냥 텍스트 파일입니다'))).toThrow(
      /중앙 디렉터리를 찾지 못했습니다/,
    )
  })

  it('너무 작은 파일을 거부한다', () => {
    expect(() => ZipArchive.open(new Uint8Array(4))).toThrow(/너무 작습니다/)
  })

  it('없는 항목을 요청하면 오류를 낸다', async () => {
    const archive = ZipArchive.open(await buildZip([{ name: 'a.txt', data: 'x' }]))
    await expect(archive.read('없음.txt')).rejects.toThrow(/찾을 수 없습니다/)
  })

  it('지원하지 않는 압축 방식을 거부한다', async () => {
    const bytes = await buildZip([{ name: 'a.txt', data: 'hello '.repeat(50) }])
    const view = new DataView(bytes.buffer)
    const centralOffset = bytes.byteLength - 22
    const central = view.getUint32(centralOffset + 16, true)
    view.setUint16(central + 10, 14, true) // LZMA
    await expect(ZipArchive.open(bytes).read('a.txt')).rejects.toThrow(/압축 방식/)
  })
})
