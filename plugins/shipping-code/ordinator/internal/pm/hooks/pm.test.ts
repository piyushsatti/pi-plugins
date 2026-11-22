import { expect, test } from 'claude-code/testing'
import type { On } from 'claude-code'

import { footerLabel, implementerMessage, parseConfig, parseSteps, planFileName, projectKeys, slugOf, titleOf, verdictOf } from './pm'

const PLAN = [
  '# Add CalVer to the mods',
  '',
  'Context: versions move off semver.',
  '',
  '1. Change plugin.json versions',
  '   - nested, not a step',
  '2. Run **claude plugin validate**',
  '3. Save the memory',
].join('\n')

test('parseSteps: top-level numbered items; else numbered headings; else none', () => {
  expect(parseSteps(PLAN)).toEqual(['Change plugin.json versions', 'Run claude plugin validate', 'Save the memory'])
  expect(parseSteps('# P\n### Step 1: read\n### Step 2: write')).toEqual(['read', 'write'])
  expect(parseSteps('# P\njust prose')).toEqual([])
})

test('titleOf, slugOf, planFileName: the heading; short words dropped; a ticket id wins over the date', () => {
  expect(titleOf(PLAN)).toBe('Add CalVer to the mods')
  expect(slugOf('Add CalVer to the mods')).toBe('add-calver-mods')
  expect(planFileName('2026-10-05', 'Add CalVer to the mods')).toBe('2026-10-05-add-calver-mods.md')
  expect(planFileName('2026-10-05', 'RE-556 pano integration')).toBe('RE-556-re-556-pano-integration.md')
})

test('projectKeys: the engine encoding, then the older ones', () => {
  expect(projectKeys('/home/u/Source')).toEqual(['-home-u-Source'])
  expect(projectKeys('/home/u/a_b/.c')).toEqual(['-home-u-a-b--c', '-home-u-a_b--c', '-home-u-a_b-.c'])
})

test('footerLabel: per phase, the count only when there are steps', () => {
  const f = { slug: 'calver', done: 2, total: 7, verdict: null }
  expect(footerLabel({ ...f, phase: 'implementing' })).toBe('pm ▸ calver 2/7')
  expect(footerLabel({ ...f, phase: 'briefing' })).toBe('pm ▸ calver briefing')
  expect(footerLabel({ ...f, phase: 'done', verdict: 'fail' })).toBe('pm ▸ calver 2/7 ✗')
  expect(footerLabel({ ...f, total: 0, phase: 'implementing' })).toBe('pm ▸ calver')
})

test('parseConfig and verdictOf', () => {
  expect(parseConfig('model opus effort HIGH verify off')).toEqual({ model: 'opus', effort: 'high', verify: false })
  expect(parseConfig('verify maybe').error).toContain('verify on|off')
  expect(verdictOf('all good\nVERDICT: PASS')).toBe('pass')
  expect(verdictOf('nope')).toBe(null)
})

test('implementerMessage: brief, plan and steps', () => {
  const m = implementerMessage({ title: 'T', brief: 'the brief', plan: PLAN, steps: ['a', 'b'], archived: '/p/artifacts/plans/x.md' })
  expect(m).toContain('the brief')
  expect(m).toContain('/p/artifacts/plans/x.md')
  expect(m).toContain('1. a\n2. b')
})

// --- The handoff, with the engine faked ---
// The test kit runs neither `$.agent.spawn` (its hook sees the Agent call's input and the answer carries no
// agent id) nor `$.session.append` (no implementation; pm logs the note instead). So the handoff is checked
// up to the spawn, and the later phases from a run put in the store as the spawn would have left it.

declare const setTimeout: (fn: () => void, ms: number) => unknown
const wait = (ms: number) => new Promise<void>(r => setTimeout(r, ms))
async function until(ok: () => boolean) {
  for (let i = 0; i < 100 && !ok(); i++) await wait(20)
}

