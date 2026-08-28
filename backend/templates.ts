/**
 * 알려진 양식의 조회·판정·저장.
 *
 * 흐름은 세 걸음이다.
 *
 * 1. **조회** — 구조 해시로 후보를 뽑는다. 값이 달라도 뼈대가 같으면 같은 해시다.
 * 2. **판정** — 후보의 라벨이 지금 문서에도 그대로 있는지 대조한다. 뼈대만으로는
 *    무관한 문서가 우연히 겹칠 수 있어서, 여기까지 통과해야 hit로 본다.
 * 3. **저장** — miss였으면 AI가 새로 분석한 결과를 다음 version으로 남긴다.
 *
 * 판정을 통과하지 못하면 **자동으로 고치지 않는다.** 알려진 양식 경로를 접고
 * AI 재분석으로 되돌아간다. 잘못된 지도로 문서를 조용히 건드리는 것보다
 * 한 번 더 묻는 편이 낫다.
 */

import type {
  StoredTemplate,
  TemplateAnchor,
  TemplateDefinition,
} from '../frontend/src/ai/template'
import { ANCHOR_MATCH_RATIO } from '../frontend/src/ai/template'

/** 조회에 쓰는, 지금 올라온 문서의 모습. 본문 전체가 아니라 문단 목록이다. */
export interface IncomingStructure {
  readonly structureHash: string
  readonly skeleton: string
  readonly paragraphs: readonly { id: string; text: string; path: string }[]
}

export type MatchOutcome =
  | { readonly kind: 'hit'; readonly template: StoredTemplate; readonly anchorRatio: number }
  | { readonly kind: 'miss' }
  /** 해시는 맞는데 라벨이 어긋났다. 양식이 개정됐거나 남남이다. */
  | {
      readonly kind: 'stale'
      readonly template: StoredTemplate
      readonly anchorRatio: number
      readonly brokenAnchors: readonly string[]
    }

/**
 * 후보들 중 지금 문서와 맞는 것을 고른다. 최신 version부터 본다.
 *
 * 라벨을 문단 id와 논리 경로 **양쪽으로** 찾는다. 한글에서 다시 저장하면
 * 문단이 하나 늘거나 줄어 id 순번이 밀릴 수 있는데, 그때도 경로가 같으면
 * 같은 자리로 본다. 두 방법 모두 실패하면 그 라벨은 깨진 것으로 센다.
 */
export function matchTemplate(
  candidates: readonly StoredTemplate[],
  incoming: IncomingStructure,
): MatchOutcome {
  if (candidates.length === 0) return { kind: 'miss' }

  const byId = new Map(incoming.paragraphs.map((p) => [p.id, p]))
  const byPath = new Map(incoming.paragraphs.map((p) => [p.path, p]))
  let best: { template: StoredTemplate; ratio: number; broken: string[] } | undefined

  for (const template of [...candidates].sort((a, b) => b.version - a.version)) {
    const broken: string[] = []
    let found = 0
    for (const anchor of template.anchors) {
      if (anchorHolds(anchor, byId, byPath)) found += 1
      else broken.push(anchor.paragraphId)
    }
    // 라벨이 하나도 없는 양식은 대조할 방법이 없다. 뼈대가 정말 같을 때만 인정한다.
    const ratio = template.anchors.length === 0
      ? (template.skeleton === incoming.skeleton ? 1 : 0)
      : found / template.anchors.length

    if (ratio >= ANCHOR_MATCH_RATIO && fieldsStillThere(template, byId, byPath)) {
      return { kind: 'hit', template, anchorRatio: ratio }
    }
    if (!best || ratio > best.ratio) best = { template, ratio, broken }
  }

  const fallback = best!
  return {
    kind: 'stale',
    template: fallback.template,
    anchorRatio: fallback.ratio,
    brokenAnchors: fallback.broken,
  }
}

function anchorHolds(
  anchor: TemplateAnchor,
  byId: Map<string, { text: string }>,
  byPath: Map<string, { text: string }>,
): boolean {
  const here = byId.get(anchor.paragraphId) ?? byPath.get(anchor.path)
  return here !== undefined && here.text === anchor.text
}

/** 필드 자리가 아직 문서에 있는지. 내용은 보지 않는다 — 값은 달라지는 게 정상이다. */
function fieldsStillThere(
  template: StoredTemplate,
  byId: Map<string, unknown>,
  byPath: Map<string, unknown>,
): boolean {
  return template.fields.every(
    (field) => byId.has(field.paragraphId) || byPath.has(field.path),
  )
}

