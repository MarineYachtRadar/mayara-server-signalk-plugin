import { ServerAPI } from '@signalk/server-api'

interface BinaryStreamManager {
  emitData(streamId: string, data: Buffer): void
}

export interface MayaraServerAPI extends ServerAPI {
  binaryStreamManager?: BinaryStreamManager
}

// =============================================================================
// signalk-container v1.6.0 API mirror
// =============================================================================
//
// These types are intentionally hand-rolled rather than imported from the
// signalk-container package, to keep mayara loosely coupled (only a runtime
// `peerDependencies` declaration, no compile-time import).
//
// The source of truth lives in the signalk-container repository at:
//   https://github.com/dirkwa/signalk-container
//   - src/types.ts            — top-level container manager interfaces
//   - src/updates/types.ts    — update detection service
//
// When signalk-container's API changes, mirror the relevant subset here. Only
// the methods mayara actually uses need to be declared.
//
// Last synced against signalk-container: v1.6.0

export type ContainerState = 'running' | 'stopped' | 'missing' | 'no-runtime'

export interface ContainerRuntimeInfo {
  runtime: 'podman' | 'docker'
  version: string
  isPodmanDockerShim: boolean
}

export interface ContainerResourceLimits {
  cpus?: number | null
  cpuShares?: number | null
  cpusetCpus?: string | null
  memory?: string | null
  memorySwap?: string | null
  memoryReservation?: string | null
  pidsLimit?: number | null
  oomScoreAdj?: number | null
}

export interface ContainerConfig {
  image: string
  tag: string
  ports?: Record<string, string>
  volumes?: Record<string, string>
  env?: Record<string, string>
  restart?: 'no' | 'unless-stopped' | 'always'
  command?: string[]
  networkMode?: string
  resources?: ContainerResourceLimits
  // signalk-container `user` field. Tells the runtime layer the
  // image's USER directive UID/GID so it can emit the right uid-
  // mapping flag (`--userns=keep-id:uid=X,gid=Y` on rootless podman,
  // `--user X:Y` on docker/rootful). Default of `undefined` means
  // signalk-container assumes inImageUid/Gid = 0, which is wrong for
  // any non-root image like mayara (USER mayara, UID 1000).
  user?: { inImageUid?: number; inImageGid?: number } | false
}

export interface ContainerInfo {
  name: string
  image: string
  state: ContainerState
}

export interface UpdateResourcesResult {
  method: 'live' | 'recreated'
  warnings?: string[]
}

// ----- update service ------------------------------------------------------

export type UpdateReason =
  | 'newer-version'
  | 'digest-drift'
  | 'older-than-pinned'
  | 'up-to-date'
  | 'offline'
  | 'unknown'
  | 'error'

export type UpdateTagKind = 'semver' | 'floating' | 'unknown'

export interface UpdateCheckResult {
  pluginId: string
  containerName: string
  runningTag: string
  tagKind: UpdateTagKind
  currentVersion: string | null
  latestVersion: string | null
  updateAvailable: boolean
  reason: UpdateReason
  error?: string
  checkedAt: string
  lastSuccessfulCheckAt: string | null
  fromCache: boolean
}

export interface VersionSource {
  // The actual signature uses ContainerRuntimeInfo, but mayara never
  // constructs sources by hand — it uses the factories on `updates.sources`.
  // Treating fetch as opaque is sufficient for the registration flow.
  fetch: (...args: unknown[]) => Promise<unknown>
}

export interface UpdateRegistration {
  pluginId: string
  containerName: string
  image: string
  currentTag: () => string
  versionSource: VersionSource
  currentVersion?: () => Promise<string | null>
  checkInterval?: string
}

export interface UpdateServiceApi {
  register: (reg: UpdateRegistration) => void
  unregister: (pluginId: string) => void
  checkOne: (pluginId: string) => Promise<UpdateCheckResult>
  checkAll: () => Promise<UpdateCheckResult[]>
  getLastResult: (pluginId: string) => UpdateCheckResult | null
  sources: {
    githubReleases: (
      repo: string,
      options?: { allowPrerelease?: boolean; tagPrefix?: string }
    ) => VersionSource
    dockerHubTags: (image: string, options?: { filter?: (tag: string) => boolean }) => VersionSource
  }
}

// ----- top-level container manager API -------------------------------------

export interface ContainerManagerApi {
  getRuntime: () => ContainerRuntimeInfo | null
  /**
   * Resolves once runtime detection has settled (success OR failure).
   * `getRuntime()` is guaranteed non-null only when this resolves AND
   * detection succeeded — callers should re-check after the await.
   * Available in signalk-container 1.6.0+.
   */
  whenReady: () => Promise<void>
  pullImage: (image: string, onProgress?: (msg: string) => void) => Promise<void>
  imageExists: (image: string) => Promise<boolean>
  getImageDigest: (imageOrContainer: string) => Promise<string | null>
  ensureRunning: (name: string, config: ContainerConfig) => Promise<void>
  start: (name: string) => Promise<void>
  stop: (name: string) => Promise<void>
  remove: (name: string) => Promise<void>
  getState: (name: string) => Promise<ContainerState>
  listContainers: () => Promise<ContainerInfo[]>
  updateResources: (name: string, limits: ContainerResourceLimits) => Promise<UpdateResourcesResult>
  getResources: (name: string) => ContainerResourceLimits
  updates: UpdateServiceApi
}

// =============================================================================
// Typed global access
// =============================================================================
//
// signalk-container exposes itself via `globalThis.__signalk_containerManager`
// rather than a property on the `app` object, because Signal K passes each
// plugin a shallow copy of `app` — properties set on it would not be visible
// across plugins. The cross-plugin bus is the global. See:
//
//   signalk-container/doc/plugin-developer-guide.md
//   §"Critical: Cross-Plugin Communication"
//
// This declaration gives consumer code a typed view of the global without
// repeated `as` casts. Use `getContainerManager()` from index.ts which adds
// the not-yet-loaded check.

declare global {
  var __signalk_containerManager: ContainerManagerApi | undefined
}
