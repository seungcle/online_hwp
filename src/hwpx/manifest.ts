/**
 * `Contents/content.hpf`의 OPF manifest.
 *
 * 본문 XML은 그림을 `binaryItemIDRef="image1"`로만 가리킨다. 실제 파일 경로
 * (`BinData/image1.bmp`)와 MIME 타입은 여기에 있다. 실제 한글 문서를 확인해
 * 보니 `header.xml`에는 목록이 없고 `content.hpf`에만 있었다.
 */

import { TokenKind, parseAttributes, scanXml } from './xml'

export interface ManifestItem {
  readonly id: string
  readonly href: string
  readonly mediaType: string
}

export function parseManifest(bytes: Uint8Array): Map<string, ManifestItem> {
  const items = new Map<string, ManifestItem>()
  scanXml(bytes, (token) => {
    if (token.kind === TokenKind.Text || token.kind === TokenKind.End) return
    const attributes = parseAttributes(bytes, token.attrsStart, token.attrsEnd)
    const id = attributes['id']
    const href = attributes['href']
    if (!id || !href) return
    items.set(id, { id, href, mediaType: attributes['media-type'] ?? '' })
  })
  return items
}
