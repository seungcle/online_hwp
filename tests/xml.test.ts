import { describe, expect, it } from 'vitest'
import {
  TokenKind,
  XmlError,
  decodeXmlText,
  findNamespacePrefix,
  parseAttributes,
  scanXml,
  slice,
} from '../src/hwpx/xml'

const encode = (value: string): Uint8Array => new TextEncoder().encode(value)

interface Captured {
  kind: TokenKind
  name: string
  text: string
  start: number
  end: number
}

function tokens(xml: string): Captured[] {
  const bytes = encode(xml)
  const out: Captured[] = []
  scanXml(bytes, (token) => {
    out.push({
      kind: token.kind,
      name: slice(bytes, token.nameStart, token.nameEnd),
      text: slice(bytes, token.start, token.end),
      start: token.start,
      end: token.end,
    })
  })
  return out
}

describe('scanXml', () => {
  it('시작/끝/빈 요소와 텍스트를 구분한다', () => {
    const result = tokens('<a><b>hi</b><c/></a>')
    expect(result.map((t) => [t.kind, t.name])).toEqual([
      [TokenKind.Start, 'a'],
      [TokenKind.Start, 'b'],
      [TokenKind.Text, ''],
      [TokenKind.End, 'b'],
      [TokenKind.Empty, 'c'],
      [TokenKind.End, 'a'],
    ])
  })

  it('토큰의 바이트 구간이 원본을 정확히 가리킨다', () => {
    const xml = '<a>hello</a>'
    const bytes = encode(xml)
    for (const token of tokens(xml)) {
      expect(slice(bytes, token.start, token.end)).toBe(token.text)
    }
    const textToken = tokens(xml).find((t) => t.kind === TokenKind.Text)!
    expect(xml.slice(textToken.start, textToken.end)).toBe('hello')
  })

  it('멀티바이트 문자에서도 오프셋이 어긋나지 않는다', () => {
    const xml = '<a>한글 テスト 😀</a>'
    const bytes = encode(xml)
    const textToken = tokens(xml).find((t) => t.kind === TokenKind.Text)!
    expect(slice(bytes, textToken.start, textToken.end)).toBe('한글 テスト 😀')
    // 바이트 오프셋은 문자 인덱스와 다르다 — 그래도 정확해야 한다.
    expect(textToken.end - textToken.start).toBeGreaterThan('한글 テスト 😀'.length)
  })

  it('따옴표 안의 > 를 태그 끝으로 오해하지 않는다', () => {
    const result = tokens('<a title="1 > 0">x</a>')
    expect(result[0]!.kind).toBe(TokenKind.Start)
    expect(result[0]!.name).toBe('a')
    expect(result[1]!.text).toBe('x')
  })

  it('XML 선언과 주석을 건너뛴다', () => {
    const result = tokens('<?xml version="1.0"?><!-- 주석 --><a/>')
    expect(result.map((t) => t.name)).toEqual(['a'])
  })

  it('CDATA는 조용히 넘기지 않고 오류를 낸다', () => {
    expect(() => tokens('<a><![CDATA[x]]></a>')).toThrow(XmlError)
  })

  it('닫히지 않은 태그를 오류로 처리한다', () => {
    expect(() => tokens('<a><b')).toThrow(/닫히지 않았습니다/)
  })

  it('빈 요소의 속성 구간에 슬래시가 포함되지 않는다', () => {
    const xml = '<hp:lineseg textpos="0" flags="393216"/>'
    const bytes = encode(xml)
    let attributes: Record<string, string> = {}
    scanXml(bytes, (token) => {
      attributes = parseAttributes(bytes, token.attrsStart, token.attrsEnd)
    })
    expect(attributes).toEqual({ textpos: '0', flags: '393216' })
  })
})

describe('parseAttributes', () => {
  it('속성을 파싱하고 엔티티를 푼다', () => {
    const xml = '<a x="1" y=\'2\' t="A &amp; B"/>'
    const bytes = encode(xml)
    let attributes: Record<string, string> = {}
    scanXml(bytes, (token) => {
      attributes = parseAttributes(bytes, token.attrsStart, token.attrsEnd)
    })
    expect(attributes).toEqual({ x: '1', y: '2', t: 'A & B' })
  })
})

describe('decodeXmlText', () => {
  it('미리 정의된 엔티티를 푼다', () => {
    expect(decodeXmlText('A &amp; B &lt; C &gt; D &quot;E&quot; &apos;F&apos;')).toBe(
      `A & B < C > D "E" 'F'`,
    )
  })

  it('숫자 참조를 푼다', () => {
    expect(decodeXmlText('&#54620;&#xAE00;')).toBe('한글')
  })

  it('앰퍼샌드가 없으면 원본을 그대로 돌려준다', () => {
    expect(decodeXmlText('그냥 텍스트')).toBe('그냥 텍스트')
  })

  it('알 수 없는 엔티티는 건드리지 않는다', () => {
    expect(decodeXmlText('&nbsp;')).toBe('&nbsp;')
  })
})

describe('findNamespacePrefix', () => {
  it('루트의 xmlns 선언에서 접두사를 찾는다', () => {
    const xml =
      '<?xml version="1.0"?><hs:sec xmlns:hs="urn:s" ' +
      'xmlns:hp="http://www.hancom.co.kr/hwpml/2011/paragraph"><hp:p/></hs:sec>'
    expect(findNamespacePrefix(encode(xml), 'http://www.hancom.co.kr/hwpml/2011/paragraph')).toBe(
      'hp',
    )
  })

  it('한글이 다른 접두사를 써도 따라간다', () => {
    const xml = '<sec xmlns:para="http://www.hancom.co.kr/hwpml/2011/paragraph"/>'
    expect(findNamespacePrefix(encode(xml), 'http://www.hancom.co.kr/hwpml/2011/paragraph')).toBe(
      'para',
    )
  })

  it('없으면 undefined를 돌려준다', () => {
    expect(findNamespacePrefix(encode('<a/>'), 'urn:x')).toBeUndefined()
  })
})
