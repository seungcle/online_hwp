/**
 * 바이트 오프셋을 유지하는 최소 XML 스캐너.
 *
 * `DOMParser`를 쓰지 않는 이유가 두 가지 있다.
 *
 * 1. 이후 patch engine이 "원본 XML의 나머지 바이트는 그대로 두고 수정 대상
 *    구간만 교체"해야 한다. DOM으로 파싱해 다시 직렬화하면 그 보장이 깨진다.
 * 2. Node(테스트)와 브라우저에서 완전히 동일하게 돌아야 한다.
 *
 * UTF-8에서 멀티바이트 문자의 모든 바이트는 0x80 이상이므로, `<` `>` `"` 같은
 * ASCII 구분자를 바이트 단위로 찾아도 절대 문자 중간을 자르지 않는다.
 * 이 성질 덕분에 디코딩 없이 바이트만 훑어도 안전하다.
 *
 * HWPX는 기계가 생성한 XML이라 DTD/엔티티 선언/CDATA가 없다.
 * 그런 걸 만나면 조용히 넘기지 않고 오류를 낸다.
 */

export class XmlError extends Error {
  override name = 'XmlError'
}

export const enum TokenKind {
  /** `<tag ...>` */
  Start = 1,
  /** `</tag>` */
  End = 2,
  /** `<tag ... />` */
  Empty = 3,
  /** 태그 사이의 문자 데이터 */
  Text = 4,
}

/**
 * 토큰 객체는 스캔 중 재사용된다. 값을 보관하려면 필요한 필드를 복사해라.
 * (155KB 문서에서 태그 수천 개마다 객체를 만들지 않기 위한 선택이다.)
 */
export interface XmlToken {
  kind: TokenKind
  /** 토큰 전체 시작 바이트 오프셋 (`<` 위치, 텍스트면 첫 글자). */
  start: number
  /** 토큰 전체 끝 바이트 오프셋(exclusive). */
  end: number
  nameStart: number
  nameEnd: number
  attrsStart: number
  attrsEnd: number
}

const LT = 0x3c // <
const GT = 0x3e // >
const SLASH = 0x2f
const QUESTION = 0x3f
const BANG = 0x21
const DASH = 0x2d
const QUOTE = 0x22
const APOS = 0x27

const CDATA_PREFIX = [0x5b, 0x43, 0x44, 0x41, 0x54, 0x41, 0x5b] // [CDATA[

function isSpace(byte: number): boolean {
  return byte === 0x20 || byte === 0x09 || byte === 0x0a || byte === 0x0d
}

function isNameEnd(byte: number): boolean {
  return isSpace(byte) || byte === GT || byte === SLASH
}

/**
 * XML 바이트를 훑으면서 토큰마다 `visit`을 호출한다.
 * `visit`이 `false`를 반환하면 스캔을 중단한다.
 */
export function scanXml(bytes: Uint8Array, visit: (token: XmlToken) => void | boolean): void {
  const token: XmlToken = {
    kind: TokenKind.Text,
    start: 0,
    end: 0,
    nameStart: 0,
    nameEnd: 0,
    attrsStart: 0,
    attrsEnd: 0,
  }
  const length = bytes.length
  let cursor = 0

  while (cursor < length) {
    if (bytes[cursor] !== LT) {
      const textStart = cursor
      while (cursor < length && bytes[cursor] !== LT) cursor += 1
      token.kind = TokenKind.Text
      token.start = textStart
      token.end = cursor
      token.nameStart = token.nameEnd = token.attrsStart = token.attrsEnd = cursor
      if (visit(token) === false) return
      continue
    }

    const tagStart = cursor
    const next = bytes[cursor + 1]

    if (next === QUESTION) {
      cursor = skipUntil(bytes, cursor + 2, QUESTION, GT, '처리 명령(<?...?>)')
      continue
    }

    if (next === BANG) {
      if (matchesAt(bytes, cursor + 2, CDATA_PREFIX)) {
        throw new XmlError('CDATA 구간은 지원하지 않습니다.')
      }
      if (bytes[cursor + 2] === DASH && bytes[cursor + 3] === DASH) {
        cursor = skipComment(bytes, cursor + 4)
        continue
      }
      // <!DOCTYPE ...> 등. HWPX에는 없지만 만나면 통째로 건너뛴다.
      cursor = skipUntilByte(bytes, cursor + 2, GT, '선언(<!...>)') + 1
      continue
    }

    const isEnd = next === SLASH
    let nameStart = cursor + (isEnd ? 2 : 1)
    let scan = nameStart
    while (scan < length && !isNameEnd(bytes[scan]!)) scan += 1
    if (scan === nameStart) {
      throw new XmlError(`${tagStart}번째 바이트에서 태그 이름을 읽지 못했습니다.`)
    }
    const nameEnd = scan

    // 속성 구간을 지나 태그 끝(`>` 또는 `/>`)까지 이동한다.
    // 따옴표 안의 `>`는 태그 끝이 아니다.
    const attrsStart = scan
    let quote = 0
    while (scan < length) {
      const byte = bytes[scan]!
      if (quote !== 0) {
        if (byte === quote) quote = 0
      } else if (byte === QUOTE || byte === APOS) {
        quote = byte
      } else if (byte === GT) {
        break
      }
      scan += 1
    }
    if (scan >= length) {
      throw new XmlError(`${tagStart}번째 바이트에서 시작한 태그가 닫히지 않았습니다.`)
    }
    const selfClosing = !isEnd && bytes[scan - 1] === SLASH
    token.kind = isEnd ? TokenKind.End : selfClosing ? TokenKind.Empty : TokenKind.Start
    token.start = tagStart
    token.end = scan + 1
    token.nameStart = nameStart
    token.nameEnd = nameEnd
    token.attrsStart = attrsStart
    token.attrsEnd = selfClosing ? scan - 1 : scan
    if (visit(token) === false) return
    cursor = scan + 1
  }
}

