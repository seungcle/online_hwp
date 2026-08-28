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

import { ChatOpenAI } from '@langchain/openai'
import { AIMessage, HumanMessage, SystemMessage, type BaseMessage } from '@langchain/core/messages'

import {
  EDIT_PLAN_SCHEMA,
  SYSTEM_PROMPT,
  SchemaError,
  paragraphChecksum,
  parseEditPlanResponse,
  validateRequest,
  type EditPlanDebug,
  type EditPlanRequest,
} from '../frontend/src/ai/schema'
import {
  TEMPLATE_ANALYSIS_SCHEMA,
  TEMPLATE_SYSTEM_PROMPT,
  TemplateError,
  toTemplateDefinition,
  type StoredTemplate,
} from '../frontend/src/ai/template'
import {
  D1TemplateStore,
  matchTemplate,
  nextVersion,
  type D1Database,
  type IncomingStructure,
  type TemplateStore,
} from './templates'

interface Env {
  ASSETS: { fetch(request: Request): Promise<Response> }
  OPENAI_API_KEY?: string
  OPENAI_MODEL?: string
  OPENAI_REASONING_EFFORT?: string
  /** 제한 시간(ms). 테스트에서 짧게 두려고 열어 둔다. */
  OPENAI_TIMEOUT_MS?: string
  /**
   * 알려진 양식 저장소. 없어도 서비스는 그대로 돈다 — 매번 처음 보는 문서처럼
   * 처리할 뿐이다. 바인딩이 빠졌다고 편집이 막히면 안 된다.
   */
  TEMPLATES?: D1Database
}

/**
 * 기본 모델. 이 작업은 "문서 전체를 읽고 고칠 문단만 고른 뒤 한국어를 다듬는"
 * 일이라 문맥 유지와 지시 준수가 품질을 가른다. 균형 등급인 terra를 쓴다.
 * (sol은 이 작업에 과하고, luna는 긴 문서에서 엉뚱한 문단을 짚는 일이 늘어난다.)
 */
const DEFAULT_MODEL = 'gpt-5.6-terra'
/**
 * 추론 깊이. 깊은 추론이 필요한 작업이 아니고, 낮출수록 응답이 빨라
 * 아래 제한 시간에 걸릴 일이 준다. 추론을 지원하지 않는 모델로 바꾼다면
 * `OPENAI_REASONING_EFFORT`를 빈 값으로 두어 아예 보내지 않는다.
 */
const DEFAULT_REASONING_EFFORT = 'low'
/**
 * 문서 전체를 다시 쓰는 요청은 출력 토큰이 많아 오래 걸린다. 실측으로 135문단
 * 문서에 "쉽게 써줘"를 던지면 45초를 넘겨 죽었다. 사용자가 다시 시도하는 것보다
 * 기다리는 편이 낫다. 기다리는 동안 CPU를 쓰지 않으므로 Worker 예산과도 무관하다.
 */
