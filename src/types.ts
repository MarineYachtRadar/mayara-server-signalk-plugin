import { ServerAPI } from '@signalk/server-api'

interface BinaryStreamManager {
  emitData(streamId: string, data: Buffer): void
}

export interface MayaraServerAPI extends ServerAPI {
  binaryStreamManager?: BinaryStreamManager
}

// =============================================================================
// signalk-container types
// =============================================================================
//
// Previously hand-mirrored here to avoid a compile-time dependency on
// signalk-container (whose prerelease versioning breaks npm semver ranges).
// signalk-container-helper solves that properly: it is a normal dependency
// that re-exports the manager contract, so the mirror is gone and these types
// can no longer drift from the real API.
//
// The `__signalk_containerManager` global is declared by the helper — plugins
// each receive a shallow copy of `app`, so signalk-container publishes its API
// on globalThis instead. Use `getContainerManager()` from index.ts, which adds
// the not-yet-loaded check.

export type {
  ContainerConfig,
  ContainerInfo,
  ContainerManagerApi,
  ContainerResourceLimits,
  ContainerRuntimeInfo,
  ContainerState,
  UpdateCheckResult,
  UpdateRegistration,
  UpdateServiceApi
} from 'signalk-container-helper'
