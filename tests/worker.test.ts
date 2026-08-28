/** Worker: OpenAI 프록시와 자산 라우팅. 실제 OpenAI를 부르지 않는다. */

import { afterEach, describe, expect, it, vi } from 'vitest'
import worker from '../backend/index'
import { paragraphChecksum } from '../frontend/src/ai/schema'

const realFetch = globalThis.fetch

afterEach(() => {
  globalThis.fetch = realFetch
  vi.restoreAllMocks()
})

interface FakeEnv {
  ASSETS: { fetch(request: Request): Promise<Response> }
  OPENAI_API_KEY?: string
  OPENAI_MODEL?: string
  OPENAI_REASONING_EFFORT?: string
  OPENAI_TIMEOUT_MS?: string
}

function env(overrides: Partial<FakeEnv> = {}): FakeEnv {
  return {
    ASSETS: {
      fetch: async (request: Request) => {
        const path = new URL(request.url).pathname
        if (path.endsWith('.html')) {
          return new Response(null, {
            status: 307,
            headers: { location: path.replace(/\.html$/, '') },
          })
        }
        return new Response('정적 자산', { status: 200, headers: { 'content-type': 'text/plain' } })
      },
    },
    ...overrides,
  }
}

const validBody = {
  instruction: '기간을 3개월로 바꿔줘',
  paragraphs: [{ id: 's0-p0', text: '사업 기간은 1년 입니다.', where: '본문', path: 's0/b0' }],
}

function post(body: unknown): Request {
  const json = JSON.stringify(body)
  return new Request('https://rhwp.co.kr/api/edit-plan', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'content-length': String(json.length) },
    body: json,
  })
}

