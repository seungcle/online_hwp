/**
 * 합성 HWPX fixture.
 *
 * 실제 한글 문서를 조사하면서 관찰한 형태를 그대로 재현한다.
 * 실제 사내 문서는 저장소에 커밋하지 않는다(`samples/local/` 참고).
 */

import { buildZip, type BuildEntry } from './zip-builder'

const NS = [
  'xmlns:ha="http://www.hancom.co.kr/hwpml/2011/app"',
  'xmlns:hc="http://www.hancom.co.kr/hwpml/2011/core"',
  'xmlns:hp="http://www.hancom.co.kr/hwpml/2011/paragraph"',
  'xmlns:hs="http://www.hancom.co.kr/hwpml/2011/section"',
  'xmlns:hh="http://www.hancom.co.kr/hwpml/2011/head"',
].join(' ')

const LINESEG =
  '<hp:linesegarray><hp:lineseg textpos="0" vertpos="0" vertsize="1000" ' +
  'textheight="1000" baseline="850" spacing="600" horzpos="0" horzsize="42520" ' +
  'flags="393216"/></hp:linesegarray>'

export function para(inner: string, id = '0'): string {
  return (
    `<hp:p id="${id}" paraPrIDRef="0" styleIDRef="0" pageBreak="0" columnBreak="0" ` +
    `merged="0">${inner}${LINESEG}</hp:p>`
  )
}

export function run(inner: string, charPr = '0'): string {
  return `<hp:run charPrIDRef="${charPr}">${inner}</hp:run>`
}

export function text(value: string): string {
  return `<hp:t>${value}</hp:t>`
}

/**
 * 값이 비어 있는 양식 칸. 실제 한글이 만드는 형태 그대로 hp:t가 아예 없다.
 * 이런 칸을 채우지 못하면 AI가 대신 옆의 라벨을 덮어쓴다.
 */
export function emptyRun(charPr = '30'): string {
  return `<hp:run charPrIDRef="${charPr}"/>`
}

/**
 * 목차 줄. 실제 한글이 만드는 형태 그대로 **hp:t 안에 hp:tab** 이 들어 있다.
 * 탭은 폭을 가지므로(실측 29961 HWPUNIT ≈ 10.5cm) 글자만 갈아끼우고 탭을 그냥
 * 두면 그 폭이 통째로 남아 글자가 벌어진다.
 */
export const TOC_SECTION_XML =
  '<?xml version="1.0" encoding="UTF-8" standalone="yes" ?>' +
  `<hs:sec ${NS}>` +
  para(
    run(text('Ⅰ. 훈련과정 개요 ')) +
      run('<hp:t><hp:tab width="29961" leader="3" type="3"/></hp:t>', '30') +
      run(text(' 01'), '31'),
  ) +
  para(run('<hp:t>앞<hp:lineBreak/>뒤</hp:t>')) +
  para(run(text('탭이 없는 평범한 문단'))) +
  '</hs:sec>'

/**
 * 용지 설정과 **개체로 취급되는 표** 하나. 표가 페이지를 넘칠 때 무엇을
 * 바꿔야 하는지 시험하는 데 쓴다.
 *
 * `treatAsChar="0"` 은 글자처럼 취급하지 않는다는 뜻이라 페이지를 넘겨
 * 나뉘지 않는다. `pageBreak="TABLE"` 도 마찬가지다. 둘 다 속성이라 고칠 수 있다.
 */
