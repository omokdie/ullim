/*
 * 울림 — 자동 업데이트 (Windows 앱 · 안드로이드 앱)
 * GitHub 저장소의 update/latest.json 에 최신 버전과 설치 파일 주소 · SHA-256 이 적혀 있다 (릴리스를 올린 뒤 갱신).
 *  - Windows: 새 설치 파일을 받아 확인해 두었다가, 앱을 닫을 때 조용히 설치 (또는 '지금 다시 시작')
 *  - Android: 새 APK 를 받아 확인해 두고, [설치]를 누르면 안드로이드 설치 화면이 뜬다
 * 받는 주소는 이 저장소의 GitHub 릴리스로만 제한하고, 파일은 SHA-256 이 맞을 때만 쓴다 (네이티브 쪽에서도 다시 확인).
 */
import { platform } from './platform.js';

export const MANIFEST_URL = 'https://raw.githubusercontent.com/omokdie/ullim/main/update/latest.json';
export const DOWNLOAD_PREFIX = 'https://github.com/omokdie/ullim/releases/download/';

/** a 가 b 보다 새 버전인가 ('1.10.0' > '1.9.3') */
export function isNewer(a, b) {
  const pa = String(a || '').split('.').map(n => parseInt(n, 10) || 0), pb = String(b || '').split('.').map(n => parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length, 3); i++) {
    if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) > (pb[i] || 0);
  }
  return false;
}

const okEntry = e => e && typeof e.url === 'string' && e.url.startsWith(DOWNLOAD_PREFIX)
  && /^[0-9a-f]{64}$/.test(e.sha256 || '') && Number(e.size) > 0 && Number(e.size) < 400e6;

/** 최신 버전 정보 → { version, notes, file } (이 기기에 맞는 설치 파일, 없으면 file: null) */
export async function fetchLatest() {
  if (!platform.httpGet) throw new Error('unsupported');
  const r = await platform.httpGet(`${MANIFEST_URL}?t=${Math.floor(Date.now() / 600000)}`);
  if (!r || r.status !== 200) throw new Error(r && r.status === 0 ? 'offline' : 'http ' + (r && r.status));
  let m;
  try { m = JSON.parse(r.body); } catch (e) { throw new Error('bad manifest'); }
  if (!m || !/^\d+\.\d+\.\d+$/.test(m.version || '')) throw new Error('bad manifest');
  const e = platform.name === 'android' ? m.android : platform.name === 'electron' ? m.windows : null;
  return { version: m.version, notes: String(m.notes || '').slice(0, 600), file: okEntry(e) ? e : null };
}
