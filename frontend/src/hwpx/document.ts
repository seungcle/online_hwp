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

/**
 * 빈 문단에 글자를 넣을 수 있는 자리.
 *
 * 양식의 값 칸은 대개 `<hp:run charPrIDRef="30"/>` 하나만 있고 `hp:t`가 없다.
 * 갈아끼울 텍스트 노드가 없으니 예전에는 이런 칸을 아예 손대지 못했다. 그런데
 * 이 서비스가 다루는 문서의 상당수가 **값이 비어 있는 양식**이라, 채우지
 * 못하면 AI가 대신 옆의 라벨을 덮어쓴다(실측으로 확인). 라벨이 지워지는 것이
 * 빈칸으로 남는 것보다 나쁘다.
 *
 * 그래서 비어 있는 요소를 텍스트를 담은 요소로 넓힌다. 두 가지 모양이 있다.
 *
 *     <hp:t/>                      → <hp:t>값</hp:t>
 *     <hp:run charPrIDRef="30"/>   → <hp:run charPrIDRef="30"><hp:t>값</hp:t></hp:run>
 *
 * 추측으로 만든 모양이 아니다. 같은 문서의 값이 있는 칸이 정확히 이 형태이고,
 * charPr 참조도 원본 그대로 남는다. 새 요소를 지어내는 것이 아니라 이미 있는
 * 빈 요소에 텍스트 노드 하나를 넣을 뿐이다.
 *
 * `hp:t`가 이미 있으면 그쪽을 쓴다. 건드리는 바이트가 더 적고 run이 그대로 남는다.
 */
export interface EmptyTextSlot {
  /** 갈아끼울 빈 요소의 시작 오프셋. */
  readonly start: number
  /** 끝 오프셋(exclusive). */
  readonly end: number
  /** 넣을 글자 앞에 붙일 XML. 예: `<hp:t>`. */
  readonly before: string
  /** 뒤에 붙일 XML. 예: `</hp:t>`. */
  readonly after: string
  /** 큰 값이 이긴다. 빈 `hp:t`(2)가 빈 `hp:run`(1)보다 낫다. */
  readonly rank: number
}

/**
 * 문단을 이루는 조각. 글자이거나, 글자는 아니지만 자리를 차지하는 요소다.
 *
 * 후자가 왜 필요한가. 목차 줄은 이렇게 생겼다.
 *
 *     <hp:t>Ⅰ. 훈련과정 개요 </hp:t>
 *     <hp:t><hp:tab width="29961" leader="3"/></hp:t>   ← 폭 29961짜리 탭
 *     <hp:t> 01</hp:t>
 *
 * 예전에는 텍스트 노드만 보고 조각을 만들어서, 문단을 고칠 때 새 글자를 첫
 * 조각에 몰아넣고 나머지를 비웠다. 그러면 **탭이 그대로 남는다.** 29961
 * HWPUNIT은 약 10.5cm라 글자가 엄청나게 벌어져 보였다(실측으로 확인).
 *
 * 그래서 이런 요소도 조각으로 들고 다니고, 문단 텍스트에 자리표를 남긴다.
 * 탭은 `\t`, 강제 줄나눔은 `\n`이다. 새로 만들지는 않는다 — 있던 것을
 * 제자리에 두기 위한 표시일 뿐이다.
 */
export type ParagraphPiece =
  | { readonly kind: 'text'; readonly start: number; readonly end: number; readonly text: string }
  | { readonly kind: 'anchor'; readonly start: number; readonly end: number; readonly char: string }