export function pageTableXml(options: {
  rows?: number
  cellHeight?: number
  treatAsChar?: '0' | '1'
  pageBreak?: string
  rowSpan?: number
} = {}): string {
  const rowCount = options.rows ?? 4
  const height = options.cellHeight ?? 4000
  const span = options.rowSpan ?? 1
  const cells = (r: number): string =>
    [0, 1]
      .map(
        (c) =>
          '<hp:tc name="" header="0" hasMargin="0" protect="0" editable="0" dirty="0" ' +
          'borderFillIDRef="1"><hp:subList id="" textDirection="HORIZONTAL" lineWrap="BREAK" ' +
          `vertAlign="CENTER" linkListIDRef="0" textWidth="0" textHeight="0">${para(
            run(text(`${r}행${c}열`)),
          )}</hp:subList>` +
          `<hp:cellAddr colAddr="${c}" rowAddr="${r}"/>` +
          `<hp:cellSpan colSpan="1" rowSpan="${c === 0 ? span : 1}"/>` +
          `<hp:cellSz width="20000" height="${height}"/>` +
          '<hp:cellMargin left="510" right="510" top="141" bottom="141"/></hp:tc>',
      )
      .join('')
  const body = Array.from({ length: rowCount }, (_u, r) => `<hp:tr>${cells(r)}</hp:tr>`).join('')
  const tbl =
    `<hp:tbl id="1" zOrder="0" numberingType="TABLE" textWrap="TOP_AND_BOTTOM" lock="0" ` +
    `pageBreak="${options.pageBreak ?? 'CELL'}" repeatHeader="1" rowCnt="${rowCount}" colCnt="2" ` +
    `cellSpacing="0" borderFillIDRef="1" noAdjust="1">` +
    `<hp:sz width="40000" widthRelTo="ABSOLUTE" height="${height * rowCount}" heightRelTo="ABSOLUTE" protect="0"/>` +
    `<hp:pos treatAsChar="${options.treatAsChar ?? '0'}" affectLSpacing="0" flowWithText="1" ` +
    'allowOverlap="0" holdAnchorAndSO="0" vertRelTo="PARA" horzRelTo="PARA" vertAlign="TOP" ' +
    'horzAlign="LEFT" vertOffset="0" horzOffset="0"/>' +
    '<hp:outMargin left="0" right="0" top="0" bottom="0"/>' +
    `<hp:inMargin left="510" right="510" top="141" bottom="141"/>${body}</hp:tbl>`

  return (
    '<?xml version="1.0" encoding="UTF-8" standalone="yes" ?>' +
    `<hs:sec ${NS}>` +
    // 용지 설정. 쓸 수 있는 높이 = 84186 - 4251*2 - 2834*2 = 70016
    para(
      '<hp:run charPrIDRef="0"><hp:ctrl><hp:colPr id="" type="NEWSPAPER" layout="LEFT" ' +
        'colCount="1" sameSz="1" sameGap="0"/></hp:ctrl></hp:run>' +
        '<hp:secPr><hp:pagePr landscape="WIDELY" width="59528" height="84186" gutterType="LEFT_ONLY">' +
        '<hp:margin header="2834" footer="2834" gutter="0" left="5669" right="5669" ' +
        'top="4251" bottom="4251"/></hp:pagePr></hp:secPr>',
    ) +
    para(run(tbl)) +
    '</hs:sec>'
  )
}

/** `라벨 | 빈 값` 두 칸짜리 양식. 빈 칸의 모양을 두 가지 다 담았다. */
export const BLANK_FORM_XML =
  '<?xml version="1.0" encoding="UTF-8" standalone="yes" ?>' +
  `<hs:sec ${NS}>` +
  para(
    run(
      table([
        // 1) 빈 run — hp:t 가 없다.
        cell(para(run(text('팀 명'))), 0, 0) + cell(para(emptyRun()), 1, 0),
        // 2) 빈 hp:t — 요소는 있고 안이 비었다.
        cell(para(run(text('연락처'))), 0, 1) + cell(para(run('<hp:t/>', '31')), 1, 1),
      ]),
    ),
  ) +
  para(run(text('아래는 본문입니다.'))) +
  '</hs:sec>'

