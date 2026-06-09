const CLIENT_ID = import.meta.env.VITE_GOOGLE_CLIENT_ID;

let tokenClient = null;
let accessToken = null;

function loadGIS() {
  return new Promise((resolve) => {
    if (window.google?.accounts) return resolve();
    const s = document.createElement('script');
    s.src = 'https://accounts.google.com/gsi/client';
    s.onload = resolve;
    document.head.appendChild(s);
  });
}

export async function authenticate() {
  await loadGIS();
  return new Promise((resolve, reject) => {
    if (!tokenClient) {
      tokenClient = google.accounts.oauth2.initTokenClient({
        client_id: CLIENT_ID,
        scope: 'https://www.googleapis.com/auth/drive.readonly',
        callback: () => {},
      });
    }
    tokenClient.callback = (res) => {
      if (res.error) return reject(new Error(res.error));
      accessToken = res.access_token;
      resolve(accessToken);
    };
    tokenClient.requestAccessToken({ prompt: accessToken ? '' : 'consent' });
  });
}

export async function listHwpFiles(token) {
  const q = encodeURIComponent("name contains '.hwp' and trashed = false");
  const fields = encodeURIComponent('files(id,name,modifiedTime)');
  const res = await fetch(
    `https://www.googleapis.com/drive/v3/files?q=${q}&fields=${fields}&pageSize=50&orderBy=modifiedTime+desc`,
    { headers: { Authorization: `Bearer ${token}` } }
  );
  if (!res.ok) throw new Error('파일 목록을 가져오지 못했습니다.');
  const { files } = await res.json();
  return files || [];
}

export async function downloadDriveFile(fileId, token) {
  const res = await fetch(
    `https://www.googleapis.com/drive/v3/files/${fileId}?alt=media`,
    { headers: { Authorization: `Bearer ${token}` } }
  );
  if (!res.ok) throw new Error('파일을 다운로드하지 못했습니다.');
  return res.arrayBuffer();
}