export interface Paragraph {
  readonly kind: 'paragraph'
  /** 문서 전체에서 안정적인 식별자. 예: `s0-p12`. AI Edit Plan의 target이 된다. */
  readonly id: string
  text: string
  /** 글자 조각만. `pieces`에서 뽑은 것이다. */
  fragments: TextFragment[]
  /** 글자와 자리표를 문서 순서대로. */
  pieces: ParagraphPiece[]
  /** 텍스트가 두 조각 이상으로 쪼개져 있는가. */
  split: boolean
  /**
   * 비어 있고, 글자를 넣을 자리가 있는 문단에만 있다.
   * `fragments`가 비지 않은 문단에는 없다 — 그때는 조각을 갈아끼우면 된다.
   */
  emptySlot?: EmptyTextSlot
  /**
   * 한글이 이 문단에 배정했던 줄 수(`hp:lineseg` 개수).
   *
   * 글자 수와 함께 보면 "이 칸은 한 줄에 몇 글자가 들어가는가"가 나온다.
   * 그 값으로 글이 길어졌을 때 몇 줄이 될지 가늠한다. 폰트 메트릭을 새로
   * 만드는 대신 **문서가 이미 답해 놓은 값**을 쓴다.
   */
  lineCount?: number
  /**
   * 이 문단의 `hp:linesegarray`가 차지한 바이트 구간.
   *
   * 한글이 계산해 둔 줄 배치 캐시다. 텍스트를 고치면 낡은 값이 되고, 한글은
   * 낡은 값을 그대로 믿어 글자가 셀 밖으로 넘친다. 내려받기 직전에 이 구간을
   * 지워 한글이 다시 계산하게 만든다(`layout.ts`).
   */
  lineSegSpan?: ByteSpan
  /**
   * 이 문단을 감싸고 있는 바깥 문단의 id. 표는 `hp:p > hp:run > hp:tbl` 안에
   * 들어가므로, 셀 안 문단이 길어지면 바깥 문단의 줄 배치도 함께 낡는다.
   */
  parentId?: string
}

export interface ByteSpan {
  readonly start: number
  /** exclusive. */
  readonly end: number
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
  /** `hp:cellSz`의 값과 바이트 구간. 높이는 한글이 줄 수에 맞춰 계산한 값이다. */
  width?: number
  height?: number
  sizeSpan?: ByteSpan
}