type Fake = { store: Map<string, unknown>; files: Map<string, string>; logs: string[]; spawned: { subagent_type: string; prompt: string }[] }

function fakeEngine(on: On, enabled = true): Fake {
  const f: Fake = { store: new Map<string, unknown>([['enabled', enabled]]), files: new Map(), logs: [], spawned: [] }
  on('session.id', () => ({ value: 's1' }) as never)
  on('session.root', () => ({ value: '/home/u/proj/worktrees/feat' }) as never)
  on('store.get', (_$, e) => ({ value: f.store.get((e as { key: string }).key) }) as never)
  on('store.set', (_$, e) => {
    const { key, value } = e as { key: string; value: unknown }
    f.store.set(key, value)
    return { value: undefined } as never
  })
  on('env.get', (_$, e) => ({ value: (e as { name: string }).name === 'HOME' ? '/home/u' : undefined }) as never)
  on('fs.exists', (_$, e) => ({ value: ['/home/u/proj/worktrees', '/home/u/.claude/projects/-home-u-proj'].includes((e as { path: string }).path) }) as never)
  on('fs.write', (_$, e) => {
    const { path, text } = e as { path: string; text: string }
    f.files.set(path, text)
    return { value: undefined } as never
  })
  on('model.fork', () => ({ value: { isAnswered: true, text: 'BRIEF: user wants calver', usage: {} } }) as never)
  on('agent.spawn', (_$, e) => {
    f.spawned.push(e as unknown as Fake['spawned'][number])
    return { model: 'sonnet' } as never
  })
  on('ui.toast', () => ({ value: undefined }) as never)
  on('ui.log', (_$, e) => {
    f.logs.push(JSON.stringify(e))
    return { value: undefined } as never
  })
  on('tool.call', { tool: 'ExitPlanMode' }, () => ({ result: { plan: PLAN, isAgent: false, filePath: '/home/u/.claude/plans/p.md' } }) as never)
  on('turn.complete', () => ({ text: '' }) as never)
  return f
}

type RunView = { phase: string; agentId: string | null; verifierId: string | null; done: number[]; steps: string[]; notes: string[]; brief: string; archived: string; report: string; verdict: string; error: string }
const run = (f: Fake) => f.store.get('run:s1') as RunView
const TURN = { durationMs: 1, isAborted: false, turnId: 't', reason: 'answer' } as const

// A run as the handoff leaves it once the implementer is running.
function seed(f: Fake, extra: Partial<RunView> = {}) {
  f.store.set('run:s1', {
    title: 'Add CalVer to the mods', slug: 'add-calver-mods', plan: PLAN, planPath: null, archived: null, brief: 'b',
    agentId: 'impl-1', verifierId: null, steps: ['a', 'b', 'c'], done: [], phase: 'implementing',
    startedAt: '', report: null, verdict: null, error: null, notes: [], ...extra,
  })
}

test('approved plan, pm on: archived, briefed and spawned; main is told not to implement it', async ($, on) => {
  const f = fakeEngine(on)
  const r = await $.tool.call({ tool: 'ExitPlanMode' } as never)
  expect(JSON.stringify(r)).toContain('Do NOT implement it yourself')
  await until(() => f.spawned.length > 0 && run(f)?.phase !== 'briefing')
  expect(f.spawned[0]!.subagent_type).toBe('pm:implementer')
  expect(f.spawned[0]!.prompt).toContain('BRIEF: user wants calver')
  expect(f.spawned[0]!.prompt).toContain('1. Change plugin.json versions')
  expect(run(f).archived).toMatch(/^\/home\/u\/\.claude\/projects\/-home-u-proj\/mods\/pm\/plans\/\d{4}-\d\d-\d\d-add-calver-mods\.md$/)
  expect(f.files.get(run(f).archived)).toContain('# Add CalVer to the mods')
  // No agent id under the kit: the run fails and main is told so.
  expect(run(f).phase).toBe('failed')
  expect(f.logs.join('\n')).toContain('could not start (no agent id)')
})