export function cell(inner: string, col = 0, row = 0): string {
  return (
    '<hp:tc name="" header="0" hasMargin="0" protect="0" editable="0" dirty="0" ' +
    'borderFillIDRef="1"><hp:subList id="" textDirection="HORIZONTAL" lineWrap="BREAK" ' +
    `vertAlign="CENTER" linkListIDRef="0" textWidth="0" textHeight="0">${inner}</hp:subList>` +
    `<hp:cellAddr colAddr="${col}" rowAddr="${row}"/>` +
    '<hp:cellSpan colSpan="1" rowSpan="1"/>' +
    '<hp:cellSz width="20000" height="2000"/>' +
    '<hp:cellMargin left="510" right="510" top="141" bottom="141"/></hp:tc>'
  )
}

/** 실제 한글이 만드는 형태와 같은 그림. 크기와 참조 id가 자식 요소로 들어온다. */
export function picture(binaryItemId = 'image1', width = 43371, height = 18403): string {
  return (
    `<hp:pic id="1161408219" zOrder="9" numberingType="PICTURE" ` +
    `textWrap="TOP_AND_BOTTOM" lock="0" groupLevel="0" reverse="0">` +
    '<hp:offset x="0" y="0"/>' +
    '<hp:orgSz width="118800" height="50400"/>' +
    `<hp:curSz width="${width}" height="${height}"/>` +
    '<hp:flip horizontal="0" vertical="0"/>' +
    `<hc:img binaryItemIDRef="${binaryItemId}" bright="0" contrast="0" effect="REAL_PIC" alpha="0"/>` +
    '<hp:imgRect><hc:pt0 x="0" y="0"/><hc:pt1 x="118800" y="0"/></hp:imgRect>' +
    '</hp:pic>'
  )
}

export function table(rows: string[]): string {
  const body = rows.map((row) => `<hp:tr>${row}</hp:tr>`).join('')
  return (
    `<hp:tbl id="1" zOrder="0" numberingType="TABLE" textWrap="TOP_AND_BOTTOM" ` +
    `lock="0" pageBreak="CELL" repeatHeader="1" rowCnt="${rows.length}" colCnt="2" ` +
    `cellSpacing="0" borderFillIDRef="1" noAdjust="0">${body}</hp:tbl>`
  )
}

/** 프로토타입이 반드시 견뎌야 하는 형태를 한 파일에 모았다. */
export const SECTION_BODY = [
  // 1) 가장 단순한 경우: 한 hp:t에 문장이 통째로 들어 있다.
  para(run(text('2025년 사업 제안서'))),
  // 2) 서식이 중간에 바뀌어 run이 갈라진 경우.
  para(run(text('사업 기간은 '), '1') + run(text('1년'), '2') + run(text(' 입니다.'), '1')),
  // 3) hp:t 안에 자식 요소가 끼어 text/tail로 갈라진 경우 (형광펜).
  para(run('<hp:t>대상은 <hp:markpenBegin/>중학생<hp:markpenEnd/>입니다.</hp:t>')),
  // 4) XML 이스케이프.
  para(run(text('조건: A &amp; B &lt; C &gt; D'))),
  // 5) 빈 문단(빈 줄).
  para(run('<hp:t/>')),
  // 6) 표. 셀 안에도 문단/run 구조가 그대로 들어간다.
  para(
    run(
      table([
        cell(para(run(text('항목'))), 0, 0) + cell(para(run(text('내용'))), 1, 0),
        cell(para(run(text('기간')), '1'), 0, 1) +
          cell(para(run(text('1')) + run(text('년'))), 1, 1),
      ]),
    ),
  ),
  // 7) 그림. 본문 흐름 안의 run에 들어간다.
  para(run(picture())),
  // 8) 표 뒤의 일반 문단.
  para(run(text('문의: 담당자 ☎ 02-000-0000'))),
].join('')

export const SECTION_XML =
  '<?xml version="1.0" encoding="UTF-8" standalone="yes" ?>' +
  `<hs:sec ${NS}>${SECTION_BODY}</hs:sec>`

