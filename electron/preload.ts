import { contextBridge, ipcRenderer, webUtils } from 'electron'

function sub(channel: string, cb: (data: unknown) => void): () => void {
  const handler = (_e: unknown, data: unknown) => cb(data)
  ipcRenderer.on(channel, handler)
  return () => {
    ipcRenderer.removeListener(channel, handler)
  }
}

const api = {
  probe: (p: string) => ipcRenderer.invoke('video:probe', p),
  startRender: (params: unknown) => ipcRenderer.invoke('render:start', params),
  cancelRender: () => ipcRenderer.invoke('render:cancel'),
  pickVideo: () => ipcRenderer.invoke('dialog:open-video'),
  pickOutput: (defaultPath: string) => ipcRenderer.invoke('dialog:save-output', defaultPath),
  showInFolder: (p: string) => ipcRenderer.invoke('shell:show-in-folder', p),
  getMeta: () => ipcRenderer.invoke('app:meta'),
  checkNvenc: () => ipcRenderer.invoke('nvenc:check'),
  pathForFile: (file: File): string => {
    try {
      return webUtils.getPathForFile(file)
    } catch {
      return ''
    }
  },
  onProgress: (cb: (d: unknown) => void) => sub('render:progress', cb),
  onRetry: (cb: (d: unknown) => void) => sub('render:retry', cb),
  onNotice: (cb: (d: unknown) => void) => sub('render:notice', cb),
  onDone: (cb: (d: unknown) => void) => sub('render:done', cb),
  onError: (cb: (d: unknown) => void) => sub('render:error', cb),
  onCancelled: (cb: () => void) => sub('render:cancelled', cb)
}

contextBridge.exposeInMainWorld('api', api)