const TIMEOUT_MS = 90_000
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
  const limit = Number(env.OPENAI_TIMEOUT_MS ?? '') || TIMEOUT_MS
  const timer = setTimeout(() => controller.abort(), limit)
  const startedAt = Date.now()
  const aiCalls: EditPlanDebug['aiCalls'][number][] = []
  try {
    const lookup = await resolveTemplate(payload, env, controller.signal, aiCalls)
    const aiStartedAt = Date.now()
    const plan = parseEditPlanResponse(
      await callModel(payload, env, controller.signal, lookup.template),
    )
    aiCalls.push('plan')

    const debug: EditPlanDebug = {
      ...lookup.debug,
      aiCalls,
      aiMs: Date.now() - aiStartedAt,
      totalMs: Date.now() - startedAt,
    }
    // Worker에서 한 번 검증하고, 브라우저에서 또 검증한다.
    return Response.json({ ...plan, debug }, {
      headers: { 'cache-control': 'no-store' },
    })
  } catch (error) {
    // LangChain이 오류를 감싸 던져 error.name 으로는 중단을 못 알아본다. 신호를 직접 본다.
    if (controller.signal.aborted) {
      return fail(504, 'timeout', 'AI 응답이 너무 오래 걸립니다. 다시 시도해 주세요.')
    }
    if (error instanceof RefusedError) {
      return fail(
        422,
        'refused',
        error.message
          ? `AI가 요청을 거절했습니다: ${error.message}`
          : 'AI가 이 요청에는 답하지 못했습니다. 다르게 말해 주시면 다시 해 보겠습니다.',
      )
    }
    if (error instanceof SchemaError || error instanceof SyntaxError) {
      return fail(502, 'invalid_plan', 'AI가 예상한 형식으로 답하지 않았습니다.')
    }
    const mapped = mapUpstreamError(error)
    if (mapped) return mapped
    console.error('edit-plan failed', error)
    return fail(500, 'internal_error', '수정 계획을 만들지 못했습니다.')
  } finally {
    clearTimeout(timer)
  }
}

/**
 * 이 문서가 아는 양식인지 찾아본다. 처음 보는 것이면 AI에게 한 번 뜯어보게 하고
 * 그 결과를 저장한다.
 *
 * 여기서 **AI 호출 한 번이 갈린다.** 아는 양식이면 구조 분석을 건너뛰고 바로
 * 수정 계획만 세운다. 처음 보는 양식이면 구조 분석 한 번이 더 든다.
 *
 * 어느 단계가 실패해도 편집 자체는 막지 않는다. D1 바인딩이 없거나, 조회가
 * 실패하거나, 분석이 형식을 어겨도 그냥 "모르는 문서"로 처리하고 넘어간다.
 * 양식 기억은 빠르게 하려고 붙인 장치이지 편집의 전제가 아니다.
 */
async function resolveTemplate(
  payload: EditPlanRequest,
  env: Env,
  signal: AbortSignal,
  aiCalls: EditPlanDebug['aiCalls'][number][],
): Promise<{ template?: StoredTemplate; debug: Omit<EditPlanDebug, 'aiCalls'> }> {
  if (!payload.structure) return { debug: { templateLookup: 'skipped' } }
  if (!env.TEMPLATES) {
    return {
      debug: { structureHash: payload.structure.structureHash, templateLookup: 'unavailable' },
    }
  }

  const store: TemplateStore = new D1TemplateStore(env.TEMPLATES)
  const incoming: IncomingStructure = {
    structureHash: payload.structure.structureHash,
    skeleton: payload.structure.skeleton,
    paragraphs: payload.paragraphs.map((p) => ({ id: p.id, text: p.text, path: p.path })),
  }

  const lookupStartedAt = Date.now()
  let candidates: StoredTemplate[]
  try {
    candidates = await store.findByStructure(incoming.structureHash)
  } catch (error) {
    console.error('template lookup failed', String((error as Error)?.message).slice(0, 200))
    return {
      debug: { structureHash: incoming.structureHash, templateLookup: 'unavailable' },
    }
  }
  const outcome = matchTemplate(candidates, incoming)
  const lookupMs = Date.now() - lookupStartedAt

  if (outcome.kind === 'hit') {
    // 구조 분석을 건너뛴다. aiCalls 에 'structure' 가 없다는 것이 그 증거다.
    return {
      template: outcome.template,
      debug: {
        structureHash: incoming.structureHash,
        templateLookup: 'hit',
        templateId: outcome.template.id,
        templateVersion: outcome.template.version,
        templateName: outcome.template.name,
        anchorRatio: outcome.anchorRatio,
        lookupMs,
      },
    }
  }

  // miss 이거나, 라벨이 어긋나 믿을 수 없는 경우다. 자동으로 고치지 않고 다시 분석한다.
  const fallback =
    outcome.kind === 'stale'
      ? `라벨 ${Math.round(outcome.anchorRatio * 100)}%만 일치해 재분석했습니다.`
      : undefined

  let stored: StoredTemplate | undefined
  try {
    const definition = toTemplateDefinition(
      await analyzeTemplate(payload, env, signal),
      incoming.paragraphs,
    )
    aiCalls.push('structure')
    stored = await store.save(
      incoming.structureHash,
      incoming.skeleton,
      {
        paragraphs: payload.structure.paragraphCount,
        tables: payload.structure.tableCount,
        images: payload.structure.imageCount,
      },
      definition,
      nextVersion(candidates),
    )
  } catch (error) {
    if (signal.aborted) throw error
    // 분석이나 저장이 실패해도 편집은 계속한다. 다음 요청에서 다시 시도하면 된다.
    console.error(
      'template analysis failed',
      error instanceof TemplateError ? error.message : String((error as Error)?.message).slice(0, 200),
    )
  }

  return {
    template: stored,
    debug: {
      structureHash: incoming.structureHash,
      templateLookup: outcome.kind === 'stale' ? 'stale' : 'miss',
      ...(stored
        ? { templateId: stored.id, templateVersion: stored.version, templateName: stored.name }
        : {}),
      ...(outcome.kind === 'stale' ? { anchorRatio: outcome.anchorRatio } : {}),
      ...(fallback ? { fallback } : {}),
      lookupMs,
    },
  }
}

