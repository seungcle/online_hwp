import { createEditor } from '@rhwp/editor';

const landing      = document.getElementById('landing');
const editorWrap   = document.getElementById('editor-wrap');
const editorContainer = document.getElementById('editor-container');
const fileNameEl   = document.getElementById('file-name');
const loadingEl    = document.getElementById('loading');
const loadingMsg   = document.getElementById('loading-msg');
const fileInput    = document.getElementById('file-input');
const fileInputReplace = document.getElementById('file-input-replace');
const btnSave      = document.getElementById('btn-save');
const btnPdf       = document.getElementById('btn-pdf');
const dropZone     = document.getElementById('drop-zone');
const mainNav      = document.getElementById('main-nav');
const landingFooter = document.querySelector('.landing-footer');
const landingInfo  = document.getElementById('landing-info');

let editor = null;
let editorPromise = null;
let currentFileName = '';

function showLoading(msg = '불러오는 중...') {
  loadingMsg.textContent = msg;
  loadingEl.hidden = false;
}

function hideLoading() {
  loadingEl.hidden = true;
}

function warmupEditor() {
  if (editor || editorPromise) return;
  editorPromise = createEditor(editorContainer);
  editorPromise.catch(() => { editorPromise = null; });
}

async function initEditor() {
  if (editor) return;
  showLoading('편집기 초기화 중...');
  if (!editorPromise) editorPromise = createEditor(editorContainer);
  editor = await editorPromise;
}

async function loadFile(file) {
  showLoading(`${file.name} 불러오는 중...`);
  try {
    await initEditor();
    const buffer = await file.arrayBuffer();
    await editor.loadFile(buffer, file.name);
    currentFileName = file.name;
    fileNameEl.textContent = file.name;
    landing.hidden = true;
    mainNav.hidden = true;
    landingFooter.hidden = true;
    landingInfo.hidden = true;
    editorWrap.hidden = false;
  } catch (err) {
    hideLoading();
    alert(`파일 열기 실패: ${err.message}`);
    return;
  }
  hideLoading();
}

async function saveFile() {
  if (!editor) return;
  showLoading('저장 중...');
  try {
    const bytes = await editor.exportHwp();
    const blob = new Blob([bytes], { type: 'application/x-hwp' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = currentFileName.replace(/\.hwpx$/i, '.hwp') || 'document.hwp';
    a.click();
    URL.revokeObjectURL(url);
  } catch (err) {
    alert(`저장 실패: ${err.message}`);
  }
  hideLoading();
}

// 파일 입력 이벤트
fileInput.addEventListener('change', (e) => {
  const file = e.target.files?.[0];
  if (file) loadFile(file);
  e.target.value = '';
});

fileInputReplace.addEventListener('change', (e) => {
  const file = e.target.files?.[0];
  if (file) loadFile(file);
  e.target.value = '';
});

async function exportPdf() {
  if (!editor) return;
  const win = window.open('', '_blank');
  if (!win) {
    alert('팝업이 차단되었습니다. 브라우저 주소창의 팝업 허용 버튼을 클릭 후 다시 시도해주세요.');
    return;
  }
  showLoading('PDF 생성 중...');
  try {
    const count = await editor.pageCount();
    const svgs = [];
    for (let i = 0; i < count; i++) {
      svgs.push(await editor.getPageSvg(i));
    }
    hideLoading();
    win.document.write(
      '<!DOCTYPE html><html><head><style>' +
      '*{margin:0;padding:0;box-sizing:border-box}' +
      'body{background:white}' +
      '.page{page-break-after:always}' +
      '.page:last-child{page-break-after:avoid}' +
      'svg{display:block;width:100%;height:auto}' +
      '</style></head><body>' +
      svgs.map(svg => `<div class="page">${svg}</div>`).join('') +
      '<scr' + 'ipt>window.onload=function(){window.print()}<\/scr' + 'ipt>' +
      '</body></html>'
    );
    win.document.close();
  } catch (err) {
    hideLoading();
    win.close();
    alert(`PDF 내보내기 실패: ${err.message}`);
  }
}

btnSave.addEventListener('click', saveFile);
btnPdf.addEventListener('click', exportPdf);

// 페이지 로드 후 idle 시 WASM 워밍업 — 첫 방문은 서비스 워커가 캐시, 이후 방문은 캐시에서 로드
if ('requestIdleCallback' in window) {
  requestIdleCallback(warmupEditor, { timeout: 3000 });
} else {
  setTimeout(warmupEditor, 1000);
}

// 드래그 앤 드롭
['dragenter', 'dragover'].forEach(ev =>
  dropZone.addEventListener(ev, (e) => { e.preventDefault(); dropZone.classList.add('drag-over'); })
);
['dragleave', 'drop'].forEach(ev =>
  dropZone.addEventListener(ev, (e) => { e.preventDefault(); dropZone.classList.remove('drag-over'); })
);
dropZone.addEventListener('drop', (e) => {
  const file = e.dataTransfer?.files?.[0];
  if (file && /\.(hwp|hwpx)$/i.test(file.name)) loadFile(file);
  else if (file) alert('.hwp 또는 .hwpx 파일만 지원합니다.');
});

// 전체 페이지 드래그 앤 드롭 (landing 밖에서도)
document.addEventListener('dragover', (e) => e.preventDefault());
document.addEventListener('drop', (e) => {
  e.preventDefault();
  if (editorWrap.hidden) return;
  const file = e.dataTransfer?.files?.[0];
  if (file && /\.(hwp|hwpx)$/i.test(file.name)) loadFile(file);
});