const HEADER_XML =
  '<?xml version="1.0" encoding="UTF-8" standalone="yes" ?>' +
  `<hh:head ${NS} version="1.4" secCnt="1"><hh:refList/></hh:head>`

const VERSION_XML =
  '<?xml version="1.0" encoding="UTF-8" standalone="yes" ?>' +
  '<hv:HCFVersion xmlns:hv="http://www.hancom.co.kr/hwpml/2011/version" ' +
  'tagetApplication="WORDPROCESSOR" major="5" minor="1" micro="1" buildNumber="0" ' +
  'os="1" xmlVersion="1.5" application="Hancom Office Hangul" appVersion="12, 0, 0, 535"/>'

const CONTENT_HPF =
  '<?xml version="1.0" encoding="UTF-8" standalone="yes" ?>' +
  '<opf:package xmlns:opf="http://www.idpf.org/2007/opf/"><opf:metadata/>' +
  '<opf:manifest>' +
  '<opf:item id="header" href="Contents/header.xml" media-type="application/xml"/>' +
  '<opf:item id="image1" href="BinData/image1.png" media-type="image/png" isEmbeded="1"/>' +
  '<opf:item id="section0" href="Contents/section0.xml" media-type="application/xml"/>' +
  '</opf:manifest></opf:package>'

const CONTAINER_XML =
  '<?xml version="1.0" encoding="UTF-8" standalone="yes" ?>' +
  '<ocf:container xmlns:ocf="urn:oasis:names:tc:opendocument:xmlns:container">' +
  '<ocf:rootfiles><ocf:rootfile full-path="Contents/content.hpf" ' +
  'media-type="application/hwpml-package+xml"/></ocf:rootfiles></ocf:container>'

export interface FixtureOptions {
  sections?: string[]
  /** 필수 항목 중 일부를 빼서 오류 처리를 검증할 때 사용. */
  omit?: string[]
  mimetype?: string
  /** 그림 바이트 크기. 기본값에서도 작은 그림 하나가 들어간다. */
  imageBytes?: number
}

export async function buildHwpx(options: FixtureOptions = {}): Promise<Uint8Array> {
  const sections = options.sections ?? [SECTION_XML]
  const entries: BuildEntry[] = [
    { name: 'mimetype', data: options.mimetype ?? 'application/hwp+zip', stored: true },
    { name: 'version.xml', data: VERSION_XML, stored: true },
    { name: 'Contents/header.xml', data: HEADER_XML },
  ]
  sections.forEach((xml, index) => {
    entries.push({ name: `Contents/section${index}.xml`, data: xml })
  })
  // 압축이 잘 되지 않는 데이터로 채워 실제 이미지에 가깝게 만든다.
  // PNG처럼 이미 압축된 포맷은 한글도 무압축(stored)으로 넣는다.
  const imageSize = Math.max(options.imageBytes ?? 2048, 64)
  const image = new Uint8Array(imageSize)
  image.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
  for (let i = 8; i < image.length; i += 1) image[i] = (i * 2654435761) & 0xff
  entries.push({ name: 'BinData/image1.png', data: image, stored: true })
  entries.push(
    { name: 'Contents/content.hpf', data: CONTENT_HPF },
    { name: 'META-INF/container.xml', data: CONTAINER_XML },
    { name: 'Preview/PrvText.txt', data: '2025년 사업 제안서\n', stored: true },
  )
  const kept = entries.filter((entry) => !options.omit?.includes(entry.name))
  return buildZip(kept)
}

/** 브라우저 `File`처럼 동작하는 최소 객체. Node 20+에는 File이 내장돼 있다. */
export async function buildHwpxFile(
  name = 'sample.hwpx',
  options: FixtureOptions = {},
): Promise<File> {
  const bytes = await buildHwpx(options)
  return new File([bytes as BlobPart], name)
}
