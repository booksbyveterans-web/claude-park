import type { Register } from 'claude-code'

// /park <idea>
// Adds the idea to the end of a parking-lot markdown file with the date, the
// project and (optionally) what you were doing, then comes straight back. No
// Claude turn is spent, and it runs even while a turn is in flight.

const DEFAULT_LOT = '~/.claude/IDEA_PARKING_LOT.md'
const HEADER =
  '# Idea Parking Lot\n\n' +
  'Ideas parked with /park. Each entry carries enough context to pick it back up cold.\n'
const PROMPT_KEEP = 200
const IDEA_HEADING = 80
const IDEA_ECHO = 120
const TEXT_FILE = /.\.(md|markdown|txt)$/i
// Files Claude reads as instructions: parked ideas must never become one.
const INSTRUCTION_FILES = /^(CLAUDE(\.local)?|AGENTS)\.md$/i
const ABSOLUTE = /^([A-Za-z]:)?[\\/]/
const CONTROL = /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g

// One session per plugin process on this build, so module state is per session.
let lastPrompt = ''
let home = ''
// /park calls are serialised: two in flight at once must not interleave read and write.
let queue: Promise<unknown> = Promise.resolve()

const text = (v: unknown, fallback: string): string =>
  typeof v === 'string' && v.trim() !== '' ? v.trim() : fallback

const localDate = (ms: number): string => {
  const d = new Date(ms)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

// Collapse whitespace, drop control characters, cut at `max` characters (whole code points).
const oneLine = (s: string, max: number): string => {
  const t = s.replace(CONTROL, '').replace(/\s+/g, ' ').trim()
  const chars = Array.from(t)
  return chars.length > max ? chars.slice(0, max).join('') + '…' : t
}

const basename = (p: string): string => p.split(/[\\/]/).filter(Boolean).slice(-1)[0] ?? ''

const trimSlash = (p: string): string => p.replace(/[\\/]+$/, '')

// Where this /park writes, or a reason it cannot.
const resolveLot = (rawLot: string, scope: string, cwd: string): { path: string } | { error: string } => {
  const lot = trimSlash(rawLot)
  const name = basename(lot)
  if (!TEXT_FILE.test(name)) {
    return { error: `the parking lot file "${rawLot}" must be a .md, .markdown or .txt file` }
  }
  if (INSTRUCTION_FILES.test(name)) {
    return { error: `the parking lot file "${rawLot}" is one Claude reads as instructions; pick another name` }
  }
  if (scope === 'project') return { path: `${trimSlash(cwd)}/${name}` }
  let path = lot
  if (/^~[\\/]/.test(lot)) {
    if (home === '') return { error: `"${lot}" starts with ~ but no home folder is set (HOME or USERPROFILE)` }
    path = trimSlash(home) + '/' + lot.slice(2)
  }
  if (!ABSOLUTE.test(path)) {
    return { error: `the parking lot file "${lot}" must be an absolute path, or start with ~/` }
  }
  return { path }
}

const looksBinary = (s: string): boolean => s.includes('\u0000') || s.includes('�')

const reason = (err: unknown): string => (err instanceof Error ? err.message : String(err))

export const register: Register = (on, options) => {
  const lot = text(options.parkingLot, DEFAULT_LOT)
  const scope = options.scope === 'project' ? 'project' : 'global'
  const includeLastPrompt = options.includeLastPrompt !== false

  on('session.start', async ($, e, next) => {
    try {
      home = (await $.env.get('HOME')) || (await $.env.get('USERPROFILE')) || ''
    } catch {
      home = ''
    }
    await $.command.register({
      name: 'park',
      description: 'Park an idea in your parking-lot file and keep working',
      argumentHint: '<idea>',
      immediate: true,
    })
    return next(e)
  })

  on('session.end', async ($, e, next) => {
    // A /clear ends the session's conversation: what came before it is not "what you were doing".
    lastPrompt = ''
    return next(e)
  })

  on('prompt.submit', async ($, e, next) => {
    try {
      // Only what the person typed here: not relays, peers, schedules or notifications.
      const typed = e.origin.kind === 'composer' || e.origin.kind === 'bridge'
      if (includeLastPrompt && typed && !e.command && !e.isMeta) lastPrompt = oneLine(e.text, PROMPT_KEEP)
    } catch {
      // never block a prompt
    }
    return next(e)
  }).catch(($, e, next) => next(e))

  on('command.run', { command: 'park' }, async ($, e) => {
    const idea = oneLine(e.args, Number.MAX_SAFE_INTEGER)
    if (idea === '') return { text: 'Usage: /park <idea>' }

    const run = async (): Promise<{ text: string }> => {
      let cwd = ''
      let date = ''
      try {
        cwd = await $.session.cwd()
        date = localDate(await $.clock.now())
      } catch (err) {
        return { text: `park: cannot read the session's folder or clock: ${reason(err)}. Nothing written.` }
      }
      const resolved = resolveLot(lot, scope, cwd)
      if ('error' in resolved) {
        return { text: `park: ${resolved.error}. Fix it under /config, park, Parking lot file. Nothing written.` }
      }
      const path = resolved.path
      const project = basename(cwd) || cwd
      const doing =
        !includeLastPrompt ? '' :
        lastPrompt === '' ? ' before any prompt this session' :
        ` while working on "${lastPrompt}"`

      let existing = HEADER
      let exists = false
      try {
        exists = await $.fs.exists(path)
      } catch (err) {
        return { text: `park: cannot check ${path}: ${reason(err)}. Nothing written.` }
      }
      if (exists) {
        try {
          existing = await $.fs.read(path)
        } catch (err) {
          // A read that fails (over 4 MiB, unreadable) must never turn into an overwrite.
          return {
            text:
              `park: cannot read ${path}: ${reason(err)}. Nothing written. ` +
              'If the file has grown past 4 MiB, move it aside or point the setting at a new file.',
          }
        }
        if (looksBinary(existing)) {
          return {
            text:
              `park: ${path} contains a NUL or U+FFFD character, so it is binary or not UTF-8. ` +
              'Re-save it as UTF-8 (or remove the \uFFFD characters), or point the setting at another file. Nothing written.',
          }
        }
        if (existing === '') existing = HEADER
      }

      const eol = existing.includes('\r\n') ? '\r\n' : '\n'
      const entry =
        `${eol}## ${date}: ${oneLine(idea, IDEA_HEADING)}${eol}` +
        `**What:** ${idea}${eol}` +
        `**Why it came up:** parked with /park from \`${project}\`${doing}${eol}` +
        `**First action:** (fill in when revived)${eol}`
      const body = existing.endsWith('\n') ? existing : existing + eol

      try {
        await $.fs.write(path, body + entry)
      } catch (err) {
        return { text: `park: cannot write ${path}: ${reason(err)}. Nothing written.` }
      }

      $.ui.toast('Parked.')
      return { text: `Parked: ${oneLine(idea, IDEA_ECHO)}\nLogged to ${path} under ${date}.` }
    }

    const mine = queue.then(run, run)
    queue = mine.catch(() => undefined)
    return mine
  })
}
