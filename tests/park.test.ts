import type { On, PromptOrigin } from 'claude-code'
import { expect, mock, test, type Engine } from 'claude-code/testing'

// A fixed instant; the expected date uses the same local-date logic as the mod.
const NOW = Date.UTC(2026, 9, 29, 15, 4, 5)
const pad = (n: number) => String(n).padStart(2, '0')
const d = new Date(NOW)
const DATE = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`

const CWD = '/work/my-project'
const HOME = '/home/u'

type Write = { path: string; text: string }
type World = {
  writes: Write[]
  checked: string[]
  readPaths: string[]
  exists: boolean
  read: () => string
  onWrite: () => void
  env: Record<string, string>
  cwd: string
  stats: Record<string, { isLink: boolean; realPath?: string }>
  statError: 'always' | 'resolve' | undefined
}

// Nothing sits beneath the plugin: these hooks stand for the engine.
// A call on `$` is answered `{ value }`; an event by its own result.
const world = (on: On, init: Partial<World> = {}): World => {
  const w: World = {
    writes: [], checked: [], readPaths: [],
    exists: false, read: () => '', onWrite: () => {}, env: { HOME }, cwd: CWD, stats: {}, statError: undefined, ...init,
  }
  mock.env(on, w.env)
  mock.clock(on, { now: NOW })
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('session.end', (_, e) => ({ sessionId: e.sessionId }))
  on('command.register', () => ({ value: { command: 'park' } }))
  on('session.cwd', () => ({ value: w.cwd }))
  // As the engine: a regular file stats as one, a missing path rejects ENOENT.
  on('fs.stat', (_, e) => {
    if (w.statError === 'always' || (w.statError === 'resolve' && e.resolve)) throw new Error('EACCES')
    const s = w.stats[e.path] ?? (w.exists ? { isLink: false } : undefined)
    if (s === undefined) throw new Error('ENOENT')
    return { value: { kind: 'file' as const, size: 0, mtimeMs: 0, ...s } }
  })
  on('ui.toast', () => ({ value: undefined }))
  on('prompt.submit', (_, e) => ({ text: e.text }))
  on('fs.exists', (_, e) => {
    w.checked.push(e.path)
    return { value: w.exists }
  })
  on('fs.read', (_, e) => {
    w.readPaths.push(e.path)
    return { value: w.read() }
  })
  on('fs.write', (_, e) => {
    w.onWrite()
    w.writes.push({ path: e.path, text: e.text })
    return { value: undefined }
  })
  return w
}

const start = ($: Engine) => $.session.start({ cwd: CWD, surface: 'terminal', isInteractive: true })

// The engine stamps origin and presentation on a session's call; a test states them.
const origin = { kind: 'composer' } as const
const park = ($: Engine, args: string) =>
  $.command.run({ command: 'park', args, origin, presentation: { isFullscreen: false, columns: 80 } })
const submit = ($: Engine, text: string, from: PromptOrigin = origin) =>
  $.prompt.submit({ text, wait: false, origin: from })

test('default options: a new file gets the header and the entry', async ($, on) => {
  const w = world(on)
  await start($)
  const out = await park($, 'a test idea')

  expect(w.writes.length).toBe(1)
  const [write] = w.writes
  expect(write?.path).toBe(`${HOME}/.claude/IDEA_PARKING_LOT.md`)
  expect(write?.text.startsWith('# Idea Parking Lot')).toBe(true)
  expect(write?.text).toContain(`## ${DATE}: a test idea`)
  expect(write?.text).toContain('**What:** a test idea')
  expect(write?.text).toContain('from `my-project`')
  expect(out.text?.startsWith('Parked: a test idea')).toBe(true)
  expect(w.checked).toEqual([write?.path])
  expect(w.readPaths).toEqual([])
})

test('an existing file is appended to, header not re-added', async ($, on) => {
  const w = world(on, { exists: true, read: () => 'old\n' })
  await start($)
  await park($, 'second idea')

  const text = w.writes[0]?.text ?? ''
  expect(text.startsWith('old\n')).toBe(true)
  expect(text).not.toContain('# Idea Parking Lot')
  expect(text).toContain(`\n## ${DATE}: second idea\n`)
})

test(
  'project scope writes a file of the same name inside cwd',
  { options: { scope: 'project', parkingLot: '~/notes/LOT.md' } },
  async ($, on) => {
    const w = world(on)
    await start($)
    await park($, 'scoped idea')

    expect(w.writes[0]?.path).toBe(`${CWD}/LOT.md`)
  },
)

test('empty args answer the usage line and write nothing', async ($, on) => {
  const w = world(on)
  await start($)
  const out = await park($, '')

  expect(out.text).toBe('Usage: /park <idea>')
  expect(w.writes.length).toBe(0)
})

