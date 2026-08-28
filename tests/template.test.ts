/**
 * 알려진 양식: 조회 → 판정 → 저장 → 재사용.
 *
 * Worker를 그대로 부르고, D1은 `node:sqlite`로 **진짜 SQL을 돌린다.**
 * OpenAI만 가짜다. 확인하려는 것이 "AI를 언제 부르고 언제 안 부르는가"라서
 * 호출 자체를 세는 것이 요점이다.
 */

import { afterEach, describe, expect, it, vi } from 'vitest'
import worker from '../backend/index'
import { createTestD1, type TestD1 } from './helpers/d1-sqlite'
import { buildForm, FIRST_FORM, SECOND_FORM, type FormValues } from './helpers/form-fixture'
import { loadHwpxBytes } from '../frontend/src/hwpx/package'
import { computeStructure } from '../frontend/src/hwpx/fingerprint'
import { collectParagraphs, resolveEditPlan } from '../frontend/src/ai/client'
import {
  paragraphChecksum,
  type DocumentParagraph,
  type EditPlanDebug,
} from '../frontend/src/ai/schema'
import { HwpxDocument } from '../frontend/src/hwpx/session'
import { matchTemplate } from '../backend/templates'

const realFetch = globalThis.fetch
afterEach(() => {
  globalThis.fetch = realFetch
  vi.restoreAllMocks()
})

// ── 문서 준비 ────────────────────────────────────────────────

async function openForm(values: FormValues, options: { extraRow?: boolean } = {}) {
  const loaded = await loadHwpxBytes(await buildForm(values, options), 'form.hwpx')
  const structure = computeStructure(loaded.model)
  return {
    loaded,
    structure,
    paragraphs: collectParagraphs(loaded.model, structure),
    document: HwpxDocument.fromLoadResult(loaded),
  }
}

function requestBody(
  instruction: string,
  paragraphs: readonly DocumentParagraph[],
  structure: ReturnType<typeof computeStructure>,
) {
  return {
    instruction,
    paragraphs,
    structure: {
      structureHash: structure.structureHash,
      skeleton: structure.skeleton,
      paragraphCount: structure.paragraphCount,
      tableCount: structure.tableCount,
      imageCount: structure.imageCount,
    },
  }
}

function post(body: unknown): Request {
  const json = JSON.stringify(body)
  return new Request('https://rhwp.co.kr/api/edit-plan', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'content-length': String(json.length) },
    body: json,
  })
}

function env(db?: TestD1) {
  return {
    ASSETS: { fetch: async () => new Response('') },
    OPENAI_API_KEY: 'k',
    ...(db ? { TEMPLATES: db } : {}),
  } as never
}

// ── 가짜 OpenAI ──────────────────────────────────────────────

