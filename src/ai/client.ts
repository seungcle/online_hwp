/**
 * 브라우저 → Worker 호출.
 *
 * HWPX 파일은 보내지 않는다. 문단 id와 텍스트, 그리고 그 문단이 본문인지
 * 표 안인지 정도의 최소 힌트만 보낸다.
 */

import type { Block, DocumentModel } from '../hwpx/document'
import {
  SchemaError,
  parseEditPlanResponse,
  validateRequest,
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

/** AI에 보낼 문단 목록. 빈 문단은 바꿀 수 없으므로 제외한다. */
export function collectParagraphs(model: DocumentModel): DocumentParagraph[] {
  const out: DocumentParagraph[] = []
  for (const section of model.sections) {
    walk(section.blocks, '본문', out)
  }
  return out
}

function walk(blocks: readonly Block[], where: string, out: DocumentParagraph[]): void {
  for (const block of blocks) {
    if (block.kind === 'paragraph') {
      if (block.text.trim().length > 0) {
        out.push({ id: block.id, text: block.text, where })
      }
      continue
    }
    if (block.kind === 'table') {
      block.rows.forEach((row, rowIndex) => {
        row.forEach((cell, columnIndex) => {
          walk(cell.blocks, `표 ${rowIndex + 1}행 ${columnIndex + 1}열`, out)
        })
      })
    }
  }
}

export async function requestEditPlan(
  instruction: string,
  paragraphs: readonly DocumentParagraph[],
  signal?: AbortSignal,
): Promise<EditPlanResponse> {
  const payload = { instruction, paragraphs }
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
