// Electron: 플레이리스트 M3U 내보내기 · 가져오기 (대화상자 대신 ULLIM_PLAYLIST_TEST_DIR 폴더 사용)
const { _electron: electron } = require('playwright');
const fs = require('fs');
(async () => {
  const dir = process.argv[4] || '/tmp/pltest';
  const app = await electron.launch({ executablePath: process.argv[2], args: [process.argv[3], '--no-sandbox'],
    env: { ...process.env, ELECTRON_DISABLE_SECURITY_WARNINGS: '1', ULLIM_PLAYLIST_TEST_DIR: dir } });
  const win = await app.firstWindow();
  await win.waitForFunction(() => window.__ullim && window.__ullim.engine, null, { timeout: 15000 });
  const media = '/home/claude/ullim/test/media/';
  const r = await win.evaluate(async media => {
    const U = __ullim;
    const p = await U.createPlaylist({ name: '내보낼 목록', show: true });
    U.addItems(['song_euckr.mp3', 'song.flac'].map(f => ({ key: media + f, name: f })));
    await new Promise(res => setTimeout(res, 1500));
    const saved = await window.ullimNative.savePlaylist(p.name, U.toM3U(p));
    const before = U.pls.map(x => x.name);
    await U.importPlaylists();
    await new Promise(res => setTimeout(res, 1200));
    return { saved, before, after: U.pls.map(x => `${x.name}:${x.tracks.map(t => t.title || t.name).join('/')}`), shown: U.shown.name };
  }, media);
  r.file = fs.readFileSync(r.saved, 'utf8');
  console.log(JSON.stringify(r, null, 1));
  await app.close();
})().catch(e => { console.error('FAIL', e); process.exit(1); });
