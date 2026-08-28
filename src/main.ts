/**
 * 화면 연결부.
 *
 * 흐름은 하나뿐이다. 파일 선택 → `loadHwpx` → 미리보기 HTML 렌더 → 처리 시간 표시.
 * 서버로 가는 요청은 없다.
 */

import { HwpxError, loadHwpx, type LoadResult } from './hwpx/package'
import { renderDocument } from './preview/render'
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
const fileName = $('file-name')
const fileStats = $('file-stats')
const preview = $('preview')
const loading = $('loading')
const loadingMessage = $('loading-msg')
const debug = $<HTMLDetailsElement>('debug')
const debugBody = $('debug-body')

/** 개발 모드이거나 `?debug=1`이면 처리 시간을 화면에 보여준다. */
const showDebug =
  import.meta.env.DEV || new URLSearchParams(location.search).has('debug')

let current: LoadResult | null = null

async function openFile(file: File): Promise<void> {
  landingError.hidden = true
  showLoading(`${file.name} 여는 중…`)

  const watch = new Stopwatch()
  try {
    const result = await loadHwpx(file, watch)
    const html = renderDocument(result.model)
    watch.lap('미리보기 렌더링 준비')

    preview.innerHTML = html
    preview.scrollTop = 0
    watch.lap('화면 반영')

    current = result
    fileName.textContent = result.meta.fileName
    fileStats.textContent = describe(result)
    landing.hidden = true
    workspace.hidden = false
    renderTimings(watch)
  } catch (error) {
    showError(error)
  } finally {
    hideLoading()
  }
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)}KB`
  return `${(bytes / 1024 / 1024).toFixed(1)}MB`
}

function describe(result: LoadResult): string {
  const { stats } = result.model
  const parts = [
    formatBytes(result.meta.fileSize),
    `문단 ${stats.paragraphCount.toLocaleString('ko-KR')}개`,
  ]
  if (stats.tableCount > 0) parts.push(`표 ${stats.tableCount}개`)
  if (result.model.sections.length > 1) parts.push(`구역 ${result.model.sections.length}개`)
  return parts.join(' · ')
}

function renderTimings(watch: Stopwatch): void {
  if (!showDebug) return
  const { laps, total } = watch.report()
  const rows = laps
    .map(
      (lap) =>
        `<div class="debug-row"><span>${lap.name}</span><b>${formatMs(lap.ms)}</b></div>`,
    )
    .join('')
  const extra = current
    ? `<div class="debug-row debug-row--note"><span>펼친 바이트</span><b>${current.meta.inflatedBytes.toLocaleString('ko-KR')} / ${current.meta.fileSize.toLocaleString('ko-KR')}</b></div>` +
      `<div class="debug-row debug-row--note"><span>분할된 문단</span><b>${current.model.stats.splitParagraphCount} / ${current.model.stats.textParagraphCount}</b></div>`
    : ''
  debugBody.innerHTML =
    rows + `<div class="debug-row debug-row--total"><span>합계</span><b>${formatMs(total)}</b></div>` + extra
  debug.hidden = false
  debug.open = true

  // 개발 중에는 콘솔에서도 바로 보이게 한다.
  console.table([...laps.map((lap) => ({ 단계: lap.name, ms: Number(lap.ms.toFixed(2)) })),
    { 단계: '합계', ms: Number(total.toFixed(2)) }])
}

function showError(error: unknown): void {
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

function pick(input: HTMLInputElement): void {
  input.click()
}

for (const input of [fileInput, fileInputReplace]) {
  input.addEventListener('change', () => {
    const file = input.files?.[0]
    input.value = ''
    if (file) void openFile(file)
  })
}

dropZone.addEventListener('click', () => pick(fileInput))
dropZone.addEventListener('keydown', (event) => {
  if (event.key === 'Enter' || event.key === ' ') {
    event.preventDefault()
    pick(fileInput)
  }
})
$('btn-replace').addEventListener('click', () => pick(fileInputReplace))

for (const type of ['dragenter', 'dragover'] as const) {
  dropZone.addEventListener(type, (event) => {
    event.preventDefault()
    dropZone.classList.add('dropzone--over')
  })
}
for (const type of ['dragleave', 'drop'] as const) {
  dropZone.addEventListener(type, () => dropZone.classList.remove('dropzone--over'))
}

// 페이지 어디에 떨어뜨려도 열리게 한다.
document.addEventListener('dragover', (event) => event.preventDefault())
document.addEventListener('drop', (event) => {
  event.preventDefault()
  const file = event.dataTransfer?.files?.[0]
  if (file) void openFile(file)
})
