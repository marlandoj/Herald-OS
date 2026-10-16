import { shell } from 'electron'
import vm from 'node:vm'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { CALENDAR_JXA, DarwinPlatform, parseDf, parsePmset, parsePs, parseVmStat, parseWifiDevice, parseWifiSummary } from './darwin.ts'

const commands = vi.hoisted(() => ({ outputs: new Map<string, string>(), calls: [] as string[] }))

// Keep the real platform/parsers; replace only Electron's native shell boundary.
vi.mock('electron', () => ({
  shell: { openPath: vi.fn().mockResolvedValue(''), showItemInFolder: vi.fn() }
}))

vi.mock('./exec.ts', () => ({
  MISSING_BINARY: 127,
  run: vi.fn(async (command: string, args: string[]) => {
    const line = [command, ...args].join(' ')
    commands.calls.push(line)

    return { stdout: commands.outputs.get(line) ?? '', stderr: '', code: 0 }
  }),
  runBuffer: vi.fn()
}))

const PORTS = '\nHardware Port: Ethernet Adapter (en3)\nDevice: en3\nEthernet Address: 7a:00:00:00:00:01\n\nHardware Port: Wi-Fi\nDevice: en0\nEthernet Address: 7a:00:00:00:00:02\n'
const SUMMARY = '<dictionary> {\n  BSSID : <redacted>\n  InterfaceType : WiFi\n  LinkStatusActive : TRUE\n  SSID : Cafe Guest\n}\n'

describe('Wi-Fi status', () => {
  it('finds the Wi-Fi device among the hardware ports', () => {
    expect(parseWifiDevice(PORTS)).toBe('en0')
    expect(parseWifiDevice('Hardware Port: Ethernet\nDevice: en5\n')).toBeUndefined()
  })

  it('reads the link and the SSID, and drops an SSID macOS redacted', () => {
    expect(parseWifiSummary(SUMMARY, 'en0')).toEqual({ connected: true, ssid: 'Cafe Guest', interface: 'en0' })
    expect(parseWifiSummary(SUMMARY.replace('SSID : Cafe Guest', 'SSID : <redacted>'), 'en0').ssid).toBeUndefined()
    expect(parseWifiSummary('  LinkStatusActive : FALSE\n', 'en0')).toEqual({ connected: false, ssid: undefined, interface: 'en0' })
  })

  it('never runs system_profiler, which scans for networks on every call', async () => {
    commands.outputs.set('route -n get default', '   route to: default\n  interface: en0\n')
    commands.outputs.set('ipconfig getifaddr en0', '192.168.1.20\n')
    commands.outputs.set('networksetup -listallhardwareports', PORTS)
    commands.outputs.set('ipconfig getsummary en0', SUMMARY)

    expect(await new DarwinPlatform().networkStatus()).toEqual({ online: true, defaultInterface: 'en0', ipv4: '192.168.1.20', wifi: { connected: true, ssid: 'Cafe Guest', interface: 'en0' } })
    expect(commands.calls.filter(line => line.startsWith('system_profiler'))).toEqual([])
  })
})

describe('darwin parsers', () => {
  it('derives used memory from active + wired + compressor pages', () => {
    const text = 'Mach Virtual Memory Statistics: (page size of 16384 bytes)\nPages free: 100.\nPages active: 10.\nPages wired down: 5.\nPages occupied by compressor: 1.\n'
    expect(parseVmStat(text)).toEqual({ pageSize: 16384, usedBytes: 16 * 16384 })
    expect(parseVmStat('garbage')).toBeNull()
  })

  it('keeps the root volume and external volumes, drops hidden APFS volumes', () => {
    const df = ['Filesystem 1024-blocks Used Available Capacity Mounted on', '/dev/disk3s1s1 1000 400 600 40% /', 'devfs 1 1 0 100% /dev', '/dev/disk3s6 1000 10 990 1% /System/Volumes/VM', '/dev/disk5s1 2000 500 1500 25% /Volumes/Backup Drive'].join('\n')
    const disks = parseDf(df)
    expect(disks.map(d => d.mount)).toEqual(['/', '/Volumes/Backup Drive'])
    expect(disks[1]).toMatchObject({ total: 2000 * 1024, used: 500 * 1024, free: 1500 * 1024 })
    // Root: APFS "Used" (400) is only the system volume; usage is derived from what is still available.
    expect(disks[0]).toMatchObject({ total: 1000 * 1024, used: 400 * 1024, free: 600 * 1024 })
  })

  it('reads battery percentage and charging state', () => {
    expect(parsePmset("Now drawing from 'AC Power'\n -InternalBattery-0 (id=123)\t85%; charging; 0:45 remaining present: true")).toEqual({ present: true, percent: 85, charging: true })
    expect(parsePmset("Now drawing from 'Battery Power'\n -InternalBattery-0 (id=123)\t42%; discharging; 3:10 remaining present: true")).toEqual({ present: true, percent: 42, charging: false })
    expect(parsePmset('Now drawing from AC Power')).toEqual({ present: false })
  })

  it('parses ps rows including commands with spaces', () => {
    const rows = parsePs('  512     1 sam   12.5  0.3   204800 /Applications/Visual Studio Code.app/Contents/MacOS/Electron\n')
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ pid: 512, ppid: 1, user: 'sam', cpuPercent: 12.5, rssBytes: 204800 * 1024, name: 'Electron' })
  })
})

