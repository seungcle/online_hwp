/**
 * 화면 연결부.
 *
 * 흐름: 파일 열기 → 미리보기 → 자연어 요청 → AI 수정 계획 → 검증 → 적용 →
 * 변경 확인 → 내려받기. 문서 편집기를 만들지 않는다.
 */

import {
  AiError,
  collectParagraphs,
  requestEditPlan,
  resolveEditPlan,
  type SkippedOperation,
} from './ai/client'
import { MAX_HISTORY_TURNS, type ConversationTurn, type EditPlanDebug } from './ai/schema'
import { computeStructure } from './hwpx/fingerprint'
import { HwpxError } from './hwpx/package'
import { PatchError } from './hwpx/patch'
import { HwpxDocument } from './hwpx/session'
import { attachLazyImages, type LazyImageController } from './preview/images'
import { escapeHtml, renderDocument } from './preview/render'
import { formatMs, Stopwatch } from './perf'
import { clearCredential, isLoggedIn, saveCredential } from './auth'

const $ = <T extends HTMLElement>(id: string): T => {
  const element = document.getElementById(id)
  if (!element) throw new Error(`#${id} 요소를 찾지 못했습니다.`)
  return element as T
}

const gate = $('gate')
const gateForm = $<HTMLFormElement>('gate-form')
const gateId = $<HTMLInputElement>('gate-id')
const gatePw = $<HTMLInputElement>('gate-pw')
const gateError = $('gate-error')
const landing = $('landing')
const landingError = $('landing-error')
const workspace = $('workspace')
const dropZone = $('drop-zone')
const fileInput = $<HTMLInputElement>('file-input')
const fileInputReplace = $<HTMLInputElement>('file-input-replace')
const fileNameEl = $('file-name')
const fileStats = $('file-stats')
const preview = $('preview')
const loading = $('loading')
const loadingMessage = $('loading-msg')
const debug = $<HTMLDetailsElement>('debug')
const debugBody = $('debug-body')
const downloadButton = $<HTMLButtonElement>('btn-download')
const aiForm = $<HTMLFormElement>('ai-form')
const aiInput = $<HTMLTextAreaElement>('ai-input')
const aiSubmit = $<HTMLButtonElement>('ai-submit')
const aiCancel = $<HTMLButtonElement>('ai-cancel')
const aiLog = $('ai-log')

const showDebug = import.meta.env.DEV || new URLSearchParams(location.search).has('debug')

let doc: HwpxDocument | null = null
let images: LazyImageController | null = null
let inFlight: AbortController | null = null

// ── 파일 열기 ──────────────────────────────────────────────

async function openFile(file: File): Promise<void> {
  landingError.hidden = true
  showLoading(`${file.name} 여는 중…`)

  const watch = new Stopwatch()
  try {
    const { document: opened } = await HwpxDocument.open(file, watch)
    doc?.dispose()
    doc = opened

    paintPreview(watch)
    fileNameEl.textContent = opened.meta.fileName
    fileStats.textContent = describe(opened)
    landing.hidden = true
    workspace.hidden = false
    downloadButton.disabled = true
    resetLog()
    renderTimings(watch)
  } catch (error) {
    showOpenError(error)
  } finally {
    hideLoading()
  }
}

/** 모델을 화면에 그린다. 이미지는 화면에 들어올 때 채워진다. */
function paintPreview(watch?: Stopwatch): void {
  if (!doc) return
  const html = renderDocument(doc.model)
  watch?.lap('미리보기 렌더링 준비')
  preview.innerHTML = html
  images?.disconnect()
  images = attachLazyImages(preview, (id) => doc!.imageUrl(id))
  watch?.lap('화면 반영')
}

