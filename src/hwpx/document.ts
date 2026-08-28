/**
 * `Contents/section*.xml` → 미리보기/AI가 쓸 문서 모델.
 *
 * 가장 중요한 설계 결정: **문단(`hp:p`)을 논리 단위로 삼는다.**
 *
 * 실제 한글 문서에서 한 문장은 `hp:t` 하나에 통째로 들어 있지 않다.
 * 서식이 바뀌면 `hp:run`이 갈라지고, 형광펜 같은 자식 요소가 끼면
 * `hp:t` 안에서도 텍스트가 갈라진다. 실측으로 텍스트가 있는 문단의
 * 약 15%가 두 조각 이상이었다.
 *
 * 그래서 문단 안의 텍스트 조각을 문서 순서대로 모아 하나의 논리 문자열로
 * 만들고, 각 조각이 원본 바이트에서 차지한 구간을 함께 들고 다닌다.
 * 나중에 patch engine은 이 구간만 갈아끼우면 된다.
 */

import type { XmlToken } from './xml'
import {
  TokenKind,
  decodeXmlText,
  findNamespacePrefix,
  parseAttributes,
  scanXml,
  slice,
  tagBytes,
  tagNameIs,
} from './xml'

export const PARAGRAPH_NS = 'http://www.hancom.co.kr/hwpml/2011/paragraph'
export const CORE_NS = 'http://www.hancom.co.kr/hwpml/2011/core'

/** HWPUNIT은 1/7200인치. 화면 96dpi 기준 픽셀로 바꾼다. */
export const HWPUNIT_PER_PX = 75

/** 한 문단 안에서 원본 바이트를 그대로 가리키는 텍스트 조각. */
export interface TextFragment {
  /** section XML 바이트 기준 시작 오프셋. */
  readonly start: number
  /** 끝 오프셋(exclusive). */
  readonly end: number
  /** 엔티티가 풀린 실제 문자열. */
  readonly text: string
}

export interface Paragraph {
  readonly kind: 'paragraph'
  /** 문서 전체에서 안정적인 식별자. 예: `s0-p12`. AI Edit Plan의 target이 된다. */
  readonly id: string
  text: string
  readonly fragments: TextFragment[]
  /** 텍스트가 두 조각 이상으로 쪼개져 있는가. */
  split: boolean
}

export interface TableCell {
  /** `hp:cellAddr`의 colAddr. 0부터 센다. */
  column: number
  /** `hp:cellAddr`의 rowAddr. */
  row: number
  /** `hp:cellSpan`의 colSpan. */
  columnSpan: number
  /** `hp:cellSpan`의 rowSpan. */
  rowSpan: number
  readonly blocks: Block[]
}

export interface Table {
  readonly kind: 'table'
  readonly id: string
  readonly rows: TableCell[][]
}

/**
 * 본문에 박힌 그림. 이번 범위에서 이미지는 **보여 주기만** 한다.
 * 실제 바이트는 ZIP 안에 그대로 있고, 미리보기에서 필요할 때만 꺼낸다.
 */
export interface ImageBlock {
  readonly kind: 'image'
  readonly id: string
  /** `Contents/content.hpf`의 manifest item id. 예: `image1`. */
  binaryItemId: string
  /** 문서에 놓인 크기(HWPUNIT). 0이면 알 수 없음. */
  width: number
  height: number
}

export type Block = Paragraph | Table | ImageBlock

export interface SectionModel {
  readonly name: string
  readonly index: number
  readonly blocks: Block[]
  readonly paragraphs: Paragraph[]
}

export interface DocumentStats {
  paragraphCount: number
  /** 텍스트가 있는 문단 수. */
  textParagraphCount: number
  /** 여러 조각으로 쪼개진 문단 수. */
  splitParagraphCount: number
  tableCount: number
  imageCount: number
  characterCount: number
}

export interface DocumentModel {
  readonly sections: SectionModel[]
  readonly stats: DocumentStats
}

const enum Tag {
  Other = 0,
  Paragraph = 1,
  Run = 2,
  Text = 3,
  Table = 4,
  Row = 5,
  Cell = 6,
  SubList = 7,
  CellAddr = 8,
  CellSpan = 9,
  Picture = 10,
  CurrentSize = 11,
  Image = 12,
}

interface TagMatcher {
  readonly id: Tag
  readonly bytes: Uint8Array
}

