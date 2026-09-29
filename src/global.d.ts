import type { DonePayload, MetaInfo, NvencLevel, ProbeResponse, ProgressData, RenderParams, StartResult } from './types'

declare global {
  interface Window {
    api: {
      probe(p: string): Promise<ProbeResponse>
      startRender(p: RenderParams): Promise<StartResult>
      cancelRender(): Promise<{ ok: boolean }>
      pickVideo(): Promise<string[]>
      pickOutput(defaultPath: string): Promise<string | null>
      showInFolder(p: string): Promise<void>
      getMeta(): Promise<MetaInfo>
      checkNvenc(): Promise<NvencLevel>
      pathForFile(f: File): string
      onProgress(cb: (d: ProgressData) => void): () => void
      onRetry(cb: (d: { reason: string; encoderLabel?: string }) => void): () => void
      onNotice(cb: (d: { message: string }) => void): () => void
      onDone(cb: (d: DonePayload) => void): () => void
      onError(cb: (d: { message: string; log?: string }) => void): () => void
      onCancelled(cb: () => void): () => void
    }
  }
}

export {}
