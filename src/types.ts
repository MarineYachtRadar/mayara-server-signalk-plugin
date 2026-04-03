import { ServerAPI } from '@signalk/server-api'

interface BinaryStreamManager {
  emitData(streamId: string, data: Buffer): void
}

export interface MayaraServerAPI extends ServerAPI {
  binaryStreamManager?: BinaryStreamManager
}

export interface PluginSettings {
  host: string
  port: number
  secure: boolean
  discoveryPollInterval: number
  reconnectInterval: number
}