function buildMatchers(prefix: string, corePrefix: string | undefined): TagMatcher[] {
  const p = `${prefix}:`
  const matchers: TagMatcher[] = [
    { id: Tag.Paragraph, bytes: tagBytes(`${p}p`) },
    { id: Tag.Run, bytes: tagBytes(`${p}run`) },
    { id: Tag.Text, bytes: tagBytes(`${p}t`) },
    { id: Tag.Table, bytes: tagBytes(`${p}tbl`) },
    { id: Tag.Row, bytes: tagBytes(`${p}tr`) },
    { id: Tag.Cell, bytes: tagBytes(`${p}tc`) },
    { id: Tag.SubList, bytes: tagBytes(`${p}subList`) },
    // 셀 주소와 병합 정보는 hp:tc의 속성이 아니라 형제 자식 요소로 들어온다.
    { id: Tag.CellAddr, bytes: tagBytes(`${p}cellAddr`) },
    { id: Tag.CellSpan, bytes: tagBytes(`${p}cellSpan`) },
    { id: Tag.Picture, bytes: tagBytes(`${p}pic`) },
    { id: Tag.CurrentSize, bytes: tagBytes(`${p}curSz`) },
  ]
  // hc:img는 core 네임스페이스라 접두사가 다르다.
  if (corePrefix) {
    matchers.push({ id: Tag.Image, bytes: tagBytes(`${corePrefix}:img`) })
  }
  return matchers
}

/**
 * section XML 하나를 파싱한다.
 *
 * 네임스페이스 접두사는 루트의 xmlns 선언에서 찾는다. 한글은 언제나 `hp`를
 * 쓰지만 거기에 기대지 않는다.
 */
