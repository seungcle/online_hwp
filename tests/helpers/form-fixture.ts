/**
 * "같은 양식, 다른 값" 문서를 만드는 fixture.
 *
 * 알려진 양식 기능이 실제로 지켜야 하는 성질은 하나다 —
 * **값이 달라도 같은 양식으로 알아볼 것.** 그러려면 값만 바꾼 문서와
 * 구조까지 바뀐 문서를 둘 다 만들 수 있어야 한다.
 */

import { buildHwpx, cell, para, run, table, text } from './hwpx-fixture'

const NS = [
  'xmlns:ha="http://www.hancom.co.kr/hwpml/2011/app"',
  'xmlns:hc="http://www.hancom.co.kr/hwpml/2011/core"',
  'xmlns:hp="http://www.hancom.co.kr/hwpml/2011/paragraph"',
  'xmlns:hs="http://www.hancom.co.kr/hwpml/2011/section"',
  'xmlns:hh="http://www.hancom.co.kr/hwpml/2011/head"',
].join(' ')

export interface FormValues {
  title: string
  period: string
  owner: string
}

export const FIRST_FORM: FormValues = {
  title: '2025년 사업 제안서',
  period: '1년',
  owner: '홍길동',
}

/** 같은 양식을 다른 사람이 채운 것. 라벨은 그대로, 값만 다르다. */
export const SECOND_FORM: FormValues = {
  title: 'AI 교육 사업 제안서',
  period: '3개월',
  owner: '김철수',
}

/**
 * 양식 하나. 라벨(`항목`, `내용`, `사업 기간`, `담당자`)은 고정이고
 * 값 문단만 인자로 바뀐다.
 */
export function formSectionXml(values: FormValues, options: { extraRow?: boolean } = {}): string {
  const rows = [
    cell(para(run(text('항목'))), 0, 0) + cell(para(run(text('내용'))), 1, 0),
    cell(para(run(text('사업 기간'))), 0, 1) + cell(para(run(text(values.period))), 1, 1),
    cell(para(run(text('담당자'))), 0, 2) + cell(para(run(text(values.owner))), 1, 2),
  ]
  // 표에 행이 하나 늘면 뼈대가 달라진다. 양식 개정을 흉내 낼 때 쓴다.
  if (options.extraRow) {
    rows.push(cell(para(run(text('예산'))), 0, 3) + cell(para(run(text('1억'))), 1, 3))
  }
  const body = [
    para(run(text(values.title))),
    para(run(text('아래 표와 같이 제안합니다.'))),
    para(run(table(rows))),
  ].join('')
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes" ?><hs:sec ${NS}>${body}</hs:sec>`
}

export function buildForm(
  values: FormValues,
  options: { extraRow?: boolean } = {},
): Promise<Uint8Array> {
  return buildHwpx({ sections: [formSectionXml(values, options)] })
}
