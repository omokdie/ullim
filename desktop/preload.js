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
  findLrc: p => ipcRenderer.invoke('find-lrc', p),
  openExternal: url => ipcRenderer.send('open-external', url),
  onCommand: cb => ipcRenderer.on('command', (_e, cmd, arg) => cb(cmd, arg)),
  onOpenFiles: cb => ipcRenderer.on('open-files', (_e, paths) => cb(paths)),
});
