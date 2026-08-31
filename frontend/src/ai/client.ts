/**
 * 브라우저 → Worker 호출.
 *
 * HWPX 파일은 보내지 않는다. 문단 id와 텍스트, 그리고 그 문단이 본문인지
 * 표 안인지 정도의 최소 힌트만 보낸다.
 */

import { usableHeight, type Block, type DocumentModel, type TableCell } from '../hwpx/document'
import { computeStructure, type DocumentStructure } from '../hwpx/fingerprint'
import { analyzeTable, estimateTableHeight, walkTables } from '../hwpx/layout'
import type { EditPlan, PatchIssue } from '../hwpx/patch'
import {
  SchemaError,
  paragraphChecksum,
  parseEditPlanResponse,
  validateRequest,
  type ConversationTurn,
  type DocumentParagraph,
  type EditPlanResponse,
} from './schema'

export class AiError extends Error {
  override name = 'AiError'
  constructor(
    message: string,
    readonly code: string,
  ) {
    super(message)
  }
}

/**
 * AI에 보낼 문단 목록.
 *
 * **빈 칸도 싣는다.** 채울 자리가 있는 빈 문단(`emptySlot`)은 양식의 값 칸이고,
 * 이 서비스가 다루는 문서의 상당수가 그런 칸을 비워 둔 양식이다. 예전에는 빈
 * 문단을 통째로 빼고 보냈는데, 그러면 "팀 명을 세종팀으로 바꿔줘"를 받은 AI가
 * 고를 수 있는 문단이 라벨밖에 없어서 **라벨 "팀 명"을 값으로 덮어썼다**(실측).
 * 값 칸이 목록에 있어야 AI가 옳은 자리를 고를 수 있다.
 *
 * 위치 힌트에는 표 번호와 **같은 행 첫 칸의 글자**를 붙인다. 양식은 대개
 * `라벨 | 값` 꼴이라, 이 한 줄이 "이 빈 칸은 무엇을 적는 자리인가"를 알려 준다.
 *
 * 문단마다 논리 경로를 함께 싣는다. 알려진 양식을 다시 알아볼 때 id만으로는
 * 부족하기 때문이다 — 문단이 하나 늘면 뒤쪽 id가 통째로 밀린다.
 */
export function collectParagraphs(
  model: DocumentModel,
  structure: DocumentStructure = computeStructure(model),
): DocumentParagraph[] {
  const out: DocumentParagraph[] = []
  const state = { tableOrdinal: 0, tight: tightCells(model) }
  for (const section of model.sections) {
    walk(section.blocks, '본문', out, structure, state)
  }
  return out
}

/**
 * 늘려 쓰면 안 되는 칸.
 *
 * 한글은 **세로로 병합된 칸이나 다른 표 안에 든 표**를 페이지 경계에서 쪼개지
 * 못한다. 그런 표가 한 페이지를 넘기면 잘린다. 우리가 속성으로 풀 수 있는
 * 걸림돌(개체 취급, 표 단위 넘김)은 내려받기 직전에 알아서 푸는데
 * (`layout.ts`), 구조가 막는 것은 풀 수 없다.
 *
 * 그래서 그런 표는 **애초에 넘치지 않게** 하는 편이 낫다. 이미 페이지의 상당
 * 부분을 쓰고 있는 표라면 AI에게 "이 칸은 짧게 쓰라"고 알려 준다. 실측한
 * 문서에서는 표 28개 중 9개가 여기 해당했다.
 */
function tightCells(model: DocumentModel): Set<string> {
  const out = new Set<string>()
  walkTables(model, (table, nested, section) => {
    const limit = usableHeight(section.page)
    if (limit <= 0) return
    const verdict = analyzeTable(table, nested)
    if (verdict.blocked.length === 0) return
    // 지금 높이만으로도 페이지의 3분의 2를 넘게 쓰고 있으면 여유가 없다.
    const now = estimateTableHeight(table, () => undefined)
    if (now < limit * 0.66) return
    for (const row of table.rows) {
      for (const cell of row) {
        for (const block of cell.blocks) {
          if (block.kind === 'paragraph') out.add(block.id)
        }
      }
    }
  })
  return out
}

