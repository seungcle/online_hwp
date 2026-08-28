/**
 * Cloudflare Worker.
 *
 * 두 가지만 한다.
 *
 * 1. `/api/edit-plan` — OpenAI 프록시. API 키는 Cloudflare Secret으로만 두고
 *    브라우저 번들에는 절대 들어가지 않는다. HWPX 파일 자체는 받지 않는다.
 *    판단에 필요한 문단 id와 텍스트만 받는다.
 * 2. `/naver*` — 사이트 소유확인 파일을 확장자 그대로 200으로 돌려준다.
 *    Workers 정적 자산은 기본적으로 `/x.html`을 `/x`로 307 리다이렉트하는데,
 *    검색엔진 소유확인은 그 주소에서 바로 200이 나와야 안전하다.
 *
 * 나머지 경로는 정적 자산이 그대로 처리한다.
 */

import {
  EDIT_PLAN_SCHEMA,
  SYSTEM_PROMPT,
  SchemaError,
  paragraphChecksum,
  parseEditPlanResponse,
  validateRequest,
  type EditPlanRequest,
} from '../frontend/src/ai/schema'

interface Env {
  ASSETS: { fetch(request: Request): Promise<Response> }
  OPENAI_API_KEY?: string
  OPENAI_MODEL?: string
}

const DEFAULT_MODEL = 'gpt-4.1-mini'
const OPENAI_URL = 'https://api.openai.com/v1/chat/completions'
const TIMEOUT_MS = 45_000
/** 요청 본문 상한. 파일을 통째로 보내는 일이 없도록 넉넉하지만 유한하게 둔다. */
const MAX_BODY_BYTES = 1_000_000

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url)

    if (url.pathname === '/api/edit-plan') {
      return handleEditPlan(request, env)
    }
    if (url.pathname.startsWith('/naver') && url.pathname.endsWith('.html')) {
      return serveExactHtml(request, env, url)
    }
    return env.ASSETS.fetch(request)
  },
}

/** `/naver....html`을 리다이렉트 없이 내용 그대로 돌려준다. */
async function serveExactHtml(request: Request, env: Env, url: URL): Promise<Response> {
  const direct = await env.ASSETS.fetch(request)
  if (direct.status < 300 || direct.status >= 400) return direct

  const location = direct.headers.get('location')
  const target = new URL(location ?? url.pathname.replace(/\.html$/, ''), url)
  const followed = await env.ASSETS.fetch(new Request(target, { headers: request.headers }))
  return new Response(followed.body, {
    status: followed.status,
    headers: {
      'content-type': followed.headers.get('content-type') ?? 'text/html; charset=utf-8',
      'cache-control': 'public, max-age=3600',
    },
  })
}