/** 양식을 한 번 뜯어본다. 문서마다 한 번이면 된다. */
async function analyzeTemplate(
  payload: EditPlanRequest,
  env: Env,
  signal: AbortSignal,
): Promise<unknown> {
  const model = newChatModel(env).withStructuredOutput(TEMPLATE_ANALYSIS_SCHEMA, {
    name: 'template_analysis',
    strict: true,
  })
  const lines = payload.paragraphs.map(
    (paragraph) => `[${paragraph.id}] (${paragraph.where}) ${JSON.stringify(paragraph.text)}`,
  )
  return model.invoke(
    [
      new SystemMessage(TEMPLATE_SYSTEM_PROMPT),
      new HumanMessage(['## 문단 목록', ...lines].join('\n')),
    ],
    { signal },
  )
}

function newChatModel(env: Env): ChatOpenAI {
  const effort = env.OPENAI_REASONING_EFFORT ?? DEFAULT_REASONING_EFFORT
  return new ChatOpenAI({
    apiKey: env.OPENAI_API_KEY,
    model: env.OPENAI_MODEL ?? DEFAULT_MODEL,
    ...(effort ? { reasoning: { effort: effort as never } } : {}),
    // 실패는 우리 오류 화면으로 그대로 올린다. 조용히 다시 부르면 45초가 90초가 된다.
    maxRetries: 0,
  })
}

/**
 * 모델 호출. LangChain의 ChatOpenAI를 쓴다.
 *
 * 대화는 `BaseMessage` 배열로 조립한다. 시스템 지시 → 지난 대화 → 이번 요청
 * 순서이고, 문단 목록은 **이번 요청에만** 실린다. 지난 턴은 주고받은 말뿐이다.
 * 문서는 매 턴 바뀌므로 옛 문단 목록을 남겨 두면 모델이 낡은 텍스트를 짚는다.
 *
 * 대화 상태를 서버에 두지 않는다. 이 서비스는 파일도 대화도 저장하지 않는다고
 * 첫 화면에 적혀 있고, 그 약속을 지키려면 기억은 브라우저가 들고 있어야 한다.
 * 그래서 LangGraph의 checkpointer 같은 서버 저장 장치는 쓰지 않는다. Worker는
 * 매 요청 무상태로 남고, 받은 대화를 그대로 모델에 넘길 뿐이다.
 */