/** 표 셀에서 처음 나오는 글자. 같은 행의 라벨을 찾는 데 쓴다. */
function firstText(cell: TableCell | undefined): string {
  for (const block of cell?.blocks ?? []) {
    if (block.kind === 'paragraph' && block.text.trim().length > 0) return block.text.trim()
  }
  return ''
}

function walk(
  blocks: readonly Block[],
  where: string,
  out: DocumentParagraph[],
  structure: DocumentStructure,
  state: { tableOrdinal: number; tight: Set<string> },
): void {
  for (const block of blocks) {
    if (block.kind === 'paragraph') {
      // 글자가 있거나, 글자를 넣을 자리가 있는 빈 칸이면 대상이 된다.
      if (block.text.trim().length > 0 || block.emptySlot) {
        const marks =
          (block.text.length === 0 ? ' · 빈 칸' : '') +
          (state.tight.has(block.id) ? ' · 짧게 쓸 것' : '')
        out.push({
          id: block.id,
          text: block.text,
          where: `${where}${marks}`,
          path: structure.paths.get(block.id) ?? '',
        })
      }
      continue
    }
    if (block.kind === 'table') {
      const ordinal = (state.tableOrdinal += 1)
      block.rows.forEach((row, rowIndex) => {
        const label = firstText(row[0])
        row.forEach((cell, columnIndex) => {
          const hint =
            columnIndex > 0 && label ? ` · 이 행 첫 칸 "${clip(label)}"` : ''
          walk(
            cell.blocks,
            `표${ordinal} ${rowIndex + 1}행${columnIndex + 1}열${hint}`,
            out,
            structure,
            state,
          )
        })
      })
    }
  }
}

function clip(text: string, limit = 24): string {
  return text.length > limit ? `${text.slice(0, limit)}…` : text
}

export async function requestEditPlan(
  instruction: string,
  paragraphs: readonly DocumentParagraph[],
  history: readonly ConversationTurn[] = [],
  structure?: DocumentStructure,
  signal?: AbortSignal,
): Promise<EditPlanResponse> {
  const payload = {
    instruction,
    paragraphs,
    ...(history.length ? { history } : {}),
    // 뼈대만 보낸다. 경로별 텍스트는 위 문단 목록에 이미 들어 있다.
    ...(structure
      ? {
          structure: {
            structureHash: structure.structureHash,
            skeleton: structure.skeleton,
            paragraphCount: structure.paragraphCount,
            tableCount: structure.tableCount,
            imageCount: structure.imageCount,
          },
        }
      : {}),
  }
  try {
    validateRequest(payload)
  } catch (error) {
    throw new AiError(
      error instanceof SchemaError ? error.message : '요청을 만들지 못했습니다.',
      'bad_request',
    )
  }

  let response: Response
  try {
    response = await fetch('/api/edit-plan', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
      ...(signal ? { signal } : {}),
    })
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') {
      throw new AiError('요청을 취소했습니다.', 'aborted')
    }
    throw new AiError('AI 서버에 연결하지 못했습니다. 네트워크를 확인해 주세요.', 'network')
  }

  if (!response.ok) {
    const detail = await readError(response)
    throw new AiError(detail.message, detail.code)
  }

  try {
    // Worker가 이미 검증했지만 여기서 다시 본다. 응답을 그대로 믿지 않는다.
    return parseEditPlanResponse(await response.json())
  } catch (error) {
    throw new AiError(
      error instanceof SchemaError ? error.message : 'AI 응답을 이해하지 못했습니다.',
      'invalid_plan',
    )
  }
}

/** 적용하지 않고 넘어간 수정 한 건. 왜 넘어갔는지 사용자에게 보여 준다. */
export interface SkippedOperation {
  readonly paragraphId: string
  readonly kind: PatchIssue['kind']
  readonly message: string
  /** AI가 넣으려던 글. 사용자가 직접 다시 말할 때 참고가 된다. */
  readonly newText: string
}

export interface ResolvedPlan {
  readonly plan: EditPlan
  /** 확인되지 않아 건너뛴 수정. 비어 있으면 전부 적용된 것이다. */
  readonly skipped: readonly SkippedOperation[]
  /** 검증코드로 대상을 다시 찾아낸 건수. */
  readonly recovered: number
}

