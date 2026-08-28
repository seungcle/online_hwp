/**
 * 문서의 **구조**만 뽑아 지문을 만든다. 같은 양식을 다시 만났는지 알아보는 데 쓴다.
 *
 * 핵심 제약은 하나다. **값이 달라도 같은 지문이 나와야 한다.**
 * 같은 출장보고서 양식이라도 사람마다 이름·날짜·금액이 다르다. 그러니 지문에
 * 본문 텍스트를 넣으면 안 된다. 문단·표·그림이 어떤 순서로 몇 개 있는지,
 * 표가 몇 행 몇 열인지, 셀 안에 무엇이 들어 있는지 — 뼈대만 쓴다.
 *
 * 반대로 뼈대만 보면 성긴 열쇠다. 무관한 두 문서가 우연히 같은 모양일 수 있다.
 * 그래서 지문은 **후보를 좁히는 용도**로만 쓰고, 실제로 그 양식이 맞는지는
 * 저장해 둔 라벨(anchor)이 지금 문서에도 그대로 있는지 대조해서 판정한다.
 * (`backend/templates.ts`의 `matchTemplate`)
 *
 * 바이트 오프셋이나 XML 노드 번호는 쓰지 않는다. 한글에서 다시 저장하면
 * run이 갈라지고 오프셋이 통째로 밀린다. 여기서 만드는 경로(`path`)는
 * "몇 번째 블록, 몇 행 몇 열" 같은 논리적 위치라서 그 영향을 받지 않는다.
 */

import type { Block, DocumentModel, TableCell } from './document'

/** 문단 하나의 논리적 위치. 예: `s0/b4/r1c0/b0`. */
export type StructurePath = string

export interface DocumentStructure {
  /** 뼈대에서 만든 해시. 양식 조회의 열쇠. */
  readonly structureHash: string
  /** 사람이 읽을 수 있는 뼈대. 디버그와 회귀 확인용. */
  readonly skeleton: string
  readonly paragraphCount: number
  readonly tableCount: number
  readonly imageCount: number
  /** 문단 id → 논리 경로. 빈 문단도 포함한다. */
  readonly paths: ReadonlyMap<string, StructurePath>
}

/**
 * 문서 모델에서 구조를 뽑는다. 텍스트 내용은 읽지 않는다.
 */
export function computeStructure(model: DocumentModel): DocumentStructure {
  const paths = new Map<string, StructurePath>()
  let tableCount = 0
  let imageCount = 0
  let paragraphCount = 0

  const encodeBlocks = (blocks: readonly Block[], prefix: string): string => {
    const parts: string[] = []
    blocks.forEach((block, index) => {
      const here = `${prefix}/b${index}`
      if (block.kind === 'paragraph') {
        paragraphCount += 1
        paths.set(block.id, here)
        parts.push('p')
        return
      }
      if (block.kind === 'image') {
        imageCount += 1
        parts.push('i')
        return
      }
      tableCount += 1
      parts.push(encodeTable(block.rows, here))
    })
    return parts.join('')
  }

  const encodeTable = (rows: readonly TableCell[][], prefix: string): string => {
    const body = rows
      .map((row, rowIndex) =>
        row
          .map((cell, columnIndex) => {
            const span = cell.columnSpan === 1 && cell.rowSpan === 1
              ? ''
              : `<${cell.columnSpan}x${cell.rowSpan}>`
            return span + encodeBlocks(cell.blocks, `${prefix}/r${rowIndex}c${columnIndex}`)
          })
          .join(','),
      )
      .join(';')
    const columns = rows.reduce((most, row) => Math.max(most, row.length), 0)
    return `T${rows.length}x${columns}{${body}}`
  }

  const skeleton = model.sections
    .map((section) => `S${section.index}(${encodeBlocks(section.blocks, `s${section.index}`)})`)
    .join('')

  return {
    structureHash: structureHash(skeleton),
    skeleton,
    paragraphCount,
    tableCount,
    imageCount,
    paths,
  }
}

/**
 * 뼈대 문자열을 64비트 해시로 줄인다.
 *
 * FNV-1a를 서로 다른 시작값으로 두 번 돌려 32비트씩 이어 붙인다. 보안 해시가
 * 아니다. 필요한 성질은 두 가지뿐이다 — 같은 뼈대면 브라우저와 Worker에서
 * 같은 값이 나올 것, 그리고 양식 수천 개에서 우연히 겹치지 않을 것.
 * 겹치더라도 라벨 대조가 한 번 더 걸러 준다.
 */
export function structureHash(skeleton: string): string {
  const bytes = new TextEncoder().encode(skeleton)
  return `${fnv1a(bytes, 0x811c9dc5)}${fnv1a(bytes, 0x01000193)}`
}

function fnv1a(bytes: Uint8Array, seed: number): string {
  let hash = seed
  for (const byte of bytes) {
    hash ^= byte
    hash = Math.imul(hash, 0x01000193)
  }
  return (hash >>> 0).toString(16).padStart(8, '0')
}
