import { describe, expect, it } from 'vitest'
import { buildHwpx } from './helpers/hwpx-fixture'
import { loadHwpxBytes } from '../src/hwpx/package'
import { escapeHtml, renderDocument } from '../src/preview/render'

async function html(): Promise<string> {
  const result = await loadHwpxBytes(await buildHwpx(), 'sample.hwpx')
  return renderDocument(result.model)
}

describe('renderDocument', () => {
  it('문단을 p 태그로 그린다', async () => {
    expect(await html()).toContain('<p class="pv-p" data-id="s0-p0">2025년 사업 제안서</p>')
  })

  it('표를 table 태그로 그린다', async () => {
    const markup = await html()
    expect(markup).toContain('<table class="pv-table"')
    expect(markup).toContain('<td>')
    expect(markup.match(/<tr>/g)).toHaveLength(2)
  })

  it('갈라진 문단에 표시를 남긴다', async () => {
    expect(await html()).toContain('data-split="1"')
  })

  it('빈 문단을 빈 줄로 남긴다', async () => {
    expect(await html()).toContain('pv-p--empty')
  })

  it('HTML 특수문자를 이스케이프한다', async () => {
    expect(await html()).toContain('조건: A &amp; B &lt; C &gt; D')
  })

  it('본문에 태그를 주입할 수 없다', () => {
    expect(escapeHtml('<img src=x onerror="alert(1)">')).toBe(
      '&lt;img src=x onerror=&quot;alert(1)&quot;&gt;',
    )
  })

  it('섹션마다 구분된 컨테이너를 만든다', async () => {
    const result = await loadHwpxBytes(
      await buildHwpx({ sections: [(await import('./helpers/hwpx-fixture')).SECTION_XML] }),
      'sample.hwpx',
    )
    expect(renderDocument(result.model)).toContain('data-section="0"')
  })
})
