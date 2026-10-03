import { describe, expect, it } from 'vitest'
import { PRESETS, assess } from '../src/collision/zones.js'

const zones = PRESETS.coastal // warn 926 m / 720 s, alarm 463 m / 360 s

describe('assess', () => {
  it('raises the highest matching level', () => {
    expect(assess(zones, 400, 300, undefined)).toBe('alarm')
    expect(assess(zones, 800, 300, undefined)).toBe('warn')
    expect(assess(zones, 400, 600, undefined)).toBe('warn')
    expect(assess(zones, 2000, 300, undefined)).toBeUndefined()
  })

  it('never raises for a target that has already passed', () => {
    expect(assess(zones, 10, -5, undefined)).toBeUndefined()
  })

  it('holds a raised level while the target hovers just outside the zone', () => {
    expect(assess(zones, 950, 300, undefined)).toBeUndefined()
    expect(assess(zones, 950, 300, 'warn')).toBe('warn')
    expect(assess(zones, 1200, 300, 'warn')).toBeUndefined()
  })

  it('steps down to the lower level rather than clearing outright', () => {
    expect(assess(zones, 700, 300, 'alarm')).toBe('warn')
  })

  it('holds briefly after closest approach, then clears', () => {
    expect(assess(zones, 100, -10, 'alarm')).toBe('alarm')
    expect(assess(zones, 100, -60, 'alarm')).toBeUndefined()
  })

  it('does not let a held lower level mask an escalation', () => {
    expect(assess(zones, 300, 200, 'warn')).toBe('alarm')
  })
})