export function parseSection(bytes: Uint8Array, index: number, name: string): SectionModel {
  const prefix = findNamespacePrefix(bytes, PARAGRAPH_NS)
  if (!prefix) {
    throw new Error(
      `${name}: 한글 문단 네임스페이스를 찾지 못했습니다. HWPX section 파일이 아닌 것 같습니다.`,
    )
  }
  const matchers = buildMatchers(prefix, findNamespacePrefix(bytes, CORE_NS))

  const blocks: Block[] = []
  const paragraphs: Paragraph[] = []
  /** 현재 블록을 담을 컨테이너. 표 셀에 들어가면 셀의 blocks로 바뀐다. */
  const containers: Block[][] = [blocks]
  /** 태그 스택. 텍스트가 `hp:p > hp:run > hp:t` 안에 있는지 판정하는 데 쓴다. */
  const stack: Tag[] = []
  const tables: Table[] = []
  /** 열려 있는 문단들. 표 셀 안의 문단이 바깥 문단 안에 중첩될 수 있다. */
  const openParagraphs: Paragraph[] = []
  /** 열려 있는 표 셀들. cellAddr/cellSpan이 뒤늦게 나오므로 참조를 들고 있어야 한다. */
  const openCells: TableCell[] = []
  /** 열려 있는 그림. curSz와 hc:img가 hp:pic의 자식으로 뒤따라 나온다. */
  const openPictures: ImageBlock[] = []
  let imageOrdinal = 0
  let paragraphOrdinal = 0
  let tableOrdinal = 0

  const identify = (token: XmlToken): Tag => {
    for (const matcher of matchers) {
      if (tagNameIs(bytes, token, matcher.bytes)) return matcher.id
    }
    return Tag.Other
  }

  scanXml(bytes, (token) => {
    if (token.kind === TokenKind.Text) {
      const paragraph = openParagraphs[openParagraphs.length - 1]
      if (!paragraph) return
      const depth = stack.length
      if (
        depth < 3 ||
        stack[depth - 1] !== Tag.Text ||
        stack[depth - 2] !== Tag.Run ||
        stack[depth - 3] !== Tag.Paragraph
      ) {
        return
      }
      const raw = slice(bytes, token.start, token.end)
      if (raw.length === 0) return
      paragraph.fragments.push({
        start: token.start,
        end: token.end,
        text: decodeXmlText(raw),
      })
      return
    }

    const tag = identify(token)

    if (token.kind === TokenKind.Empty) {
      // 빈 요소는 스택 깊이에 영향을 주지 않는다. 셀 메타데이터만 챙긴다.
      applyCellMetadata(tag, token, openCells[openCells.length - 1])
      applyPictureMetadata(tag, token, openPictures[openPictures.length - 1])
      return
    }

    if (token.kind === TokenKind.Start) {
      stack.push(tag)
      switch (tag) {
        case Tag.Paragraph: {
          const paragraph: Paragraph = {
            kind: 'paragraph',
            id: `s${index}-p${paragraphOrdinal++}`,
            text: '',
            fragments: [],
            split: false,
          }
          openParagraphs.push(paragraph)
          paragraphs.push(paragraph)
          containers[containers.length - 1]!.push(paragraph)
          break
        }
        case Tag.Table: {
          const table: Table = { kind: 'table', id: `s${index}-t${tableOrdinal++}`, rows: [] }
          tables.push(table)
          containers[containers.length - 1]!.push(table)
          break
        }
        case Tag.Row: {
          tables[tables.length - 1]?.rows.push([])
          break
        }
        case Tag.Cell: {
          const table = tables[tables.length - 1]
          const cell: TableCell = { column: 0, row: 0, columnSpan: 1, rowSpan: 1, blocks: [] }
          table?.rows[table.rows.length - 1]?.push(cell)
          openCells.push(cell)
          containers.push(cell.blocks)
          break
        }
        case Tag.Picture: {
          const image: ImageBlock = {
            kind: 'image',
            id: `s${index}-i${imageOrdinal++}`,
            binaryItemId: '',
            width: 0,
            height: 0,
          }
          openPictures.push(image)
          containers[containers.length - 1]!.push(image)
          break
        }
        default:
          applyCellMetadata(tag, token, openCells[openCells.length - 1])
          applyPictureMetadata(tag, token, openPictures[openPictures.length - 1])
      }
      return
    }

    // TokenKind.End
    const popped = stack.pop()
    if (popped === undefined) return
    switch (popped) {
      case Tag.Paragraph: {
        const paragraph = openParagraphs.pop()
        if (paragraph) {
          paragraph.text = paragraph.fragments.map((fragment) => fragment.text).join('')
          paragraph.split = paragraph.fragments.length > 1
        }
        break
      }
      case Tag.Cell: {
        containers.pop()
        openCells.pop()
        break
      }
      case Tag.Table: {
        tables.pop()
        break
      }
      case Tag.Picture: {
        openPictures.pop()
        break
      }
    }
  })

  return { name, index, blocks, paragraphs }

  function applyPictureMetadata(tag: Tag, token: XmlToken, image: ImageBlock | undefined): void {
    if (!image) return
    if (tag !== Tag.CurrentSize && tag !== Tag.Image) return
    const attributes = parseAttributes(bytes, token.attrsStart, token.attrsEnd)
    if (tag === Tag.CurrentSize) {
      image.width = toInt(attributes['width'], 0)
      image.height = toInt(attributes['height'], 0)
    } else {
      image.binaryItemId = attributes['binaryItemIDRef'] ?? ''
    }
  }

  function applyCellMetadata(tag: Tag, token: XmlToken, cell: TableCell | undefined): void {
    if (!cell) return
    if (tag !== Tag.CellAddr && tag !== Tag.CellSpan) return
    const attributes = parseAttributes(bytes, token.attrsStart, token.attrsEnd)
    if (tag === Tag.CellAddr) {
      cell.column = toInt(attributes['colAddr'], cell.column)
      cell.row = toInt(attributes['rowAddr'], cell.row)
    } else {
      cell.columnSpan = toInt(attributes['colSpan'], 1)
      cell.rowSpan = toInt(attributes['rowSpan'], 1)
    }
  }
}

function toInt(value: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(value ?? '', 10)
  return Number.isFinite(parsed) ? parsed : fallback
}

export function buildDocumentModel(sections: SectionModel[]): DocumentModel {
  const stats: DocumentStats = {
    paragraphCount: 0,
    textParagraphCount: 0,
    splitParagraphCount: 0,
    tableCount: 0,
    imageCount: 0,
    characterCount: 0,
  }
  for (const section of sections) {
    for (const paragraph of section.paragraphs) {
      stats.paragraphCount += 1
      if (paragraph.text.length > 0) {
        stats.textParagraphCount += 1
        stats.characterCount += paragraph.text.length
      }
      if (paragraph.split) stats.splitParagraphCount += 1
    }
    const counts = countBlocks(section.blocks)
    stats.tableCount += counts.tables
    stats.imageCount += counts.images
  }
  return { sections, stats }
}

function countBlocks(blocks: readonly Block[]): { tables: number; images: number } {
  let tables = 0
  let images = 0
  for (const block of blocks) {
    if (block.kind === 'image') {
      images += 1
      continue
    }
    if (block.kind !== 'table') continue
    tables += 1
    for (const row of block.rows) {
      for (const cell of row) {
        const nested = countBlocks(cell.blocks)
        tables += nested.tables
        images += nested.images
      }
    }
  }
  return { tables, images }
}