test('approved plan, pm off: left to the main conversation, kept for /pm:send', async ($, on) => {
  const f = fakeEngine(on, false)
  const r = await $.tool.call({ tool: 'ExitPlanMode' } as never)
  expect(JSON.stringify(r)).not.toContain('[pm]')
  await wait(100)
  expect(f.spawned.length).toBe(0)
  expect((f.store.get('plan:s1') as { plan: string }).plan).toBe(PLAN)
  await $.command.run({ command: 'pm:send', args: '' } as never)
  await until(() => f.spawned.length > 0)
  expect(f.spawned.length).toBe(1)
})

test('a plan already running: the next one is not handed off', async ($, on) => {
  const f = fakeEngine(on)
  seed(f)
  const r = await $.tool.call({ tool: 'ExitPlanMode' } as never)
  expect(JSON.stringify(r)).toContain('was not handed off')
  await wait(100)
  expect(f.spawned.length).toBe(0)
})

test('steps from the implementer only', async ($, on) => {
  const f = fakeEngine(on)
  seed(f)
  await $.tool.call({ tool: 'mcp__pm__step', done: 1 } as never)
  await $.tool.call({ tool: 'mcp__pm__step', done: 1, agentId: 'other' } as never)
  expect(run(f).done).toEqual([])
  await $.tool.call({ tool: 'mcp__pm__step', done: 2, note: 'kept 2026.10.5', agentId: 'impl-1' } as never)
  expect(run(f).done).toEqual([2])
  expect(run(f).notes).toEqual(['kept 2026.10.5'])
})

test('implementer ends: the verifier is spawned with its report; verifier ends: both reports to main', async ($, on) => {
  const f = fakeEngine(on)
  seed(f)
  await $.turn.complete({ ...TURN, answer: 'did steps 1-3', agentId: 'impl-1' } as never)
  await until(() => f.spawned.length > 0)
  expect(f.spawned[0]!.subagent_type).toBe('pm:verifier')
  expect(f.spawned[0]!.prompt).toContain('did steps 1-3')

  seed(f, { phase: 'verifying', verifierId: 'ver-1', report: 'did steps 1-3' })
  await $.turn.complete({ ...TURN, answer: 'checked\nVERDICT: PASS', agentId: 'ver-1' } as never)
  await until(() => run(f).phase === 'done')
  const told = f.logs.at(-1)!
  expect(told).toContain('could not append to main')
  expect(told).toContain('has been implemented')
  expect(told).toContain('Verification: PASS')
  expect(told).toContain('did steps 1-3')
})

test('/pm:steer goes to the running agent; /pm:stop refuses its next tool call', async ($, on) => {
  const f = fakeEngine(on)
  seed(f)
  await $.command.run({ command: 'pm:steer', args: 'skip step 3' } as never)
  expect(f.logs.at(-1)).toContain('could not append to impl-1')
  expect(f.logs.at(-1)).toContain('[pm] From the user: skip step 3')
  await $.command.run({ command: 'pm:stop', args: '' } as never)
  expect(run(f).phase).toBe('stopped')
  const r = await $.tool.call({ tool: 'Bash', command: 'ls', agentId: 'impl-1' } as never)
  expect(JSON.stringify(r)).toContain('the user stopped this plan')
})

test('/pm:status and /pm:config', async ($, on) => {
  const f = fakeEngine(on, false)
  on('agent.register', () => ({ value: { agent: 'x' } }) as never)
  expect(JSON.stringify(await $.command.run({ command: 'pm:status', args: '' } as never))).toContain('pm off · implementer sonnet at high · verify on')
  await $.command.run({ command: 'pm:config', args: 'effort xhigh verify off' } as never)
  expect(f.store.get('effort')).toBe('xhigh')
  expect(f.store.get('verify')).toBe(false)
})