async function callModel(
  payload: EditPlanRequest,
  env: Env,
  signal: AbortSignal,
  template?: StoredTemplate,
): Promise<unknown> {
  const model = newChatModel(env).withStructuredOutput(EDIT_PLAN_SCHEMA, {
    name: 'edit_plan',
    strict: true,
    // 원본 메시지도 함께 받는다. 모델이 거절했을 때 그 이유를 그대로 보여 주려면
    // 파싱된 값만으로는 알 수 없다.
    includeRaw: true,
  })

  const messages: BaseMessage[] = [new SystemMessage(SYSTEM_PROMPT)]
  for (const turn of payload.history ?? []) {
    messages.push(
      turn.role === 'assistant' ? new AIMessage(turn.content) : new HumanMessage(turn.content),
    )
  }
  messages.push(new HumanMessage(renderUserMessage(payload, template)))

  const { raw, parsed } = (await model.invoke(messages, { signal })) as {
    raw: { additional_kwargs?: { refusal?: string | null } }
    parsed: unknown
  }
  // 모델이 거절하면 형식 오류와는 다르게 다뤄야 한다. 사용자가 볼 문구가 달라진다.
  // chat completions 경로에서 LangChain은 거절 사유를 버리고 내용만 비워 보낸다.
  // (사유까지 살리려면 Responses API로 옮겨야 한다. 지금은 그만한 이유가 없다.)
  const refusal = raw?.additional_kwargs?.refusal
  if (refusal) throw new RefusedError(refusal)
  if (parsed === null || parsed === undefined) throw new RefusedError('')
  return parsed
}

/** 모델이 답하지 않았다(거절 포함). 형식 오류와 구분한다. */
class RefusedError extends Error {
  override name = 'RefusedError'
}

/**
 * LangChain이 감싸 던진 OpenAI 오류를 사용자 문구로 옮긴다.
 * 상태 코드는 래핑돼도 남아 있어서 그걸 본다.
 */
function mapUpstreamError(error: unknown): Response | undefined {
  const status = (error as { status?: number; response?: { status?: number } })?.status
    ?? (error as { response?: { status?: number } })?.response?.status
  if (status === undefined) return undefined
  console.error('openai error', status, String((error as Error)?.message).slice(0, 300))
  if (status === 401 || status === 403) {
    // 로컬에서 .dev.vars 값을 잘못 넣은 경우가 대부분이다.
    // 원인을 감추면 "AI 서비스 오류"만 보고 한참 헤매게 된다.
    return fail(502, 'bad_key', 'OpenAI API 키가 올바르지 않습니다.')
  }
  if (status === 429) {
    return fail(502, 'upstream_error', 'AI 요청이 몰려 있습니다. 잠시 후 다시 시도해 주세요.')
  }
  return fail(502, 'upstream_error', 'AI 서비스에서 오류가 돌아왔습니다.')
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
function renderUserMessage(payload: EditPlanRequest, template?: StoredTemplate): string {
  const lines = payload.paragraphs.map(
    (paragraph) =>
      `[${paragraph.id} ${paragraphChecksum(paragraph.text)}] (${paragraph.where}) ` +
      JSON.stringify(paragraph.text),
  )
  // 아는 양식이면 어느 문단이 무슨 자리인지 이미 안다. 모델이 그걸 다시 추론하지
  // 않도록 앞에 붙여 준다. 문단 목록 자체는 그대로 싣는다 — "문장 다듬어줘" 같은
  // 요청은 필드 밖 문단도 건드려야 하고, 그 능력을 잃으면 안 된다.
  const known = template
    ? [
        `## 아는 양식: ${template.name} (v${template.version})`,
        '이 문서의 각 자리는 이미 분석돼 있다. 구조를 다시 추론하지 말고 그대로 쓴다.',
        ...template.fields.map((field) => `- ${field.label} → ${field.paragraphId}`),
        '',
      ]
    : []

  return [
    '## 사용자 요청',
    payload.instruction.trim(),
    '',
    ...known,
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