/**
 * AI 응답을 patch engine이 받을 수 있는 Edit Plan으로 바꾼다.
 *
 * `oldText`는 **AI가 준 값을 쓰지 않고** 방금 AI에게 보낸 `paragraphs`에서
 * 그대로 꺼낸다. 그래서 patch engine의 바이트 단위 대조는 "우리가 보여 준
 * 문단이 지금도 그대로인가"를 확인하게 된다. 모델이 공백을 옮겨 적는 솜씨는
 * 상관이 없다.
 *
 * "AI가 다른 문단을 보고 이 id를 적은 것은 아닌가"는 검증코드로 확인한다.
 * 여기서 **한 건이 어긋나도 나머지는 살린다.** 예전에는 계획 전체를 버렸는데,
 * 실측하면 개별 수정의 오류율은 0.3%인데도 넓은 요청(20~50건)에서는 10%가
 * 통째로 실패했다. 멀쩡히 확인된 47건이 어긋난 2건 때문에 함께 버려졌다.
 *
 * 어긋난 건을 버리는 것은 안전하다. 각 수정은 자기 문단의 검증코드로 **따로**
 * 확인되고, 확인되지 않은 건은 문서에 닿지 않는다. 반대로 전부 버리는 것은
 * 안전을 더해 주지 않고 사용자의 작업만 없앤다.
 *
 * (문서 자체가 바뀌었을 때 계획 전체를 버리는 규칙은 그대로다. 그건 여기가
 * 아니라 `patch.ts`의 `validatePlan`이 본다. 그 경우엔 모든 수정이 낡은
 * 문서를 보고 세워진 것이라 한 건도 믿을 수 없다.)
 *
 * 버리기 전에 한 번 되살려 본다. 단 **id가 문서에 아예 없을 때만** 그렇게 한다.
 * 그때는 id가 틀렸다는 것이 확실하므로, 검증코드가 딱 한 문단만 가리키면 그
 * 문단이 본뜻이다. 여러 문단이 같은 코드를 가지면 고르지 않는다.
 *
 * 반대로 **id는 있는데 검증코드가 어긋나면 되살리지 않는다.** 둘 중 어느 쪽이
 * 틀렸는지 알 수 없기 때문이다. 모델이 문단은 제대로 고르고 코드만 잘못 옮겨
 * 적었을 수도 있는데, 그때 코드를 믿고 대상을 옮기면 엉뚱한 문단을 고치게 된다.
 * 확신이 없으면 건드리지 않는다 — 이 검증이 원래 막으려던 것이 그것이다.
 */