async function handleEditPlan(request: Request, env: Env): Promise<Response> {
  if (request.method !== 'POST') {
    return fail(405, 'method_not_allowed', 'POST로 요청해 주세요.')
  }
  if (!env.OPENAI_API_KEY) {
    return fail(
      503,
      'not_configured',
      'AI 기능이 아직 설정되지 않았습니다. 서버에 OpenAI API 키가 등록되어야 합니다.',
    )
  }

  const length = Number(request.headers.get('content-length') ?? '0')
  if (length > MAX_BODY_BYTES) {
    return fail(413, 'too_large', '문서가 너무 큽니다.')
  }

  let payload: EditPlanRequest
  try {
    payload = (await request.json()) as EditPlanRequest
    if (!Array.isArray(payload?.paragraphs) || typeof payload?.instruction !== 'string') {
      throw new SchemaError('요청 형식이 올바르지 않습니다.')
    }
    validateRequest(payload)
  } catch (error) {
    return fail(
      400,
      'bad_request',
      error instanceof SchemaError ? error.message : '요청을 이해하지 못했습니다.',
    )
  }

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS)
  try {
    const upstream = await fetch(OPENAI_URL, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${env.OPENAI_API_KEY}`,
        'content-type': 'application/json',
      },
      signal: controller.signal,
      body: JSON.stringify({
        model: env.OPENAI_MODEL ?? DEFAULT_MODEL,
        messages: [
          { role: 'system', content: SYSTEM_PROMPT },
          { role: 'user', content: renderUserMessage(payload) },
        ],
        response_format: {
          type: 'json_schema',
          json_schema: { name: 'edit_plan', strict: true, schema: EDIT_PLAN_SCHEMA },
        },
      }),
    })

    if (!upstream.ok) {
      const detail = await upstream.text()
      console.error('openai error', upstream.status, detail.slice(0, 500))
      return fail(
        502,
        'upstream_error',
        upstream.status === 429
          ? 'AI 요청이 몰려 있습니다. 잠시 후 다시 시도해 주세요.'
          : 'AI 서비스에서 오류가 돌아왔습니다.',
      )
    }

    const body = (await upstream.json()) as {
      choices?: { message?: { content?: string; refusal?: string } }[]
    }
    const message = body.choices?.[0]?.message
    if (message?.refusal) {
      return fail(422, 'refused', `AI가 요청을 거절했습니다: ${message.refusal}`)
    }
    if (!message?.content) {
      return fail(502, 'empty_response', 'AI가 빈 응답을 보냈습니다.')
    }

    // 여기서 한 번 검증하고, 브라우저에서 또 검증한다.
    const plan = parseEditPlanResponse(JSON.parse(message.content))
    return Response.json(plan, {
      headers: { 'cache-control': 'no-store' },
    })
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') {
      return fail(504, 'timeout', 'AI 응답이 너무 오래 걸립니다. 다시 시도해 주세요.')
    }
    if (error instanceof SchemaError || error instanceof SyntaxError) {
      return fail(502, 'invalid_plan', 'AI가 예상한 형식으로 답하지 않았습니다.')
    }
    console.error('edit-plan failed', error)
    return fail(500, 'internal_error', '수정 계획을 만들지 못했습니다.')
  } finally {
    clearTimeout(timer)
  }
}

/**
 * 문단 목록을 프롬프트 한 덩어리로 만든다.
 *
 * 텍스트를 JSON 문자열로 감싸는 것이 핵심이다. 예전에는
 * `[s0-p40] (본문)    - 임상적 연관성을…` 처럼 맨텍스트로 붙였는데, 이러면
 * 구분자로 쓴 공백과 문단이 원래 가진 들여쓰기 공백이 화면에서 구별되지 않는다.
 * 실제로 모델이 `"   - "`(공백 3칸)를 `" - "`(1칸)으로 줄여 읽어, 원문 대조와
 * newText 들여쓰기가 함께 어긋났다. 큰따옴표 안에 넣으면 어디까지가 텍스트인지
 * 모호할 여지가 없다.
 *
 * 검증코드는 여기서 계산해 붙인다. 브라우저가 응답을 확인할 때 같은 함수를
 * 쓰므로, 프롬프트에 실린 값과 검증에 쓰는 값이 어긋날 수 없다.
 */
function renderUserMessage(payload: EditPlanRequest): string {
  const lines = payload.paragraphs.map(
    (paragraph) =>
      `[${paragraph.id} ${paragraphChecksum(paragraph.text)}] (${paragraph.where}) ` +
      JSON.stringify(paragraph.text),
  )
  return [
    '## 사용자 요청',
    payload.instruction.trim(),
    '',
    '## 문서 문단 목록',
    '형식: [문단id 검증코드] (위치) "현재 텍스트"',
    '텍스트는 JSON 문자열이다. 따옴표 안의 공백까지 모두 실제 글자다.',
    '',
    ...lines,
  ].join('\n')
}

function fail(status: number, code: string, message: string): Response {
  return Response.json({ error: { code, message } }, { status })
}