function describe(document: HwpxDocument): string {
  const { stats } = document.model
  const parts = [formatBytes(document.meta.fileSize), `문단 ${stats.paragraphCount.toLocaleString('ko-KR')}개`]
  if (stats.tableCount > 0) parts.push(`표 ${stats.tableCount}개`)
  if (stats.imageCount > 0) parts.push(`이미지 ${stats.imageCount}개`)
  if (document.model.sections.length > 1) parts.push(`구역 ${document.model.sections.length}개`)
  return parts.join(' · ')
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)}KB`
  return `${(bytes / 1024 / 1024).toFixed(1)}MB`
}

// ── AI 수정 ────────────────────────────────────────────────

aiForm.addEventListener('submit', (event) => {
  event.preventDefault()
  void runEdit()
})

aiCancel.addEventListener('click', () => inFlight?.abort())

/**
 * 지난 대화. AI가 되물었을 때 그 답을 이어받으려면 앞 마디를 알아야 한다.
 * 문단 목록은 매번 현재 문서에서 새로 만들고, 여기에는 주고받은 말만 남는다.
 */
let history: ConversationTurn[] = []

function remember(role: ConversationTurn['role'], content: string): void {
  if (!content) return
  history.push({ role, content })
  // 오래된 것부터 버린다. 되물음 한두 번을 잇기에는 넉넉하다.
  if (history.length > MAX_HISTORY_TURNS) history = history.slice(-MAX_HISTORY_TURNS)
}

async function runEdit(): Promise<void> {
  if (!doc || inFlight) return
  const instruction = aiInput.value.trim()
  if (!instruction) return

  appendUser(instruction)
  remember('user', instruction)
  aiInput.value = ''
  setBusy(true)
  const pending = appendPending('문서를 읽고 수정할 부분을 찾는 중…')  // 긴 문서는 1분 넘게 걸리기도 한다

  const controller = new AbortController()
  inFlight = controller
  try {
    // 구조 지문은 문단 목록과 같은 모델에서 한 번에 뽑는다.
    const structure = computeStructure(doc.model)
    const paragraphs = collectParagraphs(doc.model, structure)
    const response = await requestEditPlan(
      instruction,
      paragraphs,
      history,
      structure,
      controller.signal,
    )

    remember('assistant', response.summary)

    if (response.operations.length === 0) {
      pending.replaceWith(note(response.summary || '바꿀 내용을 찾지 못했습니다.', 'ai-note'))
      appendDebug(response.debug)
      return
    }

    // 원문(oldText)은 AI 응답이 아니라 방금 보낸 문단 목록에서 채운다.
    const { plan, skipped } = resolveEditPlan(response, paragraphs)
    if (plan.operations.length === 0) {
      // 전부 원문과 같은 내용이었거나, 확인되지 않아 전부 건너뛴 경우다.
      const message = skipped.length
        ? `${skipped.length}곳이 어느 문단을 가리키는지 확인되지 않아 수정하지 않았습니다. 한 번 더 말해 주시면 다시 해 보겠습니다.`
        : response.summary || '바꿀 내용을 찾지 못했습니다.'
      pending.replaceWith(note(message, 'ai-note'))
      appendDebug(response.debug)
      return
    }
    const applied = doc.apply(plan)
    paintPreview()
    downloadButton.disabled = false
    pending.replaceWith(renderChanges(response.summary, applied, skipped))
    appendDebug(response.debug)
    highlight(applied.map((change) => change.paragraphId))
  } catch (error) {
    if (error instanceof AiError && error.code === 'unauthorized') {
      clearCredential()
      pending.replaceWith(note('로그인이 필요합니다. 다시 로그인해 주세요.', 'ai-msg ai-msg--error'))
      showGate(error.message)
      return
    }
    pending.replaceWith(renderFailure(error))
  } finally {
    inFlight = null
    setBusy(false)
  }
}

function renderChanges(
  summary: string,
  changes: readonly { paragraphId: string; oldText: string; newText: string; reason?: string }[],
  skipped: readonly SkippedOperation[] = [],
): HTMLElement {
  const box = document.createElement('div')
  box.className = 'ai-msg ai-msg--result'
  const items = changes
    .map(
      (change) => `
      <li>
        <div class="diff-old">${escapeHtml(truncate(change.oldText))}</div>
        <div class="diff-new">${escapeHtml(truncate(change.newText))}</div>
        ${change.reason ? `<div class="diff-why">${escapeHtml(change.reason)}</div>` : ''}
      </li>`,
    )
    .join('')
  // 건너뛴 것이 있으면 숨기지 않는다. 몇 곳을 왜 못 고쳤는지 알아야
  // 사용자가 그 부분만 다시 말할 수 있다.
  const note = skipped.length
    ? `<p class="ai-hint-inline">${skipped.length}곳은 어느 문단을 가리키는지 확인되지 않아 그대로 두었습니다.</p>`
    : ''
  box.innerHTML =
    `<p class="ai-summary">${escapeHtml(summary)}</p>` +
    `<p class="ai-count">${changes.length}곳을 수정했습니다.</p>` +
    `<ul class="diff">${items}</ul>` +
    note
  return box
}

/**
 * 알려진 양식 경로가 실제로 도는지 눈으로 확인하는 자리.
 *
 * 사용자용 기능이 아니다. `?debug=1` 로 열었을 때만 나온다. 양식 관리 화면을
 * 먼저 만들 이유는 없지만, hit 인지 miss 인지 보이지 않으면 이 기능이 도는지
 * 알 방법이 없다.
 */
const debugEnabled =
  new URLSearchParams(location.search).has('debug') ||
  localStorage.getItem('rhwp:debug') === '1'

function appendDebug(debug: EditPlanDebug | undefined): void {
  if (!debugEnabled || !debug) return
  const lookup = debug.templateLookup
  const label =
    lookup === 'hit'
      ? `양식 hit — ${debug.templateName ?? '이름 없음'} v${debug.templateVersion} (라벨 ${Math.round((debug.anchorRatio ?? 0) * 100)}%)`
      : lookup === 'stale'
        ? `양식 stale — 재분석 (라벨 ${Math.round((debug.anchorRatio ?? 0) * 100)}%)`
        : lookup === 'miss'
          ? `양식 miss — 새로 분석${debug.templateVersion ? ` → v${debug.templateVersion}` : ''}`
          : `양식 조회 ${lookup}`
  const parts = [
    label,
    `AI 호출 ${debug.aiCalls.length}회 (${debug.aiCalls.join(', ') || '없음'})`,
    debug.structureHash ? `지문 ${debug.structureHash}` : '',
    debug.lookupMs !== undefined ? `조회 ${debug.lookupMs}ms` : '',
    debug.aiMs !== undefined ? `AI ${debug.aiMs}ms` : '',
    debug.totalMs !== undefined ? `합계 ${debug.totalMs}ms` : '',
    debug.fallback ?? '',
  ].filter(Boolean)
  aiLog.append(note(parts.join(' · '), 'ai-msg ai-debug'))
  scrollLog()
}

function renderFailure(error: unknown): HTMLElement {
  if (error instanceof PatchError) {
    const box = document.createElement('div')
    box.className = 'ai-msg ai-msg--error'
    const items = error.issues
      .map(
        (issue) =>
          `<li><b>${escapeHtml(issue.paragraphId)}</b> — ${escapeHtml(issue.message)}` +
          (issue.actualText !== undefined
            ? `<div class="diff-old">현재: ${escapeHtml(truncate(issue.actualText))}</div>`
            : '') +
          '</li>',
      )
      .join('')
    box.innerHTML =
      `<p><b>수정하지 않았습니다.</b> ${escapeHtml(error.message)}</p>` +
      `<ul class="diff">${items}</ul>` +
      '<p class="ai-hint-inline">문서는 그대로입니다. 한 번 더 말해 주시면 다시 해 보겠습니다.</p>'
    return box
  }
  const message =
    error instanceof AiError
      ? error.message
      : error instanceof Error
        ? error.message
        : '알 수 없는 오류가 발생했습니다.'
  return note(message, 'ai-msg ai-msg--error')
}

function truncate(text: string, limit = 220): string {
  return text.length > limit ? `${text.slice(0, limit)}…` : text
}

/** 방금 바뀐 문단을 미리보기에서 잠깐 강조하고 첫 번째로 스크롤한다. */
function highlight(ids: readonly string[]): void {
  let first: HTMLElement | null = null
  for (const id of ids) {
    const element = preview.querySelector<HTMLElement>(`[data-id="${CSS.escape(id)}"]`)
    if (!element) continue
    element.classList.add('pv-p--changed')
    first ??= element
  }
  first?.scrollIntoView({ behavior: 'smooth', block: 'center' })
}

function setBusy(busy: boolean): void {
  aiSubmit.disabled = busy
  aiInput.disabled = busy
  aiCancel.hidden = !busy
  aiSubmit.textContent = busy ? '생각하는 중…' : '수정하기'
}

function resetLog(): void {
  // 새 문서를 열면 지난 대화도 버린다. 다른 문서 이야기를 이어받으면 안 된다.
  history = []
  aiLog.innerHTML =
    '<p class="ai-empty">평소 말하듯 적어 주세요. 문서는 알아서 읽습니다.<br>' +
    '예) “좀 더 읽기 쉽게 해줘”, “대상을 중학생으로 바꿔줘”</p>'
}

function appendUser(text: string): void {
  aiLog.querySelector('.ai-empty')?.remove()
  aiLog.append(note(text, 'ai-msg ai-msg--user'))
  scrollLog()
}

function appendPending(text: string): HTMLElement {
  const element = note(text, 'ai-msg ai-msg--pending')
  aiLog.append(element)
  scrollLog()
  return element
}

function note(text: string, className: string): HTMLElement {
  const element = document.createElement('div')
  element.className = className
  element.textContent = text
  return element
}

function scrollLog(): void {
  aiLog.scrollTop = aiLog.scrollHeight
}

// ── 내려받기 ───────────────────────────────────────────────

downloadButton.addEventListener('click', () => void download())

async function download(): Promise<void> {
  if (!doc || doc.pristine) return
  showLoading('수정본 만드는 중…')
  try {
    const bytes = await doc.toBytes()
    const url = URL.createObjectURL(
      new Blob([bytes as BlobPart], { type: 'application/hwp+zip' }),
    )
    const anchor = document.createElement('a')
    anchor.href = url
    anchor.download = doc.meta.fileName.replace(/\.hwpx$/i, '') + ' (수정).hwpx'
    anchor.click()
    // 곧바로 revoke하면 브라우저가 내려받기를 시작하기 전에 URL이 사라질 수 있다.
    setTimeout(() => URL.revokeObjectURL(url), 60_000)
  } catch (error) {
    aiLog.append(renderFailure(error))
    scrollLog()
  } finally {
    hideLoading()
  }
}

// ── 공통 ──────────────────────────────────────────────────

function renderTimings(watch: Stopwatch): void {
  if (!showDebug) return
  const { laps, total } = watch.report()
  const rows = laps
    .map((lap) => `<div class="debug-row"><span>${lap.name}</span><b>${formatMs(lap.ms)}</b></div>`)
    .join('')
  const extra = doc
    ? `<div class="debug-row debug-row--note"><span>펼친 바이트</span><b>${doc.meta.inflatedBytes.toLocaleString('ko-KR')} / ${doc.meta.fileSize.toLocaleString('ko-KR')}</b></div>` +
      `<div class="debug-row debug-row--note"><span>분할된 문단</span><b>${doc.model.stats.splitParagraphCount} / ${doc.model.stats.textParagraphCount}</b></div>`
    : ''
  debugBody.innerHTML =
    rows +
    `<div class="debug-row debug-row--total"><span>합계</span><b>${formatMs(total)}</b></div>` +
    extra
  debug.hidden = false
  debug.open = true
  console.table([
    ...laps.map((lap) => ({ 단계: lap.name, ms: Number(lap.ms.toFixed(2)) })),
    { 단계: '합계', ms: Number(total.toFixed(2)) },
  ])
}

function showOpenError(error: unknown): void {
  const message =
    error instanceof HwpxError
      ? error.message
      : error instanceof Error
        ? `파일을 열지 못했습니다: ${error.message}`
        : '파일을 열지 못했습니다.'
  landingError.textContent = message
  landingError.hidden = false
  landing.hidden = false
  workspace.hidden = true
  console.error(error)
}

function showLoading(message: string): void {
  loadingMessage.textContent = message
  loading.hidden = false
}

function hideLoading(): void {
  loading.hidden = true
}

// ── 로그인 ────────────────────────────────────────────────
//
// 서버가 실제로 막는다(`backend/index.ts`). 이 화면은 자격증명을 받아 두는
// 자리일 뿐이고, 여기를 지나쳐도 AI 호출은 서버에서 거절된다.

function showGate(message?: string): void {
  gate.hidden = false
  landing.hidden = true
  workspace.hidden = true
  if (message) {
    gateError.textContent = message
    gateError.hidden = false
  } else {
    gateError.hidden = true
  }
}

function hideGate(): void {
  gate.hidden = true
  landing.hidden = false
}

gateForm.addEventListener('submit', (event) => {
  event.preventDefault()
  const id = gateId.value.trim()
  const password = gatePw.value
  if (!id || !password) return
  saveCredential(id, password)
  gatePw.value = ''
  hideGate()
})

if (isLoggedIn()) hideGate()
else showGate()

for (const input of [fileInput, fileInputReplace]) {
  input.addEventListener('change', () => {
    const file = input.files?.[0]
    input.value = ''
    if (file) void openFile(file)
  })
}

dropZone.addEventListener('click', () => fileInput.click())
dropZone.addEventListener('keydown', (event) => {
  if (event.key === 'Enter' || event.key === ' ') {
    event.preventDefault()
    fileInput.click()
  }
})
$('btn-replace').addEventListener('click', () => fileInputReplace.click())

for (const type of ['dragenter', 'dragover'] as const) {
  dropZone.addEventListener(type, (event) => {
    event.preventDefault()
    dropZone.classList.add('dropzone--over')
  })
}
for (const type of ['dragleave', 'drop'] as const) {
  dropZone.addEventListener(type, () => dropZone.classList.remove('dropzone--over'))
}

document.addEventListener('dragover', (event) => event.preventDefault())
document.addEventListener('drop', (event) => {
  event.preventDefault()
  const file = event.dataTransfer?.files?.[0]
  if (file) void openFile(file)
})

// Ctrl/Cmd+Enter로 전송.
aiInput.addEventListener('keydown', (event) => {
  if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
    event.preventDefault()
    aiForm.requestSubmit()
  }
})
