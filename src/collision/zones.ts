export type AlertLevel = 'alert' | 'warn' | 'alarm' | 'emergency'

/** A target is in a zone when its CPA is within `cpa` metres and comes within `tcpa` seconds. */
export interface Zone {
  level: AlertLevel
  cpa: number
  tcpa: number
}

export type PresetName = 'harbour' | 'coastal' | 'offshore'

const NM = 1852
const MIN = 60

export const PRESETS: Record<PresetName, Zone[]> = {
  harbour: [
    { level: 'warn', cpa: 100, tcpa: 5 * MIN },
    { level: 'alarm', cpa: 50, tcpa: 2 * MIN }
  ],
  coastal: [
    { level: 'warn', cpa: 0.5 * NM, tcpa: 12 * MIN },
    { level: 'alarm', cpa: 0.25 * NM, tcpa: 6 * MIN }
  ],
  offshore: [
    { level: 'warn', cpa: 1 * NM, tcpa: 20 * MIN },
    { level: 'alarm', cpa: 0.5 * NM, tcpa: 10 * MIN }
  ]
}

const SEVERITY: Record<AlertLevel, number> = {
  alert: 1,
  warn: 2,
  alarm: 3,
  emergency: 4
}

// A raised level is held until the target leaves its zone by this margin,
// so a CPA hovering on a threshold doesn't toggle the alarm every update.
const RELEASE_FACTOR = 1.2
// Seconds past closest approach a raised level is still held: a target
// passing close astern is still a hazard for a moment after TCPA crosses 0.
const RELEASE_AFTER_CPA = 30

function inZone(zone: Zone, cpa: number, tcpa: number, factor: number, minTcpa: number): boolean {
  return cpa <= zone.cpa * factor && tcpa > minTcpa && tcpa <= zone.tcpa * factor
}

function highest(levels: AlertLevel[]): AlertLevel | undefined {
  return levels.reduce<AlertLevel | undefined>(
    (best, l) => (best === undefined || SEVERITY[l] > SEVERITY[best] ? l : best),
    undefined
  )
}

/**
 * The level a target should be at now, given the level it is currently at.
 *
 * Escalation is immediate on the strict zone; de-escalation waits until the
 * target has also left the relaxed zone of the current level.
 */
export function assess(
  zones: Zone[],
  cpa: number,
  tcpa: number,
  current: AlertLevel | undefined
): AlertLevel | undefined {
  const entered = highest(zones.filter((z) => inZone(z, cpa, tcpa, 1, 0)).map((z) => z.level))
  if (current === undefined) {
    return entered
  }
  const held = highest(
    zones
      .filter((z) => SEVERITY[z.level] <= SEVERITY[current])
      .filter((z) => inZone(z, cpa, tcpa, RELEASE_FACTOR, -RELEASE_AFTER_CPA))
      .map((z) => z.level)
  )
  return highest([entered, held].filter((l): l is AlertLevel => l !== undefined))
}