function matchesAt(bytes: Uint8Array, offset: number, pattern: readonly number[]): boolean {
  for (let i = 0; i < pattern.length; i += 1) {
    if (bytes[offset + i] !== pattern[i]) return false
  }
  return true
}

function skipComment(bytes: Uint8Array, from: number): number {
  for (let i = from; i + 2 < bytes.length; i += 1) {
    if (bytes[i] === DASH && bytes[i + 1] === DASH && bytes[i + 2] === GT) return i + 3
  }
  throw new XmlError('주석이 닫히지 않았습니다.')
}

function skipUntil(
  bytes: Uint8Array,
  from: number,
  first: number,
  second: number,
  what: string,
): number {
  for (let i = from; i + 1 < bytes.length; i += 1) {
    if (bytes[i] === first && bytes[i + 1] === second) return i + 2
  }
  throw new XmlError(`${what}가 닫히지 않았습니다.`)
}

function skipUntilByte(bytes: Uint8Array, from: number, target: number, what: string): number {
  for (let i = from; i < bytes.length; i += 1) {
    if (bytes[i] === target) return i
  }
  throw new XmlError(`${what}가 닫히지 않았습니다.`)
}

const decoder = new TextDecoder('utf-8')

export function slice(bytes: Uint8Array, start: number, end: number): string {
  return decoder.decode(bytes.subarray(start, end))
}

/** 태그 이름을 문자열로 바꾸지 않고 바이트로 바로 비교한다. */
export function tagNameIs(
  bytes: Uint8Array,
  token: XmlToken,
  expected: Uint8Array,
): boolean {
  if (token.nameEnd - token.nameStart !== expected.length) return false
  for (let i = 0; i < expected.length; i += 1) {
    if (bytes[token.nameStart + i] !== expected[i]) return false
  }
  return true
}

const encoder = new TextEncoder()

export function tagBytes(name: string): Uint8Array {
  return encoder.encode(name)
}

/** XML 문자 데이터로 다시 쓸 때 필요한 이스케이프. */
export function escapeXmlText(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

const NAMED_ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
}

/** XML 문자 데이터에서 엔티티를 푼다. HWPX가 쓰는 건 사실상 &amp; 뿐이다. */
export function decodeXmlText(raw: string): string {
  if (!raw.includes('&')) return raw
  return raw.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (match, body: string) => {
    if (body.startsWith('#x') || body.startsWith('#X')) {
      const code = Number.parseInt(body.slice(2), 16)
      return Number.isFinite(code) ? String.fromCodePoint(code) : match
    }
    if (body.startsWith('#')) {
      const code = Number.parseInt(body.slice(1), 10)
      return Number.isFinite(code) ? String.fromCodePoint(code) : match
    }
    return NAMED_ENTITIES[body] ?? match
  })
}

/** 속성 구간을 필요할 때만 파싱한다. */
export function parseAttributes(
  bytes: Uint8Array,
  start: number,
  end: number,
): Record<string, string> {
  const attributes: Record<string, string> = {}
  const text = slice(bytes, start, end)
  const pattern = /([^\s=/>]+)\s*=\s*("([^"]*)"|'([^']*)')/g
  let match: RegExpExecArray | null
  while ((match = pattern.exec(text)) !== null) {
    attributes[match[1]!] = decodeXmlText(match[3] ?? match[4] ?? '')
  }
  return attributes
}

/** 루트 요소의 xmlns 선언에서 특정 네임스페이스 URI에 묶인 접두사를 찾는다. */
export function findNamespacePrefix(bytes: Uint8Array, uri: string): string | undefined {
  let prefix: string | undefined
  scanXml(bytes, (token) => {
    if (token.kind === TokenKind.Text) return true
    const attributes = parseAttributes(bytes, token.attrsStart, token.attrsEnd)
    for (const [key, value] of Object.entries(attributes)) {
      if (key.startsWith('xmlns:') && value === uri) {
        prefix = key.slice('xmlns:'.length)
        return false
      }
    }
    return false // 루트 요소만 본다.
  })
  return prefix
}
