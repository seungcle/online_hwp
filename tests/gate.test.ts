/**
 * 로그인 화면이 **기본값으로 닫혀 있는지** 확인한다.
 *
 * JS가 실행되기 전의 화면이 어떤 상태인가가 핵심이다. 업로드 화면이 열린 채로
 * 시작하면 느린 회선에서 번쩍이고, JS가 아예 뜨지 않으면 그대로 남는다.
 * 서버가 AI 호출을 막으니 돈이 새지는 않지만, 닫혀 있어야 할 문이 열려 보이는
 * 것 자체가 잘못이다.
 */

import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const html = readFileSync('frontend/index.html', 'utf-8')

const openingTag = (id: string): string => {
  const match = new RegExp(`<main id="${id}"[^>]*>`).exec(html)
  if (!match) throw new Error(`#${id} 를 찾지 못했습니다.`)
  return match[0]
}

describe('첫 화면', () => {
  it('로그인 화면이 처음부터 보인다', () => {
    expect(openingTag('gate')).not.toContain('hidden')
  })

  it('업로드 화면은 처음에 숨어 있다', () => {
    expect(openingTag('landing')).toContain('hidden')
  })

  it('로그인 입력칸과 버튼이 있다', () => {
    for (const id of ['gate-form', 'gate-id', 'gate-pw', 'gate-submit', 'gate-error']) {
      expect(html).toContain(`id="${id}"`)
    }
  })

  it('비밀번호 칸은 가려진 입력이다', () => {
    expect(/<input id="gate-pw"[^>]*type="password"/.test(html)).toBe(true)
  })

  it('화면 어디에도 비밀번호가 적혀 있지 않다', () => {
    // 자격증명은 Cloudflare Secret 에만 있다. 저장소는 공개다.
    expect(html).not.toMatch(/bnvs/i)
  })
})
