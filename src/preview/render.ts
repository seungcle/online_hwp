/**
 * 문서 모델 → 경량 HTML 미리보기.
 *
 * 한글과 픽셀 단위로 같게 그리는 게 목적이 아니다. 목적은 "AI가 어디를 어떻게
 * 바꿨는지 사용자가 빠르게 확인"하는 것이다. 그래서 문단/표/텍스트만 살리고
 * 글꼴·색·정렬·페이지 나눔은 재현하지 않는다.
 *
 * 문단 수가 많아도 한 번에 그리도록 문자열을 만들어 innerHTML로 넣는다.
 * 노드를 하나씩 만드는 것보다 눈에 띄게 빠르다.
 */

import { HWPUNIT_PER_PX, type Block, type DocumentModel, type ImageBlock, type Paragraph, type Table } from '../hwpx/document'

const ESCAPE_PATTERN = /[&<>"]/g
const ESCAPES: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
}

export function escapeHtml(value: string): string {
  return value.replace(ESCAPE_PATTERN, (char) => ESCAPES[char]!)
}

export function renderDocument(model: DocumentModel): string {
  const out: string[] = []
  for (const section of model.sections) {
    out.push(`<section class="pv-section" data-section="${section.index}">`)
    renderBlocks(section.blocks, out)
    out.push('</section>')
  }
  return out.join('')
}

function renderBlocks(blocks: readonly Block[], out: string[]): void {
  for (const block of blocks) {
    if (block.kind === 'paragraph') renderParagraph(block, out)
    else if (block.kind === 'table') renderTable(block, out)
    else renderImage(block, out)
  }
}

function renderParagraph(paragraph: Paragraph, out: string[]): void {
  if (paragraph.text.length === 0) {
    out.push('<p class="pv-p pv-p--empty"></p>')
    return
  }
  const split = paragraph.split ? ' data-split="1"' : ''
  out.push(
    `<p class="pv-p" data-id="${paragraph.id}"${split}>${escapeHtml(paragraph.text)}</p>`,
  )
}

/**
 * 이미지는 자리와 크기만 먼저 잡아 두고 실제 바이트는 나중에 채운다.
 * 초기 미리보기 속도를 지키기 위해서다 — 화면에 들어올 때 `src`가 붙는다.
 * width/height를 미리 넣어 두면 이미지가 로드될 때 레이아웃이 흔들리지 않는다.
 */
function renderImage(image: ImageBlock, out: string[]): void {
  if (!image.binaryItemId) return
  const width = Math.round(image.width / HWPUNIT_PER_PX)
  const height = Math.round(image.height / HWPUNIT_PER_PX)
  const size = width > 0 && height > 0 ? ` width="${width}" height="${height}"` : ''
  out.push(
    `<img class="pv-img" data-image-id="${escapeHtml(image.binaryItemId)}"${size} ` +
      `alt="문서에 포함된 이미지" loading="lazy" decoding="async">`,
  )
}

function renderTable(table: Table, out: string[]): void {
  out.push(`<table class="pv-table" data-id="${table.id}"><tbody>`)
  for (const row of table.rows) {
    out.push('<tr>')
    for (const cell of row) {
      const attributes =
        (cell.columnSpan > 1 ? ` colspan="${cell.columnSpan}"` : '') +
        (cell.rowSpan > 1 ? ` rowspan="${cell.rowSpan}"` : '')
      out.push(`<td${attributes}>`)
      renderBlocks(cell.blocks, out)
      out.push('</td>')
    }
    out.push('</tr>')
  }
  out.push('</tbody></table>')
}