function openAiReply(content: unknown): Response {
  return new Response(
    JSON.stringify({ choices: [{ message: { content: JSON.stringify(content) } }] }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  )
}

describe('/api/edit-plan', () => {
  it('키가 없으면 503과 안내 메시지를 준다', async () => {
    const response = await worker.fetch(post(validBody), env())
    expect(response.status).toBe(503)
    const body = await response.json()
    expect(body.error.code).toBe('not_configured')
  })

  it('GET을 거부한다', async () => {
    const request = new Request('https://rhwp.co.kr/api/edit-plan')
    const response = await worker.fetch(request, env({ OPENAI_API_KEY: 'k' }))
    expect(response.status).toBe(405)
  })

  it('형식이 틀린 요청을 400으로 거부한다', async () => {
    const response = await worker.fetch(post({ nope: true }), env({ OPENAI_API_KEY: 'k' }))
    expect(response.status).toBe(400)
  })

  it('빈 요청 문구를 거부한다', async () => {
    const response = await worker.fetch(
      post({ ...validBody, instruction: '  ' }),
      env({ OPENAI_API_KEY: 'k' }),
    )
    expect(response.status).toBe(400)
    expect((await response.json()).error.message).toMatch(/비어 있습니다/)
  })

  it('정상 응답을 그대로 전달한다', async () => {
    const plan = {
      summary: '기간을 바꿨습니다.',
      operations: [
        { paragraphId: 's0-p0', checksum: paragraphChecksum(validBody.paragraphs[0]!.text), newText: '사업 기간은 3개월입니다.', reason: '요청' },
      ],
    }
    globalThis.fetch = vi.fn(async () => openAiReply(plan)) as never
    const response = await worker.fetch(post(validBody), env({ OPENAI_API_KEY: 'k' }))
    expect(response.status).toBe(200)
    const body = await response.json()
    const { debug, ...rest } = body
    expect(rest).toEqual(plan)
    // 처리 경로를 알려 주는 debug 가 함께 온다. 문서 원문은 담기지 않는다.
    expect(debug.aiCalls).toEqual(['plan'])
    expect(JSON.stringify(debug)).not.toContain('사업 기간')
  })

  it('추론 등급을 함께 보내고, 빈 값이면 아예 빼고 보낸다', async () => {
    // 추론을 지원하지 않는 모델로 바꿀 때 400이 나지 않도록 빠질 수 있어야 한다.
    const spy = vi.fn(async () => openAiReply({ summary: 's', operations: [] }))
    globalThis.fetch = spy as never
    await worker.fetch(post(validBody), env({ OPENAI_API_KEY: 'k' }))
    const sent = JSON.parse((spy.mock.calls[0] as never as [string, RequestInit])[1].body as string)
    expect(sent.model).toBe('gpt-5.6-terra')
    expect(sent.reasoning_effort).toBe('low')

    spy.mockClear()
    await worker.fetch(
      post(validBody),
      env({ OPENAI_API_KEY: 'k', OPENAI_MODEL: 'gpt-4.1-mini', OPENAI_REASONING_EFFORT: '' }),
    )
    const plain = JSON.parse((spy.mock.calls[0] as never as [string, RequestInit])[1].body as string)
    expect(plain.model).toBe('gpt-4.1-mini')
    expect('reasoning_effort' in plain).toBe(false)
  })

  it('지난 대화를 시스템 프롬프트와 이번 요청 사이에 끼워 보낸다', async () => {
    const spy = vi.fn(async () => openAiReply({ summary: 's', operations: [] }))
    globalThis.fetch = spy as never
    await worker.fetch(
      post({
        ...validBody,
        instruction: 'AI 교육 제안서로',
        history: [
          { role: 'user', content: '제목 바꿔줘' },
          { role: 'assistant', content: '무엇으로 바꿀까요?' },
        ],
      }),
      env({ OPENAI_API_KEY: 'k' }),
    )
    const sent = JSON.parse((spy.mock.calls[0] as never as [string, RequestInit])[1].body as string)
    // LangChain은 추론 모델에 시스템 지시를 developer 역할로 보낸다. 순서가 핵심이다.
    expect(sent.messages.map((m: { role: string }) => m.role)).toEqual([
      'developer',
      'user',
      'assistant',
      'user',
    ])
    expect(sent.messages[1].content).toBe('제목 바꿔줘')
    expect(sent.messages[2].content).toBe('무엇으로 바꿀까요?')
    // 문단 목록은 마지막 요청에만 실린다.
    expect(sent.messages[3].content).toContain('[s0-p0 ')
    expect(sent.messages[1].content).not.toContain('[s0-p0 ')
  })

  it('키가 틀리면 원인을 그대로 알려 준다', async () => {
    // 로컬에서 .dev.vars 자리표시자를 그대로 둔 경우. "AI 서비스 오류"로
    // 뭉뚱그리면 원인을 찾는 데 한참 걸린다.
    globalThis.fetch = vi.fn(
      async () => new Response('{"error":{"code":"invalid_api_key"}}', { status: 401 }),
    ) as never
    const response = await worker.fetch(post(validBody), env({ OPENAI_API_KEY: 'sk-REPLACE_ME' }))
    expect(response.status).toBe(502)
    const body = await response.json()
    expect(body.error.code).toBe('bad_key')
    expect(body.error.message).toMatch(/키가 올바르지 않습니다/)
  })

  it('API 키를 OpenAI에만 보내고 응답에는 담지 않는다', async () => {
    const spy = vi.fn(async () => openAiReply({ summary: 's', operations: [] }))
    globalThis.fetch = spy as never
    const response = await worker.fetch(post(validBody), env({ OPENAI_API_KEY: 'secret-key' }))

    const [url, init] = spy.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe('https://api.openai.com/v1/chat/completions')
    // OpenAI SDK는 헤더를 Headers 객체로 넘긴다.
    expect(new Headers(init.headers).get('authorization')).toBe('Bearer secret-key')
    expect(await response.text()).not.toContain('secret-key')
  })

  it('Structured Outputs 스키마를 강제한다', async () => {
    const spy = vi.fn(async () => openAiReply({ summary: 's', operations: [] }))
    globalThis.fetch = spy as never
    await worker.fetch(post(validBody), env({ OPENAI_API_KEY: 'k' }))
    const init = (spy.mock.calls[0] as unknown as [string, RequestInit])[1]
    const sent = JSON.parse(init.body as string)
    expect(sent.response_format.type).toBe('json_schema')
    expect(sent.response_format.json_schema.strict).toBe(true)
    // 문단 id와 텍스트만 담기고 파일 바이트는 없다.
    expect(sent.messages[1].content).toContain('[s0-p0 ')
    expect(sent.messages[1].content).toContain('사업 기간은 1년 입니다.')
  })

  it('문단 텍스트를 JSON 문자열로 감싸 들여쓰기 공백까지 드러낸다', async () => {
    // 예전 포맷은 `[id] (본문)    - 가나다` 처럼 맨텍스트를 붙였고, 구분자 공백과
    // 문단이 원래 가진 들여쓰기가 섞여 모델이 공백 세 칸을 한 칸으로 줄여 읽었다.
    const spy = vi.fn(async () => openAiReply({ summary: 's', operations: [] }))
    globalThis.fetch = spy as never
    const text = '   - 들여쓰기가 있는 문단  '
    await worker.fetch(
      post({ instruction: '다듬어줘', paragraphs: [{ id: 's0-p0', text, where: '본문' }] }),
      env({ OPENAI_API_KEY: 'k' }),
    )
    const sent = JSON.parse((spy.mock.calls[0] as never as [string, RequestInit])[1].body as string)
    const prompt = sent.messages[1].content as string
    expect(prompt).toContain(`[s0-p0 ${paragraphChecksum(text)}] (본문) ${JSON.stringify(text)}`)
  })

  it('모델을 환경변수로 바꿀 수 있다', async () => {
    const spy = vi.fn(async () => openAiReply({ summary: 's', operations: [] }))
    globalThis.fetch = spy as never
    await worker.fetch(post(validBody), env({ OPENAI_API_KEY: 'k', OPENAI_MODEL: 'gpt-5' }))
    const init = (spy.mock.calls[0] as unknown as [string, RequestInit])[1]
    expect(JSON.parse(init.body as string).model).toBe('gpt-5')
  })

  it('OpenAI 오류를 502로 감싼다', async () => {
    globalThis.fetch = vi.fn(async () => new Response('nope', { status: 500 })) as never
    const response = await worker.fetch(post(validBody), env({ OPENAI_API_KEY: 'k' }))
    expect(response.status).toBe(502)
    expect((await response.json()).error.code).toBe('upstream_error')
  })

  it('요청 제한(429)은 다시 시도하라고 안내한다', async () => {
    globalThis.fetch = vi.fn(async () => new Response('rate', { status: 429 })) as never
    const response = await worker.fetch(post(validBody), env({ OPENAI_API_KEY: 'k' }))
    expect((await response.json()).error.message).toMatch(/잠시 후/)
  })

  it('타임아웃을 504로 처리한다', async () => {
    // LangChain이 오류를 감싸 던지므로 error.name 으로는 중단을 못 알아본다.
    // 실제 흐름 그대로, 제한 시간이 지나 신호가 끊기는 상황을 만든다.
    globalThis.fetch = vi.fn(
      (_url: unknown, init: { signal?: AbortSignal }) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => {
            const error = new Error('aborted')
            error.name = 'AbortError'
            reject(error)
          })
        }),
    ) as never
    const response = await worker.fetch(
      post(validBody),
      env({ OPENAI_API_KEY: 'k', OPENAI_TIMEOUT_MS: '50' }),
    )
    expect(response.status).toBe(504)
    expect((await response.json()).error.code).toBe('timeout')
  })

  it('AI가 답을 내놓지 않으면 422로 구분한다', async () => {
    // 형식 오류(502)와 섞이면 안 된다. 사용자가 볼 문구가 달라야 한다.
    // chat completions 경로에서 LangChain은 거절 사유를 버리고 내용만 비워 보낸다.
    globalThis.fetch = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            choices: [{ message: { role: 'assistant', content: null, refusal: '불가' } }],
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        ),
    ) as never
    const response = await worker.fetch(post(validBody), env({ OPENAI_API_KEY: 'k' }))
    expect(response.status).toBe(422)
    expect((await response.json()).error.code).toBe('refused')
  })

  it('스키마에 맞지 않는 응답을 502로 막는다', async () => {
    globalThis.fetch = vi.fn(async () => openAiReply({ 아무거나: true })) as never
    const response = await worker.fetch(post(validBody), env({ OPENAI_API_KEY: 'k' }))
    expect(response.status).toBe(502)
    expect((await response.json()).error.code).toBe('invalid_plan')
  })

  it('JSON이 아닌 content를 502로 막는다', async () => {
    globalThis.fetch = vi.fn(
      async () =>
        new Response(
          JSON.stringify({ choices: [{ message: { role: 'assistant', content: '그냥 문장' } }] }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        ),
    ) as never
    const response = await worker.fetch(post(validBody), env({ OPENAI_API_KEY: 'k' }))
    expect(response.status).toBe(502)
  })
})

describe('자산 라우팅', () => {
  it('네이버 소유확인 파일을 리다이렉트 없이 200으로 준다', async () => {
    const request = new Request('https://rhwp.co.kr/naver800b4c92f864ba320117cb2d90df370e.html')
    const response = await worker.fetch(request, env())
    expect(response.status).toBe(200)
    expect(await response.text()).toBe('정적 자산')
  })

  it('나머지 경로는 정적 자산이 그대로 처리한다', async () => {
    const response = await worker.fetch(new Request('https://rhwp.co.kr/guide/'), env())
    expect(response.status).toBe(200)
    expect(await response.text()).toBe('정적 자산')
  })
})
