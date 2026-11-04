'use strict';
const { contextBridge, ipcRenderer, webUtils } = require('electron');

contextBridge.exposeInMainWorld('ullimNative', {
  pickFiles: () => ipcRenderer.invoke('pick-files'),
  pickFolder: () => ipcRenderer.invoke('pick-folder'),
  scanMusic: () => ipcRenderer.invoke('scan-music'),
  expandPaths: paths => ipcRenderer.invoke('expand-paths', paths),
  startupFiles: () => ipcRenderer.invoke('startup-files'),
  pathForFile: file => { try { return webUtils.getPathForFile(file); } catch (e) { return ''; } },
  nowPlaying: info => ipcRenderer.send('now-playing', info),
  httpGet: url => ipcRenderer.invoke('http-get', url),
  httpPost: (url, body) => ipcRenderer.invoke('http-post', url, body),
  savePlaylist: (name, text) => ipcRenderer.invoke('save-playlist', name, text),
  openPlaylists: () => ipcRenderer.invoke('open-playlists'),
  findLrc: p => ipcRenderer.invoke('find-lrc', p),
  openExternal: url => ipcRenderer.send('open-external', url),
  openSoundSettings: () => ipcRenderer.send('open-sound-settings'),
  updateSupported: (() => { try { return !!ipcRenderer.sendSync('update-supported'); } catch (e) { return false; } })(),
  updateDownload: (url, sha256, size, version) => ipcRenderer.invoke('update-download', url, sha256, size, version),
  updateDiscard: () => ipcRenderer.invoke('update-discard'),
  updateRestart: () => ipcRenderer.send('update-restart'),
  setTheme: (bg, light) => ipcRenderer.send('set-theme', String(bg || ''), !!light),
  trimMemory: () => ipcRenderer.send('trim-memory'),
  onCommand: cb => ipcRenderer.on('command', (_e, cmd, arg) => cb(cmd, arg)),
  onOpenFiles: cb => ipcRenderer.on('open-files', (_e, paths) => cb(paths)),
});
