/**
 * 화면 연결부.
 *
 * 흐름: 파일 열기 → 미리보기 → 자연어 요청 → AI 수정 계획 → 검증 → 적용 →
 * 변경 확인 → 내려받기. 문서 편집기를 만들지 않는다.
 */

import { AiError, collectParagraphs, requestEditPlan, resolveEditPlan } from './ai/client'
import { HwpxError } from './hwpx/package'
import { PatchError } from './hwpx/patch'
import { HwpxDocument } from './hwpx/session'
import { attachLazyImages, type LazyImageController } from './preview/images'
import { escapeHtml, renderDocument } from './preview/render'
import { formatMs, Stopwatch } from './perf'

const $ = <T extends HTMLElement>(id: string): T => {
  const element = document.getElementById(id)
  if (!element) throw new Error(`#${id} 요소를 찾지 못했습니다.`)
  return element as T
}

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

async function runEdit(): Promise<void> {
  if (!doc || inFlight) return
  const instruction = aiInput.value.trim()
  if (!instruction) return

  appendUser(instruction)
  aiInput.value = ''
  setBusy(true)
  const pending = appendPending('문서를 읽고 수정할 부분을 찾는 중…')

  const controller = new AbortController()
  inFlight = controller
  try {
    const paragraphs = collectParagraphs(doc.model)
    const response = await requestEditPlan(instruction, paragraphs, controller.signal)

    if (response.operations.length === 0) {
      pending.replaceWith(note(response.summary || '바꿀 내용을 찾지 못했습니다.', 'ai-note'))
      return
    }

    // 원문(oldText)은 AI 응답이 아니라 방금 보낸 문단 목록에서 채운다.
    const plan = resolveEditPlan(response, paragraphs)
    const applied = doc.apply(plan)
    paintPreview()
    downloadButton.disabled = false
    pending.replaceWith(renderChanges(response.summary, applied))
    highlight(applied.map((change) => change.paragraphId))
  } catch (error) {
    pending.replaceWith(renderFailure(error))
  } finally {
    inFlight = null
    setBusy(false)
  }
}

function renderChanges(
  summary: string,
  changes: readonly { paragraphId: string; oldText: string; newText: string; reason?: string }[],
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
  box.innerHTML =
    `<p class="ai-summary">${escapeHtml(summary)}</p>` +
    `<p class="ai-count">${changes.length}곳을 수정했습니다.</p>` +
    `<ul class="diff">${items}</ul>`
  return box
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
      '<p class="ai-hint-inline">문서는 그대로입니다. 요청을 조금 더 구체적으로 적어 다시 시도해 보세요.</p>'
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
  aiSubmit.textContent = busy ? '생각하는 중…' : '수정 계획 만들기'
}

function resetLog(): void {
  aiLog.innerHTML =
    '<p class="ai-empty">바꾸고 싶은 내용을 문장으로 적어 주세요.<br>' +
    '예) “대상을 중학생으로, 기간을 3개월로 바꿔줘”</p>'
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
