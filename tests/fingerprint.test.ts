/** 구조 지문: 값이 달라도 같아야 하고, 뼈대가 달라지면 달라야 한다. */

import { describe, expect, it } from 'vitest'
import { buildHwpx } from './helpers/hwpx-fixture'
import { buildForm, FIRST_FORM, SECOND_FORM } from './helpers/form-fixture'
import { loadHwpxBytes } from '../frontend/src/hwpx/package'
import { computeStructure } from '../frontend/src/hwpx/fingerprint'

async function structureOf(bytes: Uint8Array) {
  const loaded = await loadHwpxBytes(bytes, 'sample.hwpx')
  return computeStructure(loaded.model)
}

describe('computeStructure', () => {
  it('값이 달라도 같은 지문이 나온다 — 이게 이 기능의 전제다', async () => {
    const first = await structureOf(await buildForm(FIRST_FORM))
    const second = await structureOf(await buildForm(SECOND_FORM))
    expect(second.structureHash).toBe(first.structureHash)
    expect(second.skeleton).toBe(first.skeleton)
  })

  it('표에 행이 늘면 지문이 달라진다', async () => {
    const original = await structureOf(await buildForm(FIRST_FORM))
    const revised = await structureOf(await buildForm(FIRST_FORM, { extraRow: true }))
    expect(revised.structureHash).not.toBe(original.structureHash)
  })

  it('다른 양식과 겹치지 않는다', async () => {
    const form = await structureOf(await buildForm(FIRST_FORM))
    const other = await structureOf(await buildHwpx())
    expect(form.structureHash).not.toBe(other.structureHash)
  })

  it('뼈대에 본문 텍스트가 들어가지 않는다', async () => {
    const structure = await structureOf(await buildForm(FIRST_FORM))
    for (const value of [FIRST_FORM.title, FIRST_FORM.period, FIRST_FORM.owner, '항목']) {
      expect(structure.skeleton).not.toContain(value)
    }
    // 뼈대는 블록 종류와 표 크기만으로 이뤄진다.
    expect(structure.skeleton).toMatch(/^[Spi0-9TxX(){};,<>/]+$/)
  })

  it('표 모양과 문단 수를 담는다', async () => {
    const structure = await structureOf(await buildForm(FIRST_FORM))
    expect(structure.skeleton).toContain('T3x2')
    expect(structure.tableCount).toBe(1)
    expect(structure.imageCount).toBe(0)
    expect(structure.paragraphCount).toBeGreaterThan(0)
  })

  it('문단마다 논리 경로를 준다 — 바이트 오프셋이 아니다', async () => {
    const structure = await structureOf(await buildForm(FIRST_FORM))
    const paths = [...structure.paths.values()]
    expect(paths.length).toBe(structure.paragraphCount)
    expect(new Set(paths).size).toBe(paths.length)
    expect(paths.some((path) => /r\d+c\d+/.test(path))).toBe(true)
    for (const path of paths) expect(path).toMatch(/^s\d+(\/(b\d+|r\d+c\d+))+$/)
  })

  it('같은 문서를 두 번 읽으면 경로도 같다', async () => {
    const bytes = await buildForm(FIRST_FORM)
    const first = await structureOf(bytes)
    const second = await structureOf(bytes)
    expect([...second.paths]).toEqual([...first.paths])
  })
})
