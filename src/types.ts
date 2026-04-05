import { ServerAPI } from '@signalk/server-api'

interface BinaryStreamManager {
  emitData(streamId: string, data: Buffer): void
}

export interface MayaraServerAPI extends ServerAPI {
  binaryStreamManager?: BinaryStreamManager
}

export interface ContainerManagerApi {
  getRuntime: () => { runtime: string; version: string } | null
  ensureRunning: (name: string, config: unknown) => Promise<void>
  stop: (name: string) => Promise<void>
  remove: (name: string) => Promise<void>
  getState: (name: string) => Promise<'running' | 'stopped' | 'missing' | 'no-runtime'>
  pullImage: (image: string, onProgress?: (msg: string) => void) => Promise<void>
  imageExists: (image: string) => Promise<boolean>
  listContainers: () => Promise<{ name: string; image: string; state: string }[]>
}