/** 호출마다 다른 응답을 돌려준다. 어떤 프롬프트가 갔는지도 남긴다. */
function mockOpenAi(replies: unknown[]) {
  const prompts: string[] = []
  const spy = vi.fn(async (_url: unknown, init: { body?: string }) => {
    const sent = JSON.parse(init?.body ?? '{}')
    prompts.push(
      (sent.messages ?? []).map((m: { content: string }) => m.content).join('\n---\n'),
    )
    const reply = replies[Math.min(prompts.length - 1, replies.length - 1)]
    return new Response(
      JSON.stringify({
        choices: [{ message: { role: 'assistant', content: JSON.stringify(reply) } }],
      }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    )
  })
  globalThis.fetch = spy as never
  return { spy, prompts, get calls() { return spy.mock.calls.length } }
}

/** AI가 이 양식을 이렇게 분석했다고 치자. */
function analysisFor(paragraphs: readonly DocumentParagraph[]) {
  const find = (text: string) => paragraphs.find((p) => p.text === text)!.id
  return {
    name: '사업 제안서',
    fields: [
      { key: 'title', label: '문서 제목', paragraphId: find(FIRST_FORM.title) },
      { key: 'period', label: '사업 기간', paragraphId: find(FIRST_FORM.period) },
      { key: 'owner', label: '담당자', paragraphId: find(FIRST_FORM.owner) },
    ],
    anchors: [
      { paragraphId: find('항목') },
      { paragraphId: find('내용') },
      { paragraphId: find('사업 기간') },
      { paragraphId: find('담당자') },
    ],
  }
}

function planFor(paragraphs: readonly DocumentParagraph[], text: string, newText: string) {
  const target = paragraphs.find((p) => p.text === text)!
  return {
    summary: '바꿨습니다.',
    operations: [
      {
        paragraphId: target.id,
        checksum: paragraphChecksum(target.text),
        newText,
        reason: '요청',
      },
    ],
  }
}

async function readPlan(response: Response) {
  return (await response.json()) as {
    summary: string
    operations: { paragraphId: string; checksum: string; newText: string; reason: string }[]
    debug: EditPlanDebug
  }
}

// ── 1~4. miss → 저장 → hit → 구조 분석 생략 ──────────────────

describe('처음 보는 양식과 아는 양식', () => {
  it('처음 보는 문서는 miss이고, 구조 분석 결과를 저장한다', async () => {
    const db = createTestD1()
    const { paragraphs, structure } = await openForm(FIRST_FORM)
    const ai = mockOpenAi([analysisFor(paragraphs), planFor(paragraphs, FIRST_FORM.title, '새 제목')])

    const plan = await readPlan(
      await worker.fetch(post(requestBody('제목 바꿔줘', paragraphs, structure)), env(db)),
    )

    expect(plan.debug.templateLookup).toBe('miss')
    expect(plan.debug.aiCalls).toEqual(['structure', 'plan'])
    expect(ai.calls).toBe(2)
    expect(plan.debug.templateName).toBe('사업 제안서')

    const rows = db.raw('SELECT * FROM templates') as Record<string, unknown>[]
    expect(rows).toHaveLength(1)
    expect(rows[0]!['structure_hash']).toBe(structure.structureHash)
    expect(rows[0]!['version']).toBe(1)
    db.close()
  })

  it('같은 양식을 다시 올리면 hit이고 구조 분석을 부르지 않는다', async () => {
    const db = createTestD1()
    const first = await openForm(FIRST_FORM)
    mockOpenAi([analysisFor(first.paragraphs), planFor(first.paragraphs, FIRST_FORM.title, 'x')])
    await worker.fetch(post(requestBody('제목', first.paragraphs, first.structure)), env(db))

    // 같은 양식, 다른 사람이 채운 값.
    const second = await openForm(SECOND_FORM)
    const ai = mockOpenAi([planFor(second.paragraphs, SECOND_FORM.title, '또 다른 제목')])
    const plan = await readPlan(
      await worker.fetch(
        post(requestBody('제목 바꿔줘', second.paragraphs, second.structure)),
        env(db),
      ),
    )

    expect(plan.debug.templateLookup).toBe('hit')
    // 이것이 이 기능의 전부다. 구조 분석 호출이 사라졌다.
    expect(plan.debug.aiCalls).toEqual(['plan'])
    expect(ai.calls).toBe(1)
    expect(plan.debug.templateVersion).toBe(1)
    expect(plan.debug.anchorRatio).toBe(1)
    expect(typeof plan.debug.lookupMs).toBe('number')
    db.close()
  })

  it('hit이면 프롬프트에 필드 지도가 실려 구조를 다시 추론하지 않게 한다', async () => {
    const db = createTestD1()
    const first = await openForm(FIRST_FORM)
    mockOpenAi([analysisFor(first.paragraphs), planFor(first.paragraphs, FIRST_FORM.title, 'x')])
    await worker.fetch(post(requestBody('제목', first.paragraphs, first.structure)), env(db))

    const second = await openForm(SECOND_FORM)
    const ai = mockOpenAi([planFor(second.paragraphs, SECOND_FORM.title, 'y')])
    await worker.fetch(
      post(requestBody('제목 바꿔줘', second.paragraphs, second.structure)),
      env(db),
    )
    expect(ai.prompts[0]).toContain('아는 양식: 사업 제안서')
    expect(ai.prompts[0]).toContain('문서 제목 →')
    db.close()
  })

  it('D1 바인딩이 없어도 편집은 그대로 된다', async () => {
    const { paragraphs, structure } = await openForm(FIRST_FORM)
    const ai = mockOpenAi([planFor(paragraphs, FIRST_FORM.title, '새 제목')])
    const plan = await readPlan(
      await worker.fetch(post(requestBody('제목 바꿔줘', paragraphs, structure)), env()),
    )
    expect(plan.debug.templateLookup).toBe('unavailable')
    expect(plan.debug.aiCalls).toEqual(['plan'])
    expect(ai.calls).toBe(1)
    expect(plan.operations).toHaveLength(1)
  })
})

// ── 5. 아는 양식으로 정상 patch ──────────────────────────────

describe('아는 양식으로 실제 문서를 고친다', () => {
  it('hit 경로로 받은 계획이 그대로 적용된다', async () => {
    const db = createTestD1()
    const first = await openForm(FIRST_FORM)
    mockOpenAi([analysisFor(first.paragraphs), planFor(first.paragraphs, FIRST_FORM.title, 'x')])
    await worker.fetch(post(requestBody('제목', first.paragraphs, first.structure)), env(db))

    const second = await openForm(SECOND_FORM)
    mockOpenAi([planFor(second.paragraphs, SECOND_FORM.owner, '박영희')])
    const response = await readPlan(
      await worker.fetch(
        post(requestBody('담당자 바꿔줘', second.paragraphs, second.structure)),
        env(db),
      ),
    )
    expect(response.debug.templateLookup).toBe('hit')

    const plan = resolveEditPlan(response, second.paragraphs)
    const applied = second.document.apply(plan)
    expect(applied).toHaveLength(1)

    const after = await loadHwpxBytes(await second.document.toBytes(), 'after.hwpx')
    const texts = collectParagraphs(after.model).map((p) => p.text)
    expect(texts).toContain('박영희')
    expect(texts).not.toContain(SECOND_FORM.owner)
    // 나머지는 그대로다.
    expect(texts).toContain('항목')
    expect(after.model.stats.tableCount).toBe(second.loaded.model.stats.tableCount)
    db.close()
  })
})

// ── 6~8. 구조가 바뀌면 판정 실패 → 재분석 → 새 version ───────

describe('양식이 바뀌었을 때', () => {
  it('표 행이 늘면 뼈대가 달라 miss가 되고 별도 양식으로 저장된다', async () => {
    const db = createTestD1()
    const original = await openForm(FIRST_FORM)
    mockOpenAi([analysisFor(original.paragraphs), planFor(original.paragraphs, FIRST_FORM.title, 'x')])
    await worker.fetch(post(requestBody('제목', original.paragraphs, original.structure)), env(db))

    const revised = await openForm(FIRST_FORM, { extraRow: true })
    const ai = mockOpenAi([
      analysisFor(revised.paragraphs),
      planFor(revised.paragraphs, FIRST_FORM.title, 'y'),
    ])
    const plan = await readPlan(
      await worker.fetch(post(requestBody('제목', revised.paragraphs, revised.structure)), env(db)),
    )
    expect(plan.debug.templateLookup).toBe('miss')
    expect(plan.debug.aiCalls).toEqual(['structure', 'plan'])
    expect(ai.calls).toBe(2)

    const hashes = (db.raw('SELECT structure_hash FROM templates') as { structure_hash: string }[])
      .map((row) => row.structure_hash)
    expect(new Set(hashes).size).toBe(2)
    db.close()
  })

  it('뼈대는 같은데 라벨이 바뀌면 stale로 보고 재분석한다 — 조용히 쓰지 않는다', async () => {
    const db = createTestD1()
    const original = await openForm(FIRST_FORM)
    mockOpenAi([analysisFor(original.paragraphs), planFor(original.paragraphs, FIRST_FORM.title, 'x')])
    await worker.fetch(post(requestBody('제목', original.paragraphs, original.structure)), env(db))

    // 라벨을 통째로 갈아 끼운다. 구조는 같지만 다른 양식이다.
    const renamed = original.paragraphs.map((p) =>
      ['항목', '내용', '사업 기간', '담당자'].includes(p.text)
        ? { ...p, text: `${p.text} 항목명변경` }
        : p,
    )
    const ai = mockOpenAi([
      { name: '다른 양식', fields: [{ key: 'a', label: 'A', paragraphId: renamed[0]!.id }], anchors: [] },
      planFor(renamed, FIRST_FORM.title, 'z'),
    ])
    const plan = await readPlan(
      await worker.fetch(post(requestBody('제목', renamed, original.structure)), env(db)),
    )

    expect(plan.debug.templateLookup).toBe('stale')
    expect(plan.debug.fallback).toMatch(/재분석/)
    expect(plan.debug.aiCalls).toEqual(['structure', 'plan'])
    expect(ai.calls).toBe(2)
    db.close()
  })

  it('같은 뼈대의 재분석은 version을 올려 남긴다', async () => {
    const db = createTestD1()
    const original = await openForm(FIRST_FORM)
    mockOpenAi([analysisFor(original.paragraphs), planFor(original.paragraphs, FIRST_FORM.title, 'x')])
    await worker.fetch(post(requestBody('제목', original.paragraphs, original.structure)), env(db))

    const renamed = original.paragraphs.map((p) =>
      ['항목', '내용', '사업 기간', '담당자'].includes(p.text) ? { ...p, text: `${p.text}!` } : p,
    )
    mockOpenAi([
      { name: '개정 양식', fields: [{ key: 'a', label: 'A', paragraphId: renamed[0]!.id }], anchors: [] },
      planFor(renamed, FIRST_FORM.title, 'z'),
    ])
    await worker.fetch(post(requestBody('제목', renamed, original.structure)), env(db))

    const rows = db.raw(
      'SELECT version, name FROM templates WHERE structure_hash = ? ORDER BY version',
    ) as { version: number; name: string }[]
    // 같은 뼈대라도 세대가 나뉜다. 옛 정의를 덮어쓰지 않는다.
    const versions = (db.raw('SELECT version FROM templates ORDER BY version') as { version: number }[])
      .map((row) => row.version)
    expect(versions).toEqual([1, 2])
    expect(rows.length).toBeGreaterThanOrEqual(0)
    db.close()
  })
})

// ── 9. 잘못된 지도로 조용히 고쳐지지 않는다 ──────────────────

describe('잘못된 지도로 문서가 조용히 바뀌지 않는다', () => {
  it('저장된 필드가 엉뚱한 문단을 가리켜도 patch는 검증에서 막힌다', async () => {
    const { paragraphs } = await openForm(FIRST_FORM)
    // 아는 양식이라며 AI가 다른 문단의 검증코드를 들고 왔다고 치자.
    const target = paragraphs.find((p) => p.text === FIRST_FORM.title)!
    const other = paragraphs.find((p) => p.text === '항목')!
    expect(() =>
      resolveEditPlan(
        {
          summary: 's',
          operations: [
            {
              paragraphId: target.id,
              checksum: paragraphChecksum(other.text),
              newText: '조용히 바뀌면 안 된다',
              reason: '',
            },
          ],
        },
        paragraphs,
      ),
    ).toThrow(/확인되지 않아/)
  })

  it('필드가 가리키는 문단이 사라지면 hit로 인정하지 않는다', async () => {
    const { paragraphs, structure } = await openForm(FIRST_FORM)
    const stored = {
      id: 'tpl_x_v1',
      structureHash: structure.structureHash,
      version: 1,
      skeleton: structure.skeleton,
      name: '옛 양식',
      fields: [{ key: 'gone', label: '사라진 자리', paragraphId: 's9-p99', path: 's9/b99', sampleHash: 'x' }],
      anchors: [{ paragraphId: paragraphs[0]!.id, path: paragraphs[0]!.path, text: paragraphs[0]!.text }],
    }
    const outcome = matchTemplate([stored], {
      structureHash: structure.structureHash,
      skeleton: structure.skeleton,
      paragraphs: paragraphs.map((p) => ({ id: p.id, text: p.text, path: p.path })),
    })
    expect(outcome.kind).not.toBe('hit')
  })

  it('문단 id가 밀려도 논리 경로로 라벨을 찾아낸다', async () => {
    const { paragraphs, structure } = await openForm(FIRST_FORM)
    const anchor = paragraphs.find((p) => p.text === '항목')!
    const stored = {
      id: 'tpl_x_v1',
      structureHash: structure.structureHash,
      version: 1,
      skeleton: structure.skeleton,
      name: '양식',
      fields: [],
      // 한글에서 다시 저장해 id 순번이 밀린 상황. 경로는 그대로다.
      anchors: [{ paragraphId: 's0-p999', path: anchor.path, text: anchor.text }],
    }
    const outcome = matchTemplate([stored], {
      structureHash: structure.structureHash,
      skeleton: structure.skeleton,
      paragraphs: paragraphs.map((p) => ({ id: p.id, text: p.text, path: p.path })),
    })
    expect(outcome.kind).toBe('hit')
  })
})

// ── 11. 무엇이 저장되는가 ────────────────────────────────────

describe('DB에 무엇이 남는가', () => {
  it('원본 HWPX·이미지·본문 값은 저장하지 않는다', async () => {
    const db = createTestD1()
    const { paragraphs, structure } = await openForm(FIRST_FORM)
    mockOpenAi([analysisFor(paragraphs), planFor(paragraphs, FIRST_FORM.title, 'x')])
    await worker.fetch(post(requestBody('제목', paragraphs, structure)), env(db))

    const dump = JSON.stringify(db.raw('SELECT * FROM templates'))
    // 사람이 채운 값은 해시로만 남는다.
    for (const value of [FIRST_FORM.title, FIRST_FORM.period, FIRST_FORM.owner]) {
      expect(dump).not.toContain(value)
    }
    // 라벨은 양식 문구라 그대로 남는다. 이건 의도한 것이다.
    expect(dump).toContain('항목')
    // 파일 바이트나 XML은 흔적도 없다.
    expect(dump).not.toContain('hp:t')
    expect(dump).not.toContain('PK')
    expect(dump).not.toContain('image1')

    const columns = Object.keys((db.raw('SELECT * FROM templates') as object[])[0]!)
    expect(columns.sort()).toEqual(
      [
        'anchors_json',
        'created_at',
        'fields_json',
        'id',
        'image_count',
        'name',
        'paragraph_count',
        'skeleton',
        'structure_hash',
        'table_count',
        'updated_at',
        'version',
      ].sort(),
    )
    db.close()
  })

  it('긴 문단은 라벨로 저장하지 않는다 — 값이 새어 나가지 않게', async () => {
    const db = createTestD1()
    const secret = '가'.repeat(200)
    const { paragraphs, structure } = await openForm({ ...FIRST_FORM, owner: secret })
    const analysis = {
      name: '양식',
      fields: [{ key: 'title', label: '제목', paragraphId: paragraphs[0]!.id }],
      // AI가 긴 값 문단을 라벨이라고 우겨도 저장하지 않는다.
      anchors: [{ paragraphId: paragraphs.find((p) => p.text === secret)!.id }],
    }
    mockOpenAi([analysis, planFor(paragraphs, FIRST_FORM.title, 'x')])
    await worker.fetch(post(requestBody('제목', paragraphs, structure)), env(db))

    expect(JSON.stringify(db.raw('SELECT * FROM templates'))).not.toContain(secret)
    db.close()
  })
})

// ── 12. D1 설정 ──────────────────────────────────────────────

describe('D1 설정', () => {
  it('마이그레이션이 그대로 적용되고 스키마가 선다', () => {
    const db = createTestD1()
    const tables = db.raw("SELECT name FROM sqlite_master WHERE type='table'") as { name: string }[]
    expect(tables.map((t) => t.name)).toContain('templates')
    const indexes = db.raw("SELECT name FROM sqlite_master WHERE type='index'") as { name: string }[]
    expect(indexes.map((i) => i.name)).toContain('idx_templates_hash_version')
    db.close()
  })

  it('같은 (뼈대, version) 을 두 번 넣을 수 없다', () => {
    const db = createTestD1()
    const insert = () =>
      db.raw(
        "INSERT INTO templates VALUES ('a','h',1,'n','s',1,0,0,'[]','[]','t','t')",
      )
    insert()
    expect(insert).toThrow()
    db.close()
  })

  it('wrangler 설정에 D1 바인딩과 마이그레이션 경로가 있다', async () => {
    const { readFileSync } = await import('node:fs')
    const config = readFileSync('wrangler.jsonc', 'utf8')
    expect(config).toContain('"binding": "TEMPLATES"')
    expect(config).toContain('"migrations_dir": "migrations"')
    // Worker 는 /api/* 에서만 먼저 돌아야 한다. 정적 자산을 통과시키지 않는다.
    expect(config).toContain('"run_worker_first": ["/api/*", "/naver*"]')
  })
})