export function resolveEditPlan(
  response: EditPlanResponse,
  paragraphs: readonly DocumentParagraph[],
): ResolvedPlan {
  const sent = new Map(paragraphs.map((paragraph) => [paragraph.id, paragraph.text]))

  // 검증코드 → 그 코드를 가진 문단들. 하나뿐일 때만 대상을 되살리는 데 쓴다.
  const byChecksum = new Map<string, string[]>()
  for (const paragraph of paragraphs) {
    const code = paragraphChecksum(paragraph.text)
    byChecksum.set(code, [...(byChecksum.get(code) ?? []), paragraph.id])
  }

  const skipped: SkippedOperation[] = []
  let recovered = 0

  /** 이 수정이 실제로 어느 문단을 가리키는가. 확인되지 않으면 undefined. */
  const locate = (operation: EditPlanResponse['operations'][number]): string | undefined => {
    const text = sent.get(operation.paragraphId)
    if (text !== undefined) {
      if (paragraphChecksum(text) === operation.checksum) return operation.paragraphId
      // id는 있는데 내용이 어긋난다. 어느 쪽이 틀렸는지 알 수 없으니 고르지 않는다.
      skipped.push({
        paragraphId: operation.paragraphId,
        kind: 'checksum-mismatch',
        message: 'AI가 짚은 문단과 실제로 보고 있던 내용이 어긋나 건너뛰었습니다.',
        newText: operation.newText,
      })
      return undefined
    }
    // id가 문서에 아예 없다. id가 틀린 것은 확실하므로 검증코드로 되살려 본다.
    const candidates = byChecksum.get(operation.checksum) ?? []
    if (candidates.length === 1) {
      recovered += 1
      return candidates[0]
    }
    skipped.push({
      paragraphId: operation.paragraphId,
      kind: 'unknown-target',
      message: `문서에 없는 문단을 가리켰습니다: ${operation.paragraphId}`,
      newText: operation.newText,
    })
    return undefined
  }

  // 대상을 먼저 확정하고 나서 문단별로 모은다. 되살리면서 id가 바뀔 수 있다.
  const grouped = new Map<string, { newText: string; reason?: string }[]>()
  for (const operation of response.operations) {
    const id = locate(operation)
    if (id === undefined) continue
    const text = sent.get(id)!
    grouped.set(id, [
      ...(grouped.get(id) ?? []),
      {
        newText: keepOuterSpacing(text, operation.newText),
        ...(operation.reason ? { reason: operation.reason } : {}),
      },
    ])
  }

  const operations: EditPlan['operations'][number][] = []
  for (const [id, candidates] of grouped) {
    const text = sent.get(id)!
    // 같은 문단을 두 번 고치라고 하면서 내용이 다르면 어느 쪽이 본뜻인지 알 수
    // 없다. 그 문단만 건너뛴다. 내용이 같으면 그냥 한 번만 적용한다.
    const distinct = [...new Set(candidates.map((candidate) => candidate.newText))]
    if (distinct.length > 1) {
      skipped.push({
        paragraphId: id,
        kind: 'duplicate-target',
        message: '같은 문단을 서로 다르게 고치라고 해서 건너뛰었습니다.',
        newText: distinct[0]!,
      })
      continue
    }
    const newText = distinct[0]!
    // 모델은 고칠 것이 없는 문단도 계획에 넣곤 한다. 글자가 같다면 손대지 않는다.
    // 내용이 같아도 적용하면 문단의 텍스트 조각이 하나로 합쳐지는데, 형광펜처럼
    // 조각 사이에 끼어 있던 서식이 그때 사라진다. 안 바꾸는 것이 맞다.
    if (newText === text) continue

    const reason = candidates.find((candidate) => candidate.reason)?.reason
    operations.push({
      type: 'replace_text',
      paragraphId: id,
      oldText: text,
      newText,
      ...(reason ? { reason } : {}),
    })
  }

  return { plan: { operations, summary: response.summary }, skipped, recovered }
}

/**
 * 문단 앞뒤의 공백을 원문 그대로 되돌린다.
 *
 * 한글 문서는 들여쓰기를 문단 앞 공백으로 넣는 일이 흔하다(실측 27%).
 * 모델은 문장을 다듬으면서 이 공백을 군더더기로 보고 지운다. 프롬프트로
 * 부탁해도 지운다 — 실제로 gpt-4.1-mini는 들여쓰기 있는 문단 6개 전부에서
 * 앞 공백을 떨어뜨렸다. 그러면 검증은 통과하는데 문서 모양이 조용히 바뀐다.
 *
 * 그래서 부탁하지 않고 기계적으로 되돌린다. 모델이 맡는 것은 문장이고,
 * 들여쓰기는 레이아웃에 가깝다. 이 도구는 레이아웃을 건드리지 않는다.
 * (제로폭 공백은 `trim`의 대상이 아니므로 내용으로 취급되어 그대로 남는다.)
 */
function keepOuterSpacing(original: string, replacement: string): string {
  const body = replacement.trim()
  if (body.length === 0 || original.trim().length === 0) return replacement
  const lead = original.slice(0, original.length - original.trimStart().length)
  const trail = original.slice(original.trimEnd().length)
  return `${lead}${body}${trail}`
}

async function readError(response: Response): Promise<{ code: string; message: string }> {
  try {
    const body = (await response.json()) as { error?: { code?: string; message?: string } }
    if (body.error?.message) {
      return { code: body.error.code ?? 'error', message: body.error.message }
    }
  } catch {
    // 본문이 JSON이 아니면 상태 코드로 안내한다.
  }
  if (response.status === 404) {
    return {
      code: 'not_deployed',
      message:
        'AI 기능이 이 환경에서 실행되고 있지 않습니다. (개발 중이라면 wrangler dev를 함께 띄워 주세요.)',
    }
  }
  return { code: 'error', message: `AI 요청이 실패했습니다 (HTTP ${response.status}).` }
}