/**
 * 저장된 양식의 필드를 지금 문서의 문단에 다시 붙인다.
 *
 * patch 직전에 한 번 더 확인하는 자리이기도 하다. 붙지 않는 필드가 있으면
 * 그 사실을 그대로 돌려준다. 호출한 쪽이 알려진 양식 경로를 접을 수 있어야 한다.
 */
export function bindFields(
  template: StoredTemplate,
  incoming: IncomingStructure,
): {
  bound: { key: string; label: string; paragraphId: string; text: string; changed: boolean }[]
  unbound: string[]
} {
  const byId = new Map(incoming.paragraphs.map((p) => [p.id, p]))
  const byPath = new Map(incoming.paragraphs.map((p) => [p.path, p]))
  const bound: {
    key: string
    label: string
    paragraphId: string
    text: string
    changed: boolean
  }[] = []
  const unbound: string[] = []

  for (const field of template.fields) {
    const here = byId.get(field.paragraphId) ?? byPath.get(field.path)
    if (!here) {
      unbound.push(field.key)
      continue
    }
    bound.push({
      key: field.key,
      label: field.label,
      paragraphId: here.id,
      text: here.text,
      // 분석 당시 값과 다른가. 내용은 저장하지 않았으므로 해시로만 안다.
      changed: false,
    })
  }
  return { bound, unbound }
}

// ── D1 ──────────────────────────────────────────────────────

/**
 * D1에서 실제로 쓰는 부분만 좁게 선언한다.
 *
 * `@cloudflare/workers-types`를 통째로 끌어오면 Request/Response 같은 전역이
 * DOM 타입과 부딪힌다. 이 저장소는 프론트와 백엔드를 한 tsconfig로 함께 본다.
 * 좁게 선언하면 충돌도 없고, 테스트에서 무엇을 흉내 내야 하는지도 분명해진다.
 */
export interface D1Database {
  prepare(query: string): D1PreparedStatement
}
export interface D1PreparedStatement {
  bind(...values: unknown[]): D1PreparedStatement
  all<T>(): Promise<{ results?: T[] }>
  run(): Promise<unknown>
}

export interface TemplateStore {
  findByStructure(structureHash: string): Promise<StoredTemplate[]>
  save(
    structureHash: string,
    skeleton: string,
    counts: { paragraphs: number; tables: number; images: number },
    definition: TemplateDefinition,
    version: number,
  ): Promise<StoredTemplate>
}

interface TemplateRow {
  id: string
  structure_hash: string
  version: number
  name: string
  skeleton: string
  fields_json: string
  anchors_json: string
}

export class D1TemplateStore implements TemplateStore {
  constructor(private readonly db: D1Database) {}

  async findByStructure(structureHash: string): Promise<StoredTemplate[]> {
    const result = await this.db
      .prepare(
        'SELECT id, structure_hash, version, name, skeleton, fields_json, anchors_json' +
          ' FROM templates WHERE structure_hash = ?1 ORDER BY version DESC LIMIT 10',
      )
      .bind(structureHash)
      .all<TemplateRow>()
    return (result.results ?? []).map(toStored)
  }

  async save(
    structureHash: string,
    skeleton: string,
    counts: { paragraphs: number; tables: number; images: number },
    definition: TemplateDefinition,
    version: number,
  ): Promise<StoredTemplate> {
    const id = `tpl_${structureHash}_v${version}`
    const now = new Date().toISOString()
    await this.db
      .prepare(
        'INSERT INTO templates (id, structure_hash, version, name, skeleton,' +
          ' paragraph_count, table_count, image_count, fields_json, anchors_json,' +
          ' created_at, updated_at)' +
          ' VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?11)' +
          ' ON CONFLICT (structure_hash, version) DO UPDATE SET' +
          ' name = excluded.name, fields_json = excluded.fields_json,' +
          ' anchors_json = excluded.anchors_json, updated_at = excluded.updated_at',
      )
      .bind(
        id,
        structureHash,
        version,
        definition.name,
        skeleton,
        counts.paragraphs,
        counts.tables,
        counts.images,
        JSON.stringify(definition.fields),
        JSON.stringify(definition.anchors),
        now,
      )
      .run()
    return { ...definition, id, structureHash, version, skeleton }
  }
}

function toStored(row: TemplateRow): StoredTemplate {
  return {
    id: row.id,
    structureHash: row.structure_hash,
    version: row.version,
    name: row.name,
    skeleton: row.skeleton,
    fields: JSON.parse(row.fields_json),
    anchors: JSON.parse(row.anchors_json),
  }
}

/** 다음에 저장할 version. 같은 뼈대의 개정판은 세대를 올려 남긴다. */
export function nextVersion(candidates: readonly StoredTemplate[]): number {
  return candidates.reduce((most, template) => Math.max(most, template.version), 0) + 1
}
