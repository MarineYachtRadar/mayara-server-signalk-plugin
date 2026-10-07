import { describe, expect, it, vi } from 'vitest'
import type { Delta, NotificationId, PathValue, ServerAPI } from '@signalk/server-api'
import type { Mock } from 'vitest'
import { DeltaAlarmSink, ManagedAlarmSink, type CollisionAlert } from '../src/collision/alarms.js'

type HandleMessage = (id: string, delta: Delta) => void

/** The first path/value of the n-th delta passed to a mocked handleMessage. */
function sentValue(mock: Mock<HandleMessage>, call: number): PathValue {
  const update = mock.mock.calls.at(call)?.[1].updates[0]
  if (!update || !('values' in update)) {
    throw new Error(`handleMessage call ${call} carried no values`)
  }
  return update.values[0]
}

type NotificationsApi = ServerAPI['notifications']

const ID = 'radar:nav1:7'

function alert(level: CollisionAlert['level']): CollisionAlert {
  return {
    level,
    message: 'Collision risk',
    data: {
      targetRef: 'targets.radar:nav1-7',
      source: 'radar',
      cpa: 100,
      tcpa: 60,
      range: 500,
      cpaPositions: null
    }
  }
}

function fakeApp() {
  const notifications = {
    raise: vi.fn<NotificationsApi['raise']>(() => 'n1' as NotificationId),
    update: vi.fn<NotificationsApi['update']>(),
    getId: vi.fn<NotificationsApi['getId']>(() => undefined),
    clear: vi.fn<NotificationsApi['clear']>()
  }
  const handleMessage = vi.fn<HandleMessage>()
  const app = { notifications, handleMessage } as unknown as ServerAPI
  return { app, notifications, handleMessage }
}

describe('ManagedAlarmSink', () => {
  it('raises once under the per-target path, then updates on level change', () => {
    const { app, notifications } = fakeApp()
    const sink = new ManagedAlarmSink(app, () => 0)
    sink.set(ID, alert('warn'))
    sink.set(ID, alert('warn'))
    sink.set(ID, alert('alarm'))
    expect(notifications.raise).toHaveBeenCalledOnce()
    expect(notifications.raise.mock.calls[0][0]).toMatchObject({
      state: 'warn',
      path: `navigation.closestApproach.${ID}`
    })
    expect(notifications.update).toHaveBeenCalledOnce()
    expect(notifications.update).toHaveBeenCalledWith(
      'n1',
      expect.objectContaining({ state: 'alarm' })
    )
  })

  it('refreshes unchanged data only after the refresh interval', () => {
    const { app, notifications } = fakeApp()
    let now = 0
    const sink = new ManagedAlarmSink(app, () => now)
    sink.set(ID, alert('warn'))
    now = 5_000
    sink.set(ID, alert('warn'))
    now = 11_000
    sink.set(ID, alert('warn'))
    expect(notifications.update).toHaveBeenCalledOnce()
  })

  it('raises again when its notification was removed by the server', () => {
    const { app, notifications } = fakeApp()
    notifications.update.mockImplementation(() => {
      throw new Error('Notification not found!')
    })
    const sink = new ManagedAlarmSink(app, () => 0)
    sink.set(ID, alert('warn'))
    sink.set(ID, alert('alarm'))
    expect(notifications.raise).toHaveBeenCalledTimes(2)
  })

  it('does not raise a second alarm while a failed update leaves the first standing', () => {
    const { app, notifications } = fakeApp()
    notifications.update.mockImplementation(() => {
      throw new Error('Notification options not supplied!')
    })
    notifications.getId.mockReturnValue({} as ReturnType<NotificationsApi['getId']>)
    const sink = new ManagedAlarmSink(app, () => 0)
    sink.set(ID, alert('warn'))
    sink.set(ID, alert('alarm'))
    expect(notifications.raise).toHaveBeenCalledOnce()
  })

  it('clears on release and on clearAll', () => {
    const { app, notifications } = fakeApp()
    const sink = new ManagedAlarmSink(app, () => 0)
    sink.set(ID, alert('warn'))
    sink.set(ID, undefined)
    expect(notifications.clear).toHaveBeenCalledWith('n1')
    sink.set(ID, alert('warn'))
    sink.clearAll()
    expect(notifications.clear).toHaveBeenCalledTimes(2)
  })
})

describe('DeltaAlarmSink', () => {
  it('emits a notification delta and clears it on release', () => {
    const { app, handleMessage } = fakeApp()
    const sink = new DeltaAlarmSink(app, 'plugin', () => 0)
    sink.set(ID, alert('alarm'))
    sink.set(ID, undefined)
    const raised = sentValue(handleMessage, 0)
    expect(raised.path).toBe(`notifications.navigation.closestApproach.${ID}`)
    expect(raised.value).toMatchObject({
      state: 'alarm',
      data: { targetRef: 'targets.radar:nav1-7' }
    })
    expect(sentValue(handleMessage, 1).value).toMatchObject({ state: 'normal' })
  })
})
