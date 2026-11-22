import { expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'

import { age, bandRows, fromTodoRow, groups, importRows, injectText, merge, moreLabel, newId, parseAdd, parseTasks, projectKeys, rowParts, serialise, withNote, withStatus } from './tm'
import type { Task } from '../types'

const T0 = Date.parse('2026-10-05T12:00:00.000Z')
const at = (min: number) => new Date(T0 + min * 60_000).toISOString()

const task = (id: string, extra: Partial<Task> = {}): Task => ({
  id, title: `task ${id}`, status: 'todo', check: null, next: null, decisions: [], parent: null, after: [], waits_on: null, owner: null,
  found: false, harness_id: null, area: null, evidence: null, created: at(0), updated: at(0), closed: null, ...extra,
})

// --- Pure helpers ---

test('newId: four hex characters, none repeated', () => {
  const seen = new Set<string>()
  for (let i = 0; i < 300; i++) {
    const id = newId(seen)
    expect(id).toMatch(/^[0-9a-f]{4}$/)
    expect(seen.has(id)).toBe(false)
    seen.add(id)
  }
})

test('parseTasks and serialise: round trip; a line that is not a task is left out; missing fields default', () => {
  const a = task('a1b2', { title: 'one', check: 'it runs', decisions: [{ at: at(1), text: 'chose x' }] })
  const text = serialise([a, task('c3d4')])
  expect(text.split('\n').length).toBe(3)
  expect(parseTasks(text)).toEqual([a, task('c3d4')])
  expect(serialise([])).toBe('')
  const lax = parseTasks(['not json', '{"id":"zz99"}', '{"id":"e5f6","title":"bare","status":"weird"}', '', '[1]'].join('\n'))
  expect(lax.map(t => t.id)).toEqual(['e5f6'])
  expect(lax[0]).toMatchObject({ status: 'todo', check: null, after: [], decisions: [], found: false, closed: null })
})

test('merge: the newer updated wins; a task only the disk has stays; mine only is added', () => {
  const disk = [task('a1b2', { title: 'disk', updated: at(5) }), task('c3d4', { title: 'disk', updated: at(1) }), task('e5f6')]
  const mine = [task('a1b2', { title: 'mine', updated: at(2) }), task('c3d4', { title: 'mine', updated: at(2) }), task('0a0a')]
  const out = merge(disk, mine)
  expect(out.map(t => t.id)).toEqual(['a1b2', 'c3d4', 'e5f6', '0a0a'])
  expect(out.map(t => t.title)).toEqual(['disk', 'mine', 'task e5f6', 'task 0a0a'])
})

test('groups: ready needs todo, nothing waited on, every after done; ready is oldest first', () => {
  const g = groups([
    task('aaaa', { status: 'done', closed: at(3) }),
    task('bbbb', { after: ['aaaa'], created: at(9) }),
    task('cccc', { after: ['dddd'] }),
    task('dddd', { created: at(5) }),
    task('eeee', { after: ['gone'], created: at(2) }),
    task('ffff', { status: 'doing' }),
    task('1111', { waits_on: 'user', status: 'blocked' }),
    task('2222', { waits_on: 'the vendor' }),
    task('3333', { status: 'blocked' }),
    task('4444', { status: 'done', closed: at(8) }),
  ])
  expect(g.ready.map(t => t.id)).toEqual(['eeee', 'dddd', 'bbbb'])
  expect(g.doing.map(t => t.id)).toEqual(['ffff'])
  expect(g.needsYou.map(t => t.id)).toEqual(['1111'])
  expect(g.blocked.map(t => t.id).sort()).toEqual(['2222', '3333', 'cccc'])
  expect(g.done.map(t => t.id)).toEqual(['4444', 'aaaa'])
})

test('bandRows: all of 3 or 5; of 9 the first four and a +5 more row; doing, needs you, then ready', () => {
  const many = (n: number) => groups(Array.from({ length: n }, (_, i) => task(`000${i}`, { created: at(i) })))
  expect(bandRows(many(3)).length).toBe(3)
  expect(bandRows(many(5)).length).toBe(5)
  const nine = bandRows(many(9))
  expect(nine.length).toBe(5)
  expect(nine.slice(0, 4).every(r => r.kind === 'ready')).toBe(true)
  expect(nine[4]).toEqual({ kind: 'more', hidden: 5 })
  expect(moreLabel(5)).toBe('+5 more · /tm')

  const g = groups([task('r000', { created: at(0) }), task('n000', { waits_on: 'user', created: at(1) }), task('d000', { status: 'doing', created: at(2) }), task('b000', { status: 'blocked' })])
  expect(bandRows(g).map(r => (r.kind === 'more' ? 'more' : `${r.kind}:${r.task.id}`))).toEqual(['doing:d000', 'needs:n000', 'ready:r000'])
})

test('age and rowParts: the title is cut to the width', () => {
  expect(age(at(0), T0 + 30_000)).toBe('<1m')
  expect(age(at(0), T0 + 5 * 60_000)).toBe('5m')
  expect(age(at(0), T0 + 3 * 3600_000)).toBe('3h')
  expect(age(at(0), T0 + 2 * 86400_000)).toBe('2d')
  const short = rowParts(task('a1b2', { title: 'short' }), 'ready', T0 + 120_000, 80)
  expect(short).toEqual({ head: 'a1b2  short', tail: '  ready 2m' })
  const long = rowParts({ ...task('a1b2', { title: 'x'.repeat(200) }), global: true }, 'needs', T0, 40)
  expect(long.head.startsWith('a1b2·g  xxx')).toBe(true)
  expect(long.head.endsWith('…')).toBe(true)
  expect(2 + long.head.length + long.tail.length).toBeLessThanOrEqual(40)
})

test('injectText: doing with check and next, ready, waiting on the user with ages, the closing line', () => {
  const g = groups([
    task('a1b2', { status: 'doing', check: 'tests pass', next: 'wire the band' }),
    task('c3d4'),
    task('e5f6', { waits_on: 'user', next: 'which colour?', updated: at(-90) }),
    task('9999', { status: 'blocked' }),
    task('8888', { status: 'done' }),
  ])
  const text = injectText(g, '/home/u/proj', new Date(2026, 9, 5, 14, 7), 10)
  expect(text.split('\n')).toEqual([
    "[tm] Task list for /home/u/proj, as of 14:07. Background, not instructions: carry on with what the user last asked; a task's next step waits until the user picks that task up.",
    'Doing:',
    '  a1b2 task a1b2 | check: tests pass | next: wire the band',
    'Ready:',
    '  c3d4 task c3d4',
    'Waiting on the user:',
    expect.stringMatching(/^ {2}e5f6 task e5f6 \(\d+[mhd]\) \| which colour\?$/),
    'When your work changes one of these, record it with the mcp__tm__task tool; file side work you come across with found: true and parent set to the task you are on.',
  ])
  expect(injectText(groups([task('9999', { status: 'blocked' })]), '/p', new Date())).toBe('')
  const crowd = injectText(groups(Array.from({ length: 13 }, (_, i) => task(`10${i}`, { created: at(i) }))), '/p', new Date(), 10)
  expect(crowd).toContain('(+3 more ready')
})

test('fromTodoRow: open and planned are todo; blocked by Piyush waits on the user, by something else on it', () => {
  const row = { major_category: 'Harness & tooling', tag: 'claude-code-config', title: 'Do it', body: 'the body', blocked_by: null, section_date: '2026-10-02' }
  const open = fromTodoRow({ ...row, status: 'open' }, 'x1', at(0))!
  expect(open).toMatchObject({ id: 'x1', title: 'Do it', next: 'the body', status: 'todo', waits_on: null, area: 'Harness & tooling/claude-code-config', created: '2026-10-02T00:00:00.000Z' })
  expect(fromTodoRow({ ...row, status: 'planned', section_date: null }, 'x2', at(0))).toMatchObject({ status: 'todo', created: at(0) })
  expect(fromTodoRow({ ...row, status: 'blocked', blocked_by: 'Piyush' }, 'x3', at(0))).toMatchObject({ status: 'blocked', waits_on: 'user' })
  expect(fromTodoRow({ ...row, status: 'blocked', blocked_by: 'Piyush: returning to it' }, 'x4', at(0))).toMatchObject({ waits_on: 'user' })
  expect(fromTodoRow({ ...row, status: 'blocked', blocked_by: 'the vendor' }, 'x5', at(0))).toMatchObject({ status: 'blocked', waits_on: 'the vendor' })
  expect(fromTodoRow({ ...row, status: 'blocked', blocked_by: null }, 'x6', at(0))).toMatchObject({ status: 'blocked', waits_on: null })
  expect(fromTodoRow({ _meta: true, schema_version: 1 } as never, 'x7', at(0))).toBe(null)
  expect(fromTodoRow({ ...row, status: 'done' }, 'x8', at(0))).toBe(null)
  expect(fromTodoRow({ ...row, status: 'open', title: ' ' }, 'x9', at(0))).toBe(null)
})

const TODO = [
  '{"_meta": true, "schema_version": 1, "purpose": "Global work list"}',
  '{"major_category": "Harness & tooling", "tag": "claude-code-config", "status": "blocked", "title": "Confirm the gate", "body": "Piyush to confirm", "blocked_by": "Piyush", "section_title": "D1", "section_date": null, "source_file": "Knowledge/TODO.md"}',
  '{"major_category": "Harness & tooling", "tag": "orchestrator", "status": "open", "title": "Build the workflow", "body": "Raised 2026-10-02", "blocked_by": null, "section_title": null, "section_date": "2026-10-02"}',
  '{"major_category": "Harness & tooling", "tag": "claude-code-config", "status": "open", "title": "Shortcuts: what should they do?", "body": "can we add shortcuts?", "blocked_by": "Piyush: what the shortcuts do", "section_title": "S", "section_date": "2026-10-05"}',
].join('\n')

test('importRows: the three rows, _meta skipped; a title already there skipped; a blocked_by on an open row flagged', () => {
  const first = importRows(TODO, [], at(0), [])
  expect(first.tasks.map(t => [t.title, t.status, t.waits_on])).toEqual([
    ['Confirm the gate', 'blocked', 'user'],
    ['Build the workflow', 'todo', null],
    ['Shortcuts: what should they do?', 'todo', null],
  ])
  expect(new Set(first.tasks.map(t => t.id)).size).toBe(3)
  expect(first.skipped).toBe(0)
  expect(first.unmapped).toEqual([])
  expect(first.flagged.length).toBe(1)
  expect(first.flagged[0]).toContain('Shortcuts')

  const again = importRows(`${TODO}\n{"status":"open","title":"no category row"}\nnot json\n{"status":"done","title":"odd"}`, first.tasks, at(0), first.tasks.map(t => t.id))
  expect(again.skipped).toBe(3)
  expect(again.tasks.map(t => t.title)).toEqual(['no category row'])
  expect(again.unmapped).toEqual(['line 6: not JSON', 'line 7: "odd" has status done'])
})

test('parseAdd: title, --global, --check and --after, quotes keep words together', () => {
  expect(parseAdd('try tm --check "band shows it"')).toEqual({ title: 'try tm', global: false, check: 'band shows it', after: [] })
  expect(parseAdd('--global fix the thing --after A1B2,c3d4 --check it passes')).toEqual({ title: 'fix the thing', global: true, check: 'it passes', after: ['a1b2', 'c3d4'] })
  expect(parseAdd('').title).toBe('')
})

test('projectKeys: the engine encoding, then the older ones', () => {
  expect(projectKeys('/home/u/Source')).toEqual(['-home-u-Source'])
  expect(projectKeys('/home/u/a_b/.c')).toEqual(['-home-u-a-b--c', '-home-u-a_b--c', '-home-u-a_b-.c'])
})

test('withStatus: done stamps closed and evidence; doing and todo end a wait; blocked keeps it; reopening clears closed', () => {
  const t = task('a1b2', { waits_on: 'user' })
  expect(withStatus(t, 'done', at(1), 'ran it')).toMatchObject({ status: 'done', closed: at(1), evidence: 'ran it', waits_on: null })
  expect(withStatus(t, 'doing', at(1))).toMatchObject({ status: 'doing', waits_on: null, closed: null })
  expect(withStatus(t, 'blocked', at(1))).toMatchObject({ status: 'blocked', waits_on: 'user' })
  expect(withStatus(task('a1b2', { status: 'done', closed: at(1), evidence: 'e' }), 'todo', at(2))).toMatchObject({ status: 'todo', closed: null })
})

const msg = (text: string) => ({ role: 'user' as const, text, toolUses: [] })
const OM = 'Notes the om observer recorded earlier in this session, kept word for word across compaction.\n- [high] note'

test('withNote: right after the summary, and after om\'s note when it is there', () => {
  const rest = [msg('kept 1'), msg('kept 2')]
  expect(withNote([msg('summary'), ...rest], 'TM').map(m => m.text)).toEqual(['summary', 'TM', 'kept 1', 'kept 2'])
  expect(withNote([msg('summary'), msg(OM), ...rest], 'TM').map(m => m.text.slice(0, 5))).toEqual(['summa', 'Notes', 'TM', 'kept ', 'kept '])
  expect(withNote([msg(OM), ...rest], 'TM').map(m => m.text.slice(0, 5))).toEqual(['Notes', 'TM', 'kept ', 'kept '])
  expect(withNote([], 'TM').map(m => m.text)).toEqual(['TM'])
})

// --- With the engine faked ---
// The kit has no `$.session.append`, so `append` logs the note instead; those are asserted on the logs.

const PROJECT = '/home/u/.claude/projects/-home-u-proj/mods/tm/tasks.jsonl'
const GLOBAL = '/home/u/.claude/mods/tm/tasks.jsonl'

type Fake = { files: Map<string, string>; store: Map<string, unknown>; logs: string[]; opened: unknown[]; messages: { role: string; text: string; toolUses: never[] }[]; registered: string[] }

function fakeEngine(on: On, files: Record<string, string> = {}): Fake & { clock: ReturnType<typeof mock.clock> } {
  const f: Fake = { files: new Map(Object.entries(files)), store: new Map(), logs: [], opened: [], messages: [], registered: [] }
  const clock = mock.clock(on, { now: T0 })
  mock.env(on, { HOME: '/home/u' })
  on('store.get', (_$, e) => ({ value: f.store.get((e as { key: string }).key) }) as never)
  on('store.set', (_$, e) => {
    const { key, value } = e as { key: string; value: unknown }
    f.store.set(key, value)
    return { value: undefined } as never
  })
  on('session.id', () => ({ value: 's1' }) as never)
  on('session.root', () => ({ value: '/home/u/proj/worktrees/feat' }) as never)
  on('session.messages', () => ({ value: f.messages }) as never)
  on('fs.exists', (_$, e) => ({ value: ['/home/u/proj/worktrees', '/home/u/.claude/projects/-home-u-proj'].includes((e as { path: string }).path) || f.files.has((e as { path: string }).path) }) as never)
  on('fs.read', (_$, e) => ({ value: f.files.get((e as { path: string }).path) ?? '' }) as never)
  on('fs.write', (_$, e) => {
    const { path, text } = e as { path: string; text: string }
    f.files.set(path, text)
    return { value: undefined } as never
  })
  on('tool.register', (_$, e) => {
    f.registered.push(`tool ${(e as { name: string }).name}`)
    return { value: { tool: `mcp__tm__${(e as { name: string }).name}` } } as never
  })
  on('command.register', (_$, e) => {
    f.registered.push(`command ${(e as { name: string }).name}`)
    return { value: { command: (e as { name: string }).name } } as never
  })
  // What the engine draws in the band beneath tm's rows.
  on('ui.render', { component: 'AbovePrompt' }, () => ({ type: 'Text', props: {}, children: ["the engine's own band"] }) as never)
  on('ui.open', (_$, e) => {
    f.opened.push(e)
    return { value: { isPlaced: true } } as never
  })
  on('ui.log', (_$, e) => {
    f.logs.push(JSON.stringify(e))
    return { value: undefined } as never
  })
  on('session.start', (_$, e) => ({ cwd: (e as { cwd: string }).cwd }) as never)
  return Object.assign(f, { clock })
}

const START = { cwd: '/home/u/proj/worktrees/feat', surface: 'terminal', isInteractive: true } as never
const tasksOf = (f: Fake, path = PROJECT) => parseTasks(f.files.get(path) ?? '')
const say = async ($: { command: { run: (a: never) => Promise<unknown> } }, command: string, args = '') => JSON.stringify(await $.command.run({ command, args } as never))

test('the tool: add, found with its parent, ask, and ids that do not clash', async ($, on) => {
  const f = fakeEngine(on)
  const r1 = JSON.stringify(await $.tool.call({ tool: 'mcp__tm__task', add: 'write the thing', check: 'tests pass' } as never))
  expect(r1).toContain('filed')
  const [a] = tasksOf(f)
  expect(a).toMatchObject({ title: 'write the thing', check: 'tests pass', status: 'todo', found: false, parent: null })

  const r2 = JSON.stringify(await $.tool.call({ tool: 'mcp__tm__task', add: 'fix the typo', found: true, parent: a!.id } as never))
  expect(r2).toContain(`carry on with ${a!.id}`)
  expect(tasksOf(f)[1]).toMatchObject({ found: true, parent: a!.id, status: 'todo' })

  const r3 = JSON.stringify(await $.tool.call({ tool: 'mcp__tm__task', add: 'bad parent', parent: 'zzzz' } as never))
  expect(r3).toContain('no task zzzz')
  expect(tasksOf(f).length).toBe(2)

  await $.tool.call({ tool: 'mcp__tm__task', ask: 'which colour?', why: 'blue or green' } as never)
  expect(tasksOf(f)[2]).toMatchObject({ title: 'which colour?', waits_on: 'user', next: 'blue or green' })

  await $.tool.call({ tool: 'mcp__tm__task', add: 'a global one', global: true } as never)
  expect(tasksOf(f, GLOBAL).map(t => t.title)).toEqual(['a global one'])
  expect(new Set([...tasksOf(f), ...tasksOf(f, GLOBAL)].map(t => t.id)).size).toBe(4)
})

test('the tool: update next, decision, owner; a check cannot be changed; done needs evidence', async ($, on) => {
  const f = fakeEngine(on)
  await $.tool.call({ tool: 'mcp__tm__task', add: 'checked task', check: 'the band shows it' } as never)
  await $.tool.call({ tool: 'mcp__tm__task', add: 'plain task' } as never)
  const [a, b] = tasksOf(f)

  // The owner defaults to the session, or to the calling agent.
  await $.tool.call({ tool: 'mcp__tm__task', id: a!.id, status: 'doing', next: 'start with the pure parts', decision: 'no tags' } as never)
  expect(tasksOf(f)[0]).toMatchObject({ status: 'doing', next: 'start with the pure parts', owner: 's1', decisions: [{ at: expect.any(String), text: 'no tags' }] })
  await $.tool.call({ tool: 'mcp__tm__task', id: b!.id, status: 'doing', agentId: 'agent-7' } as never)
  expect(tasksOf(f)[1]!.owner).toBe('agent-7')

  const locked = JSON.stringify(await $.tool.call({ tool: 'mcp__tm__task', id: a!.id, check: 'something easier' } as never))
  expect(locked).toContain('only the person changes')
  expect(tasksOf(f)[0]!.check).toBe('the band shows it')

  const refused = JSON.stringify(await $.tool.call({ tool: 'mcp__tm__task', id: a!.id, status: 'done' } as never))
  expect(refused).toContain('needs evidence')
  expect(refused).toContain('the band shows it')
  expect(tasksOf(f)[0]!.status).toBe('doing')

  await $.tool.call({ tool: 'mcp__tm__task', id: a!.id, status: 'done', evidence: 'saw 3 rows in the band' } as never)
  expect(tasksOf(f)[0]).toMatchObject({ status: 'done', evidence: 'saw 3 rows in the band', closed: expect.any(String) })

  // A task with no check gets its check from the model once; then it is locked too.
  await $.tool.call({ tool: 'mcp__tm__task', id: b!.id, check: 'it works' } as never)
  expect(tasksOf(f)[1]!.check).toBe('it works')
  expect(JSON.stringify(await $.tool.call({ tool: 'mcp__tm__task', id: 'nope' } as never))).toContain('no task nope')

  const list = JSON.stringify(await $.tool.call({ tool: 'mcp__tm__task', list: true } as never))
  expect(list).toContain('[tm] Task list for /home/u/proj')
  expect(list).toContain(b!.id)
})

test('writes merge with what another session wrote meanwhile', async ($, on) => {
  const f = fakeEngine(on)
  await $.tool.call({ tool: 'mcp__tm__task', add: 'mine' } as never)
  f.files.set(PROJECT, f.files.get(PROJECT)! + serialise([task('beef', { title: 'theirs' })]))
  await $.tool.call({ tool: 'mcp__tm__task', add: 'mine too' } as never)
  expect(tasksOf(f).map(t => t.title)).toEqual(['mine', 'theirs', 'mine too'])
})

test('built-in TaskCreate and TaskUpdate are mirrored; the engine\'s own result passes through', async ($, on) => {
  const f = fakeEngine(on)
  let n = 0
  on('tool.call', { tool: 'TaskCreate' }, (_$, e) => ({ result: { task: { id: String(++n), subject: (e as { subject: string }).subject } } }) as never)
  on('tool.call', { tool: 'TaskUpdate' }, (_$, e) => ({ result: { success: true, taskId: (e as { taskId: string }).taskId, updatedFields: ['status'] } }) as never)

  const made = await $.tool.call({ tool: 'TaskCreate', subject: 'Build the band', description: 'draw 5 rows' } as never)
  expect(JSON.stringify(made)).toContain('"subject":"Build the band"')
  await $.tool.call({ tool: 'TaskCreate', subject: 'Test it', description: 'all green' } as never)
  expect(tasksOf(f)).toMatchObject([
    { title: 'Build the band', next: 'draw 5 rows', harness_id: '1', owner: 's1', status: 'todo' },
    { title: 'Test it', next: 'all green', harness_id: '2', owner: 's1' },
  ])

  await $.tool.call({ tool: 'TaskUpdate', taskId: '1', status: 'in_progress' } as never)
  expect(tasksOf(f)[0]!.status).toBe('doing')
  await $.tool.call({ tool: 'TaskUpdate', taskId: '2', addBlockedBy: ['1', '9'], subject: 'Test it well' } as never)
  const [one, two] = tasksOf(f)
  expect(two).toMatchObject({ title: 'Test it well', after: [one!.id] })
  await $.tool.call({ tool: 'TaskUpdate', taskId: '1', status: 'completed' } as never)
  expect(tasksOf(f)[0]).toMatchObject({ status: 'done', evidence: 'built-in task completed' })

  // Deleted: removed, but only a mirrored one; a task with another owner and the same built-in id is left.
  f.files.set(PROJECT, f.files.get(PROJECT)! + serialise([task('beef', { harness_id: '3', owner: 'other-session' })]))
  await $.tool.call({ tool: 'TaskUpdate', taskId: '3', status: 'deleted' } as never)
  expect(tasksOf(f).map(t => t.id)).toContain('beef')
  await $.tool.call({ tool: 'TaskUpdate', taskId: '2', status: 'deleted' } as never)
  expect(tasksOf(f).map(t => t.id)).toEqual([one!.id, 'beef'])
})

test('a failed TaskUpdate is not mirrored', async ($, on) => {
  const f = fakeEngine(on)
  on('tool.call', { tool: 'TaskCreate' }, () => ({ result: { task: { id: '1', subject: 'x' } } }) as never)
  on('tool.call', { tool: 'TaskUpdate' }, () => ({ result: { success: false, taskId: '1', updatedFields: [], error: 'no' } }) as never)
  await $.tool.call({ tool: 'TaskCreate', subject: 'x', description: 'd' } as never)
  await $.tool.call({ tool: 'TaskUpdate', taskId: '1', status: 'completed' } as never)
  expect(tasksOf(f)[0]!.status).toBe('todo')
})

test('/tm:add, /tm:next, /tm:done refused then forced, /tm:block, /tm:note, /tm:list', async ($, on) => {
  const f = fakeEngine(on)
  expect(await say($, 'tm:add', 'try tm --check "band shows it"')).toContain('Added')
  const [a] = tasksOf(f)
  expect(a).toMatchObject({ title: 'try tm', check: 'band shows it' })
  expect(await say($, 'tm:add', 'second --after zzzz')).toContain('No task zzzz')
  expect(await say($, 'tm:add', 'second --after ' + a!.id)).toContain('Added')
  expect(await say($, 'tm:add', 'a global --global')).toContain('·g')
  expect(await say($, 'tm:add', '')).toContain('Usage')

  const next = await say($, 'tm:next')
  expect(next).toContain(`Next: ${a!.id} try tm`)
  expect(next).toContain('check: band shows it')

  expect(await say($, 'tm:done', a!.id)).toContain('has a check')
  expect(tasksOf(f)[0]!.status).toBe('todo')
  expect(await say($, 'tm:done', `${a!.id} force`)).toContain('Done')
  expect(tasksOf(f)[0]).toMatchObject({ status: 'done', evidence: 'forced by the user' })
  expect(await say($, 'tm:done', a!.id)).toContain('already done')
  const [, second] = tasksOf(f)
  expect(await say($, 'tm:done', `${second!.id} looked fine`)).toContain('Done')
  expect(tasksOf(f)[1]).toMatchObject({ status: 'done', evidence: 'looked fine' })

  const [, , glob] = [...tasksOf(f), ...tasksOf(f, GLOBAL)]
  expect(await say($, 'tm:block', `${glob!.id} me: pick a name`)).toContain('waiting on you')
  expect(tasksOf(f, GLOBAL)[0]).toMatchObject({ status: 'blocked', waits_on: 'user', next: 'pick a name' })
  expect(await say($, 'tm:block', `${glob!.id} the vendor`)).toContain('waiting on the vendor')
  expect(tasksOf(f, GLOBAL)[0]).toMatchObject({ waits_on: 'the vendor' })
  expect(await say($, 'tm:note', `${glob!.id} call them`)).toContain('next step set')
  expect(await say($, 'tm:note', `${glob!.id} decision: use blue`)).toContain('decision logged')
  expect(tasksOf(f, GLOBAL)[0]).toMatchObject({ next: 'call them', decisions: [{ at: expect.any(String), text: 'use blue' }] })
  expect(await say($, 'tm:note', 'nope text')).toContain('No task nope')

  const list = await say($, 'tm:list')
  expect(list).toContain('Blocked (1)')
  expect(list).toContain('Done (2): /tm:list all')
  expect(await say($, 'tm:list', 'all')).toContain('Done (2)\\n')
  expect(await say($, 'tm:next')).toContain('Nothing ready')
})

test('/tm:import: the 3-row fixture into the global list; a second run adds nothing', async ($, on) => {
  const f = fakeEngine(on, { '/home/u/TODO.jsonl': TODO })
  const out = await say($, 'tm:import', '~/TODO.jsonl')
  expect(out).toContain('Imported 3 into the global list; 0 already there.')
  expect(out).toContain('Open or planned with a blocked_by, imported as todo (1)')
  expect(tasksOf(f, GLOBAL).map(t => t.status)).toEqual(['blocked', 'todo', 'todo'])
  expect(tasksOf(f).length).toBe(0)
  expect(await say($, 'tm:import', '~/TODO.jsonl')).toContain('Imported 0 into the global list; 3 already there.')
  expect(await say($, 'tm:import', '~/missing')).toContain('Imported 0')
  expect(await say($, 'tm:import', '')).toContain('Usage')
})

test('session start loads the list, the timer shows another session\'s changes; /tm opens the pane', async ($, on) => {
  const f = fakeEngine(on, { [PROJECT]: serialise([task('a1b2')]) })
  await $.session.start(START)
  const open = await $.ui.mount({ plugin: 'tm', surface: 'terminal', component: 'AbovePrompt', props: BAND })
  expect(await open.find({ key: 'row:a1b2' })).toBeDefined()
  expect(await open.find({ key: 'row:c3d4' })).toBeUndefined()

  f.files.set(PROJECT, serialise([task('a1b2'), task('c3d4')]))
  await f.clock.advance(5000)
  expect(await open.find({ key: 'row:c3d4' })).toBeDefined()
  await open.unmount()

  await $.command.run({ command: 'tm', args: '' } as never)
  expect(f.opened).toMatchObject([{ id: 'tm', title: 'tm' }])
})

const BAND = { hasSurvey: false, isWorking: false, maxRows: 12, bodyColumns: 70, scroll: { offset: 0, bodyRows: 12 }, view: {} } as const

test('the band: five rows as Buttons, the fifth +N more of nine; nothing with no open tasks or a survey', async ($, on) => {
  const nine = Array.from({ length: 9 }, (_, i) => task(`000${i}`, { created: at(i), title: `task number ${i}` }))
  const f = fakeEngine(on, { [PROJECT]: serialise(nine) })
  await $.session.start(START)
  const ui = await $.ui.mount({ plugin: 'tm', surface: 'terminal', component: 'AbovePrompt', props: BAND })
  for (const i of [0, 1, 2, 3]) expect(await ui.find({ key: `row:000${i}` })).toBeDefined()
  expect(await ui.find({ key: 'row:0004' })).toBeUndefined()
  expect((await ui.find({ key: 'more' }))?.text).toBe('+5 more · /tm')

  // Pressing a row opens the pane on that task.
  await ui.press({ key: 'row:0002' })
  expect(f.opened).toMatchObject([{ id: 'tm' }])
  await ui.unmount()

  const survey = await $.ui.mount({ plugin: 'tm', surface: 'terminal', component: 'AbovePrompt', props: { ...BAND, hasSurvey: true } })
  expect(await survey.find({ key: 'row:0000' })).toBeUndefined()
  await survey.unmount()
})

test('the band draws nothing of its own with only blocked or done tasks', async ($, on) => {
  fakeEngine(on, { [PROJECT]: serialise([task('a1b2', { status: 'blocked' }), task('c3d4', { status: 'done' })]) })
  await $.session.start(START)
  const ui = await $.ui.mount({ plugin: 'tm', surface: 'terminal', component: 'AbovePrompt', props: BAND })
  expect(await ui.find({ type: 'Button' })).toBeUndefined()
  await ui.unmount()
})

test('the pane: groups, a task in full with its check, Back', async ($, on) => {
  fakeEngine(on, { [PROJECT]: serialise([task('a1b2', { status: 'doing', check: 'it shows', next: 'step', decisions: [{ at: at(0), text: 'chose y' }] }), task('c3d4', { parent: 'a1b2', found: true }), task('e5f6', { status: 'done' })]), [GLOBAL]: serialise([task('9999', { waits_on: 'user' })]) })
  await $.session.start(START)
  const props = { title: 'tm', isFocused: true, bodyColumns: 70, placement: 'inline', scroll: { offset: 0, bodyRows: 16 }, view: {} } as const
  const ui = await $.ui.mount({ plugin: 'tm', surface: 'terminal', component: 'Pane', props, requestId: 'tm' })
  expect(await ui.find({ key: 'row:a1b2' })).toBeDefined()
  expect((await ui.find({ key: 'row:9999' }))?.text).toContain('9999·g')
  expect(await ui.find({ type: 'Text', text: /Done \(1\)/ })).toBeDefined()

  await ui.press({ key: 'row:a1b2' })
  expect(await ui.find({ type: 'Text', text: /🔒 check: it shows/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /chose y/ })).toBeDefined()
  expect(await ui.find({ key: 'row:c3d4' })).toBeDefined()
  await ui.press({ key: 'back' })
  expect(await ui.find({ key: 'row:9999' })).toBeDefined()
  await ui.unmount()
})

test('the pane: Done counts as forced; Doing and Todo end a wait', async ($, on) => {
  const f = fakeEngine(on, { [PROJECT]: serialise([task('a1b2', { waits_on: 'user', status: 'blocked' })]) })
  await $.session.start(START)
  const props = { title: 'tm', isFocused: true, bodyColumns: 70, placement: 'inline', scroll: { offset: 0, bodyRows: 16 }, view: {} } as const
  const ui = await $.ui.mount({ plugin: 'tm', surface: 'terminal', component: 'Pane', props, requestId: 'tm' })
  await ui.press({ key: 'row:a1b2' })
  await ui.press({ key: 'doing' })
  expect(tasksOf(f)[0]).toMatchObject({ status: 'doing', waits_on: null })
  await ui.press({ key: 'done' })
  expect(tasksOf(f)[0]).toMatchObject({ status: 'done', evidence: 'marked done by the user' })
  await ui.press({ key: 'todo' })
  expect(tasksOf(f)[0]).toMatchObject({ status: 'todo', closed: null })
  await ui.unmount()
})

test('compaction: the [tm] note right after the summary; after om\'s note when om put one; none with nothing open', async ($, on) => {
  fakeEngine(on, { [PROJECT]: serialise([task('a1b2', { status: 'doing', check: 'it shows' })]) })
  let beneath = [msg('summary'), msg('kept')]
  on('session.compact', () => ({ messages: beneath }) as never)

  const compact = async () => {
    const r = await $.session.compact({ trigger: 'auto', messages: [msg('old')] } as never)
    if ('skip' in r && r.skip !== undefined) throw new Error('skipped')
    return r.messages.map(m => m.text)
  }
  const plain = await compact()
  expect(plain.map(t => t.slice(0, 10))).toEqual(['summary', '[tm] Task ', 'kept'])
  expect(plain[1]).toContain('a1b2 task a1b2 | check: it shows')

  beneath = [msg('summary'), msg(OM), msg('kept')]
  expect((await compact()).map(t => t.slice(0, 10))).toEqual(['summary', 'Notes the ', '[tm] Task ', 'kept'])

  beneath = [msg(OM), msg('kept')]
  expect((await compact()).map(t => t.slice(0, 10))).toEqual(['Notes the ', '[tm] Task ', 'kept'])
})

test('compaction with no open task leaves the messages as they are', async ($, on) => {
  fakeEngine(on)
  on('session.compact', () => ({ messages: [msg('summary'), msg('kept')] }) as never)
  const r = await $.session.compact({ trigger: 'auto', messages: [msg('old')] } as never)
  if ('skip' in r && r.skip !== undefined) throw new Error('skipped')
  expect(r.messages.map(m => m.text)).toEqual(['summary', 'kept'])
})

test('resume: a session with messages is told the list once; a new one, or one already told, is not', async ($, on) => {
  const f = fakeEngine(on, { [PROJECT]: serialise([task('a1b2')]) })
  await $.session.start(START)
  expect(f.logs.join('\n')).not.toContain('could not append')

  f.messages.push(msg('earlier'))
  await $.session.start(START)
  expect(f.logs.at(-1)).toContain('could not append')
  expect(f.logs.at(-1)).toContain('[tm] Task list for /home/u/proj')

  f.logs.length = 0
  f.store.set('injected:s1', true)
  await $.session.start(START)
  expect(f.logs.join('\n')).not.toContain('could not append')
})

test('session start registers the tool and the /tm command', async ($, on) => {
  const f = fakeEngine(on)
  await $.session.start(START)
  expect(f.registered).toEqual(['tool task', 'command tm'])
})

const STATE = '/home/u/.claude/projects/-home-u-proj/mods/tm/state.json'
const bandShowsTask = async ($: Parameters<Parameters<typeof test>[1]>[0]) => {
  const props = { hasSurvey: false, maxRows: 5, bodyColumns: 80 }
  const ui = await $.ui.mount({ plugin: 'tm', surface: 'terminal', component: 'AbovePrompt', props } as never)
  const found = (await ui.find({ key: 'row:a1b2' })) !== undefined
  await ui.unmount()
  return found
}

test('off: no compaction note, no resume note, no band; on restores them; the switch is a file', async ($, on) => {
  const f = fakeEngine(on, { [PROJECT]: serialise([task('a1b2', { status: 'doing' })]) })
  on('session.compact', () => ({ messages: [msg('summary'), msg('kept')] }) as never)
  const compact = async () => {
    const r = await $.session.compact({ trigger: 'auto', messages: [msg('old')] } as never)
    if ('skip' in r && r.skip !== undefined) throw new Error('skipped')
    return r.messages.map(m => m.text)
  }
  const told: string[] = []
  on('session.append', (_$, e, next) => {
    told.push(JSON.stringify(e))
    return next(e)
  })
  f.messages.push(msg('earlier'))

  expect(await say($, 'tm:off')).toContain('tm is off')
  expect(f.files.get(STATE)).toBe('{"on":false}\n')
  expect(await compact()).toEqual(['summary', 'kept'])
  await $.session.start(START)
  expect(told).toEqual([])
  expect(f.store.has('injected:s1')).toBe(false)
  expect(await bandShowsTask($)).toBe(false)
  expect(await say($, 'tm:list')).toContain('tm is off')
  expect(await say($, 'tm')).toContain('tm is off')

  expect(await say($, 'tm:on')).toContain('tm is on')
  expect(f.files.get(STATE)).toBe('{"on":true}\n')
  expect((await compact()).map(t => t.slice(0, 10))).toEqual(['summary', '[tm] Task ', 'kept'])
  await $.session.start(START)
  expect(told.join('\n')).toContain('[tm] Task list')
  expect(await bandShowsTask($)).toBe(true)
  expect(await say($, 'tm:list')).not.toContain('tm is off')
})

test('off: the state is read from the file, so it outlasts a restart; no file or a broken one means on', async ($, on) => {
  const f = fakeEngine(on, { [STATE]: '{"on":false}\n', [PROJECT]: serialise([task('a1b2')]) })
  await $.session.start(START)
  expect(await say($, 'tm:list')).toContain('tm is off')
  expect(await bandShowsTask($)).toBe(false)

  f.files.set(STATE, 'not json')
  expect(await say($, 'tm:list')).not.toContain('tm is off')
  f.files.delete(STATE)
  expect(await bandShowsTask($)).toBe(true)
})
