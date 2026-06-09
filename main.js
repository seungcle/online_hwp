import { createEditor } from '@rhwp/editor';
import { authenticate, listHwpFiles, downloadDriveFile } from './google-drive.js';

const landing      = document.getElementById('landing');
const editorWrap   = document.getElementById('editor-wrap');
const editorContainer = document.getElementById('editor-container');
const fileNameEl   = document.getElementById('file-name');
const loadingEl    = document.getElementById('loading');
const loadingMsg   = document.getElementById('loading-msg');
const fileInput    = document.getElementById('file-input');
const fileInputReplace = document.getElementById('file-input-replace');
const btnSave      = document.getElementById('btn-save');
const btnNew       = document.getElementById('btn-new');
const dropZone     = document.getElementById('drop-zone');

let editor = null;
let currentFileName = '';

function showLoading(msg = '불러오는 중...') {
  loadingMsg.textContent = msg;
  loadingEl.hidden = false;
}

function hideLoading() {
  loadingEl.hidden = true;
}

async function initEditor() {
  if (editor) return;
  showLoading('편집기 초기화 중...');
  editor = await createEditor(editorContainer);
  hideLoading();
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

async function newDocument() {
  showLoading('새 문서 만드는 중...');
  try {
    await initEditor();
    // 빈 문서는 파일 없이 에디터만 열기
    currentFileName = '새 문서.hwp';
    fileNameEl.textContent = currentFileName;
    landing.hidden = true;
    editorWrap.hidden = false;
  } catch (err) {
    alert(`오류: ${err.message}`);
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

btnSave.addEventListener('click', saveFile);
btnNew.addEventListener('click', newDocument);

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

// Google Drive
const driveModal    = document.getElementById('drive-modal');
const btnDrive      = document.getElementById('btn-drive');
const btnDriveClose = document.getElementById('btn-drive-close');
const driveFileList = document.getElementById('drive-file-list');

let driveToken = null;

const esc = s => s.replace(/[&<>"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));

btnDrive.addEventListener('click', async () => {
  driveModal.hidden = false;
  driveFileList.innerHTML = '<p class="drive-status">Google 로그인 중...</p>';
  try {
    driveToken = await authenticate();
    driveFileList.innerHTML = '<p class="drive-status">파일 목록 불러오는 중...</p>';
    const files = await listHwpFiles(driveToken);
    if (!files.length) {
      driveFileList.innerHTML = '<p class="drive-status">HWP/HWPX 파일이 없습니다.</p>';
      return;
    }
    driveFileList.innerHTML = files.map(f => `
      <button class="drive-file-item" data-id="${f.id}" data-name="${encodeURIComponent(f.name)}">
        <span class="drive-file-name">${esc(f.name)}</span>
        <span class="drive-file-date">${new Date(f.modifiedTime).toLocaleDateString('ko-KR')}</span>
      </button>
    `).join('');
  } catch (err) {
    driveFileList.innerHTML = `<p class="drive-status drive-error">오류: ${err.message}</p>`;
  }
});

btnDriveClose.addEventListener('click', () => { driveModal.hidden = true; });

driveFileList.addEventListener('click', async (e) => {
  const item = e.target.closest('.drive-file-item');
  if (!item) return;
  const fileId = item.dataset.id;
  const fileName = decodeURIComponent(item.dataset.name);
  driveModal.hidden = true;
  showLoading(`${fileName} 불러오는 중...`);
  try {
    await initEditor();
    const buffer = await downloadDriveFile(fileId, driveToken);
    await editor.loadFile(buffer, fileName);
    currentFileName = fileName;
    fileNameEl.textContent = fileName;
    landing.hidden = true;
    editorWrap.hidden = false;
  } catch (err) {
    alert(`파일 열기 실패: ${err.message}`);
  }
  hideLoading();
});

// 전체 페이지 드래그 앤 드롭 (landing 밖에서도)
document.addEventListener('dragover', (e) => e.preventDefault());
document.addEventListener('drop', (e) => {
  e.preventDefault();
  if (editorWrap.hidden) return; // landing에서는 dropZone이 처리
  const file = e.dataTransfer?.files?.[0];
  if (file && /\.(hwp|hwpx)$/i.test(file.name)) loadFile(file);
});