export interface Table {
  readonly kind: 'table'
  readonly id: string
  readonly rows: TableCell[][]
  /**
   * 표 개체의 상자 크기(`hp:sz`)와 그 바이트 구간.
   *
   * 셀 높이와 마찬가지로 한글이 계산해 저장한 값이다. 표가 커지면 이 상자도
   * 커져야 하는데, 실측한 실제 문서에서는 **어떤 표도 한 페이지를 넘지 않는다**
   * (최대 67594 < 쓸 수 있는 높이 75684). 양식이 그렇게 설계돼 있다.
   */
  boxHeight?: number
  boxWidth?: number
  boxSpan?: ByteSpan
  /**
   * `hp:pos`의 `treatAsChar`. 0이면 글자처럼 취급하지 않는 **개체**라
   * 본문 흐름에서 빠져 페이지를 넘겨 나뉘지 않는다. 1이면 글자처럼 흐른다.
   */
  treatAsChar?: boolean
  posSpan?: ByteSpan
  /** `hp:tbl`의 `pageBreak`. TABLE / CELL / NONE. */
  pageBreak?: string
  /** `hp:tbl` 여는 태그의 바이트 구간. 속성 하나만 고칠 때 쓴다. */
  headSpan?: ByteSpan
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

/** 용지와 여백. 표가 한 페이지에 들어가는지 재는 데 쓴다. */
export interface PageMetrics {
  readonly width: number
  readonly height: number
  readonly top: number
  readonly bottom: number
  readonly header: number
  readonly footer: number
}

/** 본문이 실제로 쓸 수 있는 세로 길이. */
export function usableHeight(page: PageMetrics | undefined): number {
  if (!page) return 0
  return Math.max(0, page.height - page.top - page.bottom - page.header - page.footer)
}

export interface SectionModel {
  readonly name: string
  readonly index: number
  readonly blocks: Block[]
  readonly paragraphs: Paragraph[]
  readonly page?: PageMetrics
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
  LineSegArray = 13,
  CellSize = 14,
  ObjectSize = 15,
  ObjectPos = 16,
  Tab = 17,
  LineBreak = 18,
  LineSeg = 19,
  PagePr = 20,
  PageMargin = 21,
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
    // 줄 배치 캐시. 텍스트를 고치면 낡은 값이 되므로 위치를 기억해 둔다.
    { id: Tag.LineSegArray, bytes: tagBytes(`${p}linesegarray`) },
    // 셀 높이. 한글이 줄 수에 맞춰 계산해 둔 값이다.
    { id: Tag.CellSize, bytes: tagBytes(`${p}cellSz`) },
    // 개체(표·그림)의 상자 크기와 배치 방식. 표 바로 밑에 있을 때만 표의 것이다.
    { id: Tag.ObjectSize, bytes: tagBytes(`${p}sz`) },
    { id: Tag.ObjectPos, bytes: tagBytes(`${p}pos`) },
    // 문단 안에 섞여 들어오는 **폭을 가진** 요소들. 글자가 아니지만 자리를 차지한다.
    { id: Tag.Tab, bytes: tagBytes(`${p}tab`) },
    { id: Tag.LineBreak, bytes: tagBytes(`${p}lineBreak`) },
    // 줄 하나. 개수가 곧 그 문단이 차지한 줄 수다.
    { id: Tag.LineSeg, bytes: tagBytes(`${p}lineseg`) },
    // 용지와 여백. 표가 페이지를 넘치는지 판단하는 기준이 된다.
    { id: Tag.PagePr, bytes: tagBytes(`${p}pagePr`) },
    { id: Tag.PageMargin, bytes: tagBytes(`${p}margin`) },
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
  let page: PageMetrics | undefined
  let pageSize: { width: number; height: number } | undefined

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
      paragraph.pieces.push({
        kind: 'text',
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
      // hp:sz / hp:pos 는 그림에도 붙는다. 스택 맨 위가 표일 때만 표의 것이다.
      if (tag === Tag.ObjectSize || tag === Tag.ObjectPos) {
        const table = tables[tables.length - 1]
        if (table && stack[stack.length - 1] === Tag.Table) {
          const attrs = parseAttributes(bytes, token.attrsStart, token.attrsEnd)
          if (tag === Tag.ObjectSize) {
            table.boxWidth = toInt(attrs['width'], 0)
            table.boxHeight = toInt(attrs['height'], 0)
            table.boxSpan = { start: token.start, end: token.end }
          } else {
            table.treatAsChar = attrs['treatAsChar'] === '1'
            table.posSpan = { start: token.start, end: token.end }
          }
        }
      }
      if (tag === Tag.LineSeg) {
        const paragraph = openParagraphs[openParagraphs.length - 1]
        if (paragraph) paragraph.lineCount = (paragraph.lineCount ?? 0) + 1
      }
      if (tag === Tag.PageMargin && pageSize && !page) {
        const m = parseAttributes(bytes, token.attrsStart, token.attrsEnd)
        page = {
          ...pageSize,
          top: toInt(m['top'], 0),
          bottom: toInt(m['bottom'], 0),
          header: toInt(m['header'], 0),
          footer: toInt(m['footer'], 0),
        }
      }
      // 탭·강제 줄나눔은 글자가 아니지만 자리를 차지한다. 조각으로 들고 간다.
      if (tag === Tag.Tab || tag === Tag.LineBreak) {
        const paragraph = openParagraphs[openParagraphs.length - 1]
        const top = stack[stack.length - 1]
        if (paragraph && (top === Tag.Text || top === Tag.Run)) {
          paragraph.pieces.push({
            kind: 'anchor',
            start: token.start,
            end: token.end,
            char: tag === Tag.Tab ? '\t' : '\n',
          })
        }
      }
      // 비어 있는 hp:t / hp:run은 나중에 글자를 넣을 수 있는 자리다.
      const depth = stack.length
      const slotRank =
        tag === Tag.Text && stack[depth - 1] === Tag.Run && stack[depth - 2] === Tag.Paragraph
          ? 2
          : tag === Tag.Run && stack[depth - 1] === Tag.Paragraph
            ? 1
            : 0
      if (slotRank > 0) {
        const paragraph = openParagraphs[openParagraphs.length - 1]
        // 더 나은 자리(hp:t)가 나오면 갈아탄다. 같은 등급이면 첫 번째를 쓴다.
        if (paragraph && slotRank > (paragraph.emptySlot?.rank ?? 0)) {
          const open = slice(bytes, token.start, token.end).replace(/\s*\/>$/, '>')
          paragraph.emptySlot =
            slotRank === 2
              ? { start: token.start, end: token.end, before: open, after: `</${prefix}:t>`, rank: 2 }
              : {
                  start: token.start,
                  end: token.end,
                  before: `${open}<${prefix}:t>`,
                  after: `</${prefix}:t></${prefix}:run>`,
                  rank: 1,
                }
        }
      }
      return
    }

    if (token.kind === TokenKind.Start) {
      if (tag === Tag.PagePr && !pageSize) {
        const a = parseAttributes(bytes, token.attrsStart, token.attrsEnd)
        pageSize = { width: toInt(a['width'], 0), height: toInt(a['height'], 0) }
      }
      if (tag === Tag.LineSegArray) {
        // 여는 태그 위치만 잡아 둔다. 끝은 닫는 태그에서 채운다.
        const paragraph = openParagraphs[openParagraphs.length - 1]
        if (paragraph) paragraph.lineSegSpan = { start: token.start, end: token.end }
      }
      stack.push(tag)
      switch (tag) {
        case Tag.Paragraph: {
          const parent = openParagraphs[openParagraphs.length - 1]
          const paragraph: Paragraph = {
            kind: 'paragraph',
            id: `s${index}-p${paragraphOrdinal++}`,
            text: '',
            fragments: [],
            pieces: [],
            split: false,
            ...(parent ? { parentId: parent.id } : {}),
          }
          openParagraphs.push(paragraph)
          paragraphs.push(paragraph)
          containers[containers.length - 1]!.push(paragraph)
          break
        }
        case Tag.Table: {
          const attrs = parseAttributes(bytes, token.attrsStart, token.attrsEnd)
          const table: Table = {
            kind: 'table',
            id: `s${index}-t${tableOrdinal++}`,
            rows: [],
            ...(attrs['pageBreak'] ? { pageBreak: attrs['pageBreak'] } : {}),
            headSpan: { start: token.start, end: token.end },
          }
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
    if (popped === Tag.LineSegArray) {
      const paragraph = openParagraphs[openParagraphs.length - 1]
      if (paragraph?.lineSegSpan) {
        paragraph.lineSegSpan = { start: paragraph.lineSegSpan.start, end: token.end }
      }
      return
    }
    switch (popped) {
      case Tag.Paragraph: {
        const paragraph = openParagraphs.pop()
        if (paragraph) {
          paragraph.text = paragraph.pieces
            .map((piece) => (piece.kind === 'text' ? piece.text : piece.char))
            .join('')
          paragraph.fragments = paragraph.pieces.filter(
            (piece): piece is Extract<ParagraphPiece, { kind: 'text' }> => piece.kind === 'text',
          )
          paragraph.split = paragraph.fragments.length > 1
          // 조각이 있으면 갈아끼우면 되므로 넣을 자리는 필요 없다.
          if (paragraph.fragments.length > 0) delete paragraph.emptySlot
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

  return { name, index, blocks, paragraphs, ...(page ? { page } : {}) }

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
    if (tag !== Tag.CellAddr && tag !== Tag.CellSpan && tag !== Tag.CellSize) return
    const attributes = parseAttributes(bytes, token.attrsStart, token.attrsEnd)
    if (tag === Tag.CellAddr) {
      cell.column = toInt(attributes['colAddr'], cell.column)
      cell.row = toInt(attributes['rowAddr'], cell.row)
    } else if (tag === Tag.CellSpan) {
      cell.columnSpan = toInt(attributes['colSpan'], 1)
      cell.rowSpan = toInt(attributes['rowSpan'], 1)
    } else {
      cell.width = toInt(attributes['width'], 0)
      cell.height = toInt(attributes['height'], 0)
      cell.sizeSpan = { start: token.start, end: token.end }
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