test('a read that fails never turns into an overwrite', async ($, on) => {
  const w = world(on, {
    exists: true,
    read: () => {
      throw new Error('over 4 MiB')
    },
  })
  await start($)
  const out = await park($, 'risky idea')

  expect(w.writes.length).toBe(0)
  expect(out.text).toContain('Nothing written')
})

test(
  'includeLastPrompt false keeps the last prompt out of the entry',
  { options: { includeLastPrompt: false } },
  async ($, on) => {
    const w = world(on)
    await start($)
    await submit($, 'secret stuff')
    await park($, 'quiet idea')

    expect(w.writes.length).toBe(1)
    expect(w.writes[0]?.text).not.toContain('secret stuff')
    expect(w.writes[0]?.text).toContain('from `my-project`\n')
  },
)

test('by default the entry says what you were working on', async ($, on) => {
  const w = world(on)
  await start($)
  await submit($, 'add the manifest')
  await park($, 'loud idea')

  expect(w.writes[0]?.text).toContain('while working on "add the manifest"')
})

test('a file holding a NUL byte is refused, not overwritten', async ($, on) => {
  const w = world(on, { exists: true, read: () => 'PNG\u0000junk' })
  await start($)
  const out = await park($, 'binary idea')

  expect(w.writes.length).toBe(0)
  expect(out.text).toContain('binary or not UTF-8')
})

test('a file holding U+FFFD is refused the same way', async ($, on) => {
  const w = world(on, { exists: true, read: () => 'latin\uFFFDtext' })
  await start($)
  const out = await park($, 'mojibake idea')

  expect(w.writes.length).toBe(0)
  expect(out.text).toContain('binary or not UTF-8')
})

test('with no prompt yet the entry says so', async ($, on) => {
  const w = world(on)
  await start($)
  await park($, 'early idea')

  expect(w.writes[0]?.text).toContain('before any prompt this session')
})

test(
  'a ~ setting with no home folder set is refused',
  { options: { parkingLot: '~/x.md' } },
  async ($, on) => {
    const w = world(on, { env: {} })
    await start($)
    const out = await park($, 'homeless idea')

    expect(out.text).toContain('no home folder')
    expect(w.writes.length).toBe(0)
  },
)

