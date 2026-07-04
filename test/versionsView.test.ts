import { describe, it, expect } from 'vitest'
import { deriveVersionsView, shownTags, runningTagFallback } from '../src/configpanel/versionsView'

describe('versionsView: deriveVersionsView', () => {
  it('full success: returns the versions and no error line', () => {
    const v = deriveVersionsView(true, {
      versions: [
        { tag: 'v3.4.0', prerelease: false },
        { tag: 'pr429', pr: 429, title: 'north-up fix' }
      ],
      sources: { releases: 'ok', prImages: 'ok' }
    })
    expect(v.versions).toEqual([
      { tag: 'v3.4.0', prerelease: false },
      { tag: 'pr429', pr: 429, title: 'north-up fix' }
    ])
    expect(v.versionsError).toBe('')
  })

  it('rate-limited pulls (the boat bug): keeps releases, shows the rate-limit line', () => {
    const v = deriveVersionsView(true, {
      versions: [{ tag: 'v3.4.0', prerelease: false }],
      sources: { releases: 'ok', prImages: 'rate-limited' }
    })
    expect(v.versions).toEqual([{ tag: 'v3.4.0', prerelease: false }])
    expect(v.versionsError).toMatch(/rate-limited/)
    // Distinct from a generic error so the operator knows to retry, not
    // that no PR images exist.
    expect(v.versionsError).toContain('PR test images')
  })

  it('generic error is distinct from rate-limited', () => {
    const v = deriveVersionsView(true, {
      versions: [{ tag: 'v3.4.0', prerelease: false }],
      sources: { releases: 'ok', prImages: 'error' }
    })
    expect(v.versionsError).toContain('Could not fetch')
    expect(v.versionsError).not.toMatch(/rate-limited/)
  })

  it('rate-limited releases (not prImages) does not falsely blame PR test images', () => {
    const v = deriveVersionsView(true, {
      versions: [],
      sources: { releases: 'rate-limited', prImages: 'ok' }
    })
    expect(v.versionsError).toMatch(/rate-limited/)
    expect(v.versionsError).toContain('some versions')
    expect(v.versionsError).not.toContain('PR test images')
  })

  it('does not throw on a malformed 200 body (null / non-object / missing fields)', () => {
    for (const body of [null, undefined, 42, 'nope', {}]) {
      const v = deriveVersionsView(true, body)
      expect(v.versions).toEqual([])
      expect(v.versionsError).toBe('')
    }
  })

  it('502 (both down): null versions so the caller preserves its list, plus a last-known line', () => {
    const v = deriveVersionsView(false, null)
    expect(v.versions).toBeNull()
    expect(v.versionsError).toContain('last known')
  })

  it('legacy bare-array body is accepted (backend/panel version skew)', () => {
    const v = deriveVersionsView(true, [{ tag: 'v3.4.0', prerelease: false }])
    expect(v.versions).toEqual([{ tag: 'v3.4.0', prerelease: false }])
    expect(v.versionsError).toBe('')
  })

  it('missing versions/sources fields degrade to empty list, no error', () => {
    expect(deriveVersionsView(true, {}).versions).toEqual([])
    expect(deriveVersionsView(true, {}).versionsError).toBe('')
  })
})

describe('versionsView: runningTagFallback', () => {
  const versions = [
    { tag: 'v3.4.0', prerelease: false },
    { tag: 'v3.5.0-rc1', prerelease: true },
    { tag: 'pr429', pr: 429, title: 'x' }
  ]

  it('returns null for a tag already shown (real option — no duplicate)', () => {
    expect(runningTagFallback('pr429', versions)).toBeNull()
    expect(runningTagFallback('v3.4.0', versions)).toBeNull()
    expect(runningTagFallback('latest', versions)).toBeNull()
    expect(runningTagFallback('main', versions)).toBeNull()
  })

  it('returns the running tag when it is NOT among the shown options', () => {
    // pr427 was rate-limited out of the /pulls fetch but is running.
    expect(runningTagFallback('pr427', versions)).toBe('pr427')
    // a stable pin that fell out of the top-N.
    expect(runningTagFallback('v3.0.0', versions)).toBe('v3.0.0')
  })

  it('returns null for an empty/undefined running tag', () => {
    expect(runningTagFallback('', versions)).toBeNull()
    expect(runningTagFallback(undefined, versions)).toBeNull()
  })

  it('shownTags reflects the same top-N slicing the dropdown renders', () => {
    const many = Array.from({ length: 10 }, (_, i) => ({
      tag: `v3.${i}.0`,
      prerelease: false
    }))
    const set = shownTags(many)
    // Only the first 5 stable versions render, so the 6th is a fallback.
    expect(set.has('v3.4.0')).toBe(true)
    expect(set.has('v3.5.0')).toBe(false)
    expect(runningTagFallback('v3.5.0', many)).toBe('v3.5.0')
  })
})