describe('Electron shell delegation', () => {
  beforeEach(() => {
    vi.mocked(shell.openPath).mockClear()
    vi.mocked(shell.showItemInFolder).mockClear()
  })

  it('launches the requested app when Electron returns an empty error string', async () => {
    vi.mocked(shell.openPath).mockResolvedValueOnce('')
    await expect(new DarwinPlatform().launchApp('/Applications/Example.app')).resolves.toBeUndefined()
    expect(shell.openPath).toHaveBeenCalledExactlyOnceWith('/Applications/Example.app')
  })

  it('reports the error string returned by Electron instead of claiming success', async () => {
    vi.mocked(shell.openPath).mockResolvedValueOnce('Permission denied')
    await expect(new DarwinPlatform().launchApp('/Applications/Example.app')).rejects.toThrow('Permission denied')
    expect(shell.openPath).toHaveBeenCalledExactlyOnceWith('/Applications/Example.app')
  })

  it('reveals the exact requested path through Electron', async () => {
    await expect(new DarwinPlatform().revealPath('/synthetic/with space.txt')).resolves.toBeUndefined()
    expect(shell.showItemInFolder).toHaveBeenCalledExactlyOnceWith('/synthetic/with space.txt')
    expect(shell.openPath).not.toHaveBeenCalled()
  })
})

type AccessHandler = (granted: boolean, error: unknown) => void

/**
 * Runs the calendar script against a stand-in for the JXA bridge, which hands integers back as
 * strings the way JXA on macOS 26 does. `answer` is the status left behind by the reply to the prompt.
 */
function runCalendarScript(initial: number, options: { answer?: number; fullAccessApi?: boolean } = {}) {
  let status = initial
  const requests: string[] = []
  const respond = (api: string, handler: AccessHandler) => {
    requests.push(api)
    status = options.answer ?? status
    handler(status === 3, null)
  }
  const nil = { isNil: () => true }
  const event = { eventIdentifier: 'ev-1', title: 'Standup', startDate: { timeIntervalSince1970: 1_700_000_000 }, endDate: { timeIntervalSince1970: 1_700_000_900 }, isAllDay: false, location: nil, notes: nil, URL: nil, calendar: { title: 'Work' } }
  const store = {
    respondsToSelector: (selector: string) => selector === 'requestFullAccessToEventsWithCompletion:' && options.fullAccessApi !== false,
    requestFullAccessToEventsWithCompletion: (handler: AccessHandler) => respond('full', handler),
    requestAccessToEntityTypeCompletion: (_type: string, handler: AccessHandler) => respond('legacy', handler),
    predicateForEventsWithStartDateEndDateCalendars: () => ({}),
    eventsMatchingPredicate: () => ({ count: '1', objectAtIndex: () => event })
  }
  const bridge = Object.assign(() => nil, {
    EKEntityTypeEvent: '0',
    EKEventStore: { alloc: { init: store }, authorizationStatusForEntityType: () => String(status) },
    NSCalendar: { currentCalendar: { startOfDayForDate: () => ({ dateByAddingTimeInterval: () => ({}) }) } },
    NSDate: { date: {}, dateWithTimeIntervalSinceNow: () => ({}) },
    NSRunLoop: { currentRunLoop: { runUntilDate: () => undefined } }
  })
  const output = vm.runInNewContext(CALENDAR_JXA, { ObjC: { import: () => undefined, unwrap: (value: unknown) => value }, $: bridge }) as string

  return { requests, result: JSON.parse(output) as unknown }
}

describe('calendar script', () => {
  it('asks for full access while undecided, although JXA returns the status as a string', () => {
    expect(runCalendarScript(0, { answer: 3 })).toEqual({
      requests: ['full'],
      result: { status: 'authorized', events: [{ id: 'ev-1', title: 'Standup', start: 1_700_000_000_000, end: 1_700_000_900_000, allDay: false, calendar: 'Work' }] }
    })
  })

  it('falls back to the older request on macOS 13', () => {
    expect(runCalendarScript(0, { answer: 3, fullAccessApi: false }).requests).toEqual(['legacy'])
  })

  it('stays undecided when macOS refuses to ask (no usage string in the app)', () => {
    expect(runCalendarScript(0)).toEqual({ requests: ['full'], result: { status: 'not-determined', events: [] } })
  })

  it('reports denied, restricted and write-only access without asking again', () => {
    expect(runCalendarScript(2)).toEqual({ requests: [], result: { status: 'denied', events: [] } })
    expect(runCalendarScript(1)).toEqual({ requests: [], result: { status: 'restricted', events: [] } })
    expect(runCalendarScript(4)).toEqual({ requests: [], result: { status: 'denied', events: [] } })
  })
})