test('a CRLF file keeps CRLF line endings', async ($, on) => {
  const w = world(on, { exists: true, read: () => 'old\r\n' })
  await start($)
  await park($, 'windows idea')

  const text = w.writes[0]?.text ?? ''
  expect(text.startsWith('old\r\n')).toBe(true)
  expect(text.includes('\r\n## ')).toBe(true)
  expect(/[^\r]\n## /.test(text)).toBe(false)
})

test('an existing empty file gets the header', async ($, on) => {
  const w = world(on, { exists: true, read: () => '' })
  await start($)
  await park($, 'fresh idea')

  expect(w.writes[0]?.text.startsWith('# Idea Parking Lot')).toBe(true)
})

test('a write that fails is reported', async ($, on) => {
  world(on, {
    onWrite: () => {
      throw new Error('disk full')
    },
  })
  await start($)
  const out = await park($, 'doomed idea')

  expect(out.text).toContain('cannot write')
  expect(out.text).toContain('Nothing written')
})

test('exists, read and write all take the same path', async ($, on) => {
  const w = world(on, { exists: true, read: () => 'old\n' })
  await start($)
  await park($, 'same path idea')

  const path = w.writes[0]?.path
  expect(w.checked).toEqual([path])
  expect(w.readPaths).toEqual([path])
})

test(
  'a file Claude reads as instructions is refused',
  { options: { parkingLot: '~/CLAUDE.md' } },
  async ($, on) => {
    const w = world(on)
    await start($)
    const out = await park($, 'instruction idea')

    expect(out.text).toContain('reads as instructions')
    expect(w.writes.length).toBe(0)
  },
)

test(
  'CLAUDE.local.md is refused too',
  { options: { parkingLot: '~/CLAUDE.local.md' } },
  async ($, on) => {
    const w = world(on)
    await start($)
    const out = await park($, 'local instruction idea')

    expect(out.text).toContain('reads as instructions')
    expect(w.writes.length).toBe(0)
  },
)

test(
  'a trailing slash on the setting is dropped',
  { options: { parkingLot: '~/lot.md/' } },
  async ($, on) => {
    const w = world(on)
    await start($)
    await park($, 'slashed idea')

    expect(w.writes[0]?.path).toBe(`${HOME}/lot.md`)
  },
)

test('a /clear forgets the last prompt', async ($, on) => {
  const w = world(on)
  await start($)
  await submit($, 'before the clear')
  await $.session.end({ reason: 'clear', sessionId: 's1', resume: { id: 's1' } })
  await park($, 'cleared idea')

  const text = w.writes[0]?.text ?? ''
  expect(text).toContain('before any prompt this session')
  expect(text).not.toContain('before the clear')
})

test(
  'global scope rejects a relative parking lot setting',
  { options: { parkingLot: 'notes/lot.md' } },
  async ($, on) => {
    const w = world(on)
    await start($)
    const out = await park($, 'idea')

    expect(out.text).toContain('absolute path')
    expect(w.writes.length).toBe(0)
  },
)

test(
  'global scope rejects a parking lot that is not a text file',
  { options: { parkingLot: '~/notes.db' } },
  async ($, on) => {
    const w = world(on)
    await start($)
    const out = await park($, 'idea')

    expect(out.text).toContain('.md, .markdown or .txt')
    expect(w.writes.length).toBe(0)
  },
)

test('only a prompt the person typed is remembered, not a channel relay', async ($, on) => {
  const w = world(on)
  await start($)
  await submit($, 'typed first')
  await submit($, 'relayed from slack', { kind: 'channel', server: 'slack' })
  await park($, 'origin idea')

  const text = w.writes[0]?.text ?? ''
  expect(text).toContain('while working on "typed first"')
  expect(text).not.toContain('relayed from slack')
})

test('two /park calls in flight at once are serialised', async ($, on) => {
  const w = world(on, { exists: true })
  // The second read sees what the first call wrote, or it proves nothing.
  w.read = () => w.writes[w.writes.length - 1]?.text ?? 'old\n'
  await start($)
  await Promise.all([park($, 'first idea'), park($, 'second idea')])

  expect(w.writes.length).toBe(2)
  expect(w.writes[1]?.text).toContain('**What:** first idea')
  expect(w.writes[1]?.text).toContain('**What:** second idea')
  expect(w.writes[1]?.text.startsWith('old\n')).toBe(true)
})

const LOT = `${HOME}/.claude/IDEA_PARKING_LOT.md`

test(
  'project scope refuses a parking lot that is a symbolic link',
  { options: { scope: 'project' } },
  async ($, on) => {
    const lot = `${CWD}/IDEA_PARKING_LOT.md`
    const w = world(on, { stats: { [lot]: { isLink: true, realPath: `${HOME}/.zshrc` } } })
    await start($)
    const out = await park($, 'cloned repo idea')

    expect(out.text).toContain('symbolic link')
    expect(w.writes.length).toBe(0)
  },
)

test('global scope follows a link to another markdown file', async ($, on) => {
  const w = world(on, { stats: { [LOT]: { isLink: true, realPath: `${HOME}/Dropbox/lot.md` } } })
  await start($)
  await park($, 'synced idea')

  expect(w.writes[0]?.path).toBe(LOT)
})

test('global scope refuses a link to an instruction file', async ($, on) => {
  const w = world(on, { stats: { [LOT]: { isLink: true, realPath: `${HOME}/.claude/CLAUDE.md` } } })
  await start($)
  const out = await park($, 'sneaky idea')

  expect(out.text).toContain('will not write to')
  expect(w.writes.length).toBe(0)
})

test('global scope refuses a link that leads nowhere', async ($, on) => {
  const w = world(on, { stats: { [LOT]: { isLink: true } } })
  await start($)
  const out = await park($, 'dangling idea')

  expect(out.text).toContain('leads nowhere')
  expect(w.writes.length).toBe(0)
})

test(
  'a parking lot under .claude/rules/ is refused',
  { options: { parkingLot: '~/.claude/rules/ideas.md' } },
  async ($, on) => {
    const w = world(on)
    await start($)
    const out = await park($, 'rules idea')

    expect(out.text).toContain('.claude/rules/')
    expect(w.writes.length).toBe(0)
  },
)

test('a folder name with a backtick or newline stays on one line', async ($, on) => {
  const w = world(on, { cwd: '/work/bad`name\n## injected' })
  await start($)
  await park($, 'odd folder idea')

  const text = w.writes[0]?.text ?? ''
  expect(text).toContain("from `bad'name ## injected`")
  expect(text).not.toContain('\n## injected')
})

test('a stat that fails on a file that is there refuses (fail closed)', async ($, on) => {
  const w = world(on, { exists: true, read: () => 'old\n', statError: 'always' })
  await start($)
  const out = await park($, 'unchecked idea')

  expect(out.text).toContain('cannot check whether')
  expect(w.writes.length).toBe(0)
})

test('a link whose target cannot be resolved refuses', async ($, on) => {
  const w = world(on, {
    exists: true,
    stats: { [LOT]: { isLink: true, realPath: `${HOME}/lot.md` } },
    statError: 'resolve',
  })
  await start($)
  const out = await park($, 'unresolved idea')

  expect(out.text).toContain('cannot resolve the link')
  expect(w.writes.length).toBe(0)
})
