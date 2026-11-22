// Harness for ticket-pr.js. Loads the workflow script as text, strips the meta literal (the
// sandbox only exposes the function body to the Workflow tool), and runs the body inside an
// AsyncFunction whose parameters match the sandbox globals. A mock agent() stands in for the
// Workflow tool's agent dispatch and record-writer persistence.
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import test from 'node:test'
import assert from 'node:assert/strict'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const scriptPath = path.join(__dirname, '..', 'workflows', 'ticket-pr.js')
const raw = readFileSync(scriptPath, 'utf8')

function stripMeta(src) {
  const startIdx = src.indexOf('export const meta')
  if (startIdx === -1) throw new Error('meta block not found')
  const lines = src.slice(startIdx).split('\n')
  let endLineIdx = -1
  for (let i = 0; i < lines.length; i++) {
    if (lines[i] === '}') { endLineIdx = i; break }
  }
  if (endLineIdx === -1) throw new Error('meta closing brace not found')
  return src.slice(0, startIdx) + lines.slice(endLineIdx + 1).join('\n')
}

const BODY = stripMeta(raw)
const loadWorkflow = () => new (async function () {}).constructor(
  'args', 'agent', 'phase', 'log', 'budget', 'parallel', 'pipeline', 'workflow', BODY,
)

const SESSION_DIR = '/tmp/session'
const baseArgs = () => ({
  ticket: 'PAT-301',
  worktree: '/tmp/worktree',
  branch: 'PAT-301-thing',
  sessionDir: SESSION_DIR,
  scopePath: `${SESSION_DIR}/scope.md`,
  hub: '/tmp/hub.md',
  reference: '/tmp/reference.md',
  rulebookDir: 'docs/standards',
  sources: [{ path: '/tmp/src.md', tag: 'settled', origin: 'ticket' }],
  startedAt: '2026-08-26T00:00:00Z',
})

const planFixture = files => ({
  summary: 'Implement the thing.',
  files,
  dataStores: [],
  errors: '',
  logging: '',
  tests: [],
  questions: [],
})
const sigFixtureFor = files => ({
  files: files.map(f => ({
    path: f.path,
    symbols: [{ signature: `def f_${f.path.replace(/\W/g, '_')}() -> None`, boundary: 'internal', raises: '', logs: '' }],
  })),
  questions: [],
})

function defaultFixtures() {
  return {
    'ordinator:plan-author': () => planFixture([{ path: 'src/thing.py', purpose: 'does the thing' }]),
    'ordinator:plan-signer': () => sigFixtureFor([{ path: 'src/thing.py' }]),
    'ordinator:plan-reviewer': () => ({ pass: true, findings: [] }),
    'ordinator:code-implementor': () => ({ commits: ['feat: thing'], testsPassed: true, testOutput: 'ok', questions: [] }),
    'ordinator:code-simplifier': () => 'style pass done, no changes',
    'ordinator:code-reviewer': () => ({ pass: true, findings: [] }),
    'ordinator:code-fixer': () => 'fixed',
    'ordinator:pr-author': () => ({ title: 'PAT-301: thing', body: 'body' }),
  }
}

function makeMockAgent({ fileMap, calls, overrides }) {
  const defaults = defaultFixtures()
  const counters = {}
  return async function agent(prompt, opts) {
    calls.push({ agentType: opts.agentType, label: opts.label, prompt })
    if (opts.agentType === 'ordinator:record-writer') {
      const m = /^MODE: (write|append)\nPATH: (.+)\n---\n([\s\S]*)$/.exec(prompt)
      if (!m) return 'BLOCKED: malformed request'
      const [, mode, filePath, content] = m
      if (mode === 'write' || !fileMap.has(filePath)) {
        fileMap.set(filePath, content)
        return `WROTE ${filePath}`
      }
      fileMap.set(filePath, fileMap.get(filePath).replace(/\n+$/, '') + '\n\n' + content)
      return `APPENDED ${filePath}`
    }
    counters[opts.label] = (counters[opts.label] ?? 0) + 1
    const pick = key => (key in overrides ? overrides[key] : undefined)
    const fixture = pick(opts.label) ?? pick(opts.agentType) ?? defaults[opts.agentType]
    if (fixture === undefined) throw new Error(`no fixture for agentType ${opts.agentType} (label ${opts.label})`)
    return typeof fixture === 'function' ? fixture(prompt, opts, counters[opts.label]) : fixture
  }
}

async function run(args, overrides = {}, fileMap = new Map()) {
  const calls = []
  const logs = []
  const phases = []
  const agent = makeMockAgent({ fileMap, calls, overrides })
  const phase = name => phases.push(name)
  const log = msg => logs.push(msg)
  const budget = { total: null, spent: () => 0, remaining: () => Infinity }
  const fn = loadWorkflow()
  const result = await fn(args, agent, phase, log, budget, undefined, undefined, undefined)
  return { result, fileMap, calls, logs, phases }
}

function checkpointsFrom(fileMap, sessionDir) {
  const prefix = `${sessionDir}/checkpoints/`
  const ck = {}
  for (const [filePath, content] of fileMap) {
    if (filePath.startsWith(prefix) && filePath.endsWith('.json')) {
      ck[filePath.slice(prefix.length, -'.json'.length)] = JSON.parse(content)
    }
  }
  return ck
}

test('1: cold run reaches the PlanGate with checkpoints and a readable plan.md', async () => {
  const { result, fileMap, calls } = await run(baseArgs())
  const nonWriter = calls.filter(c => c.agentType !== 'ordinator:record-writer')
  assert.deepEqual(nonWriter.slice(0, 3).map(c => c.agentType), ['ordinator:plan-author', 'ordinator:plan-signer', 'ordinator:plan-reviewer'])
  assert.equal(result.paused, 'PlanGate')
  assert.equal(result.ticket, 'PAT-301')
  for (const name of ['plan', 'signatures', 'planreview-r1', 'plan-final']) {
    assert.ok(fileMap.has(`${SESSION_DIR}/checkpoints/${name}.json`), `checkpoint ${name} was written`)
  }
  const planMd = fileMap.get(`${SESSION_DIR}/plan.md`)
  assert.ok(planMd, 'plan.md was written')
  const decisionsIdx = planMd.indexOf('## Decisions the plan took for you')
  const planIdx = planMd.indexOf('## Plan')
  assert.ok(decisionsIdx >= 0 && planIdx > decisionsIdx, 'decisions section precedes the plan section')
  const withoutDetails = planMd.replace(/<details>[\s\S]*?<\/details>/g, '')
  assert.ok(!withoutDetails.includes('```'), 'no fenced JSON survives outside <details>')
})

test('2: resume with checkpoints and planApproved skips the completed plan stages', async () => {
  const cold = await run(baseArgs())
  const checkpoints = checkpointsFrom(cold.fileMap, SESSION_DIR)
  const resumed = await run({ ...baseArgs(), checkpoints, planApproved: true })
  const planStageTypes = new Set(['ordinator:plan-author', 'ordinator:plan-signer', 'ordinator:plan-reviewer'])
  assert.equal(resumed.calls.filter(c => planStageTypes.has(c.agentType)).length, 0)
  assert.equal(resumed.calls[0].agentType, 'ordinator:code-implementor', 'first agent call of a fully restored run is the implementor, no persist before it')
  const usage = resumed.fileMap.get(`${SESSION_DIR}/usage.md`)
  assert.ok(usage.includes('| restored |'), 'usage.md records restored rows')
})

test('3: rulings are scoped to stages at or after where they were made', async () => {
  const args = { ...baseArgs(), rulings: [{ stage: 'Signatures', text: 'X' }] }
  const { calls } = await run(args)
  const planCall = calls.find(c => c.label === 'plan:PAT-301')
  const signCall = calls.find(c => c.label === 'signatures:PAT-301')
  const reviewCall = calls.find(c => c.label === 'planreview:PAT-301:r1')
  assert.ok(planCall && !planCall.prompt.includes('X'), 'the Plan prompt does not see the Signatures ruling')
  assert.ok(signCall && signCall.prompt.includes('X'), 'the Signatures prompt sees its own ruling')
  assert.ok(reviewCall && reviewCall.prompt.includes('X'), 'the PlanReview prompt sees a ruling made at or before it')
})

test('4: plan-log.md is append-only across cold runs', async () => {
  const fileMap = new Map()
  await run({ ...baseArgs(), startedAt: 'run-1' }, {}, fileMap)
  await run({ ...baseArgs(), startedAt: 'run-2' }, {}, fileMap)
  const log = fileMap.get(`${SESSION_DIR}/plan-log.md`)
  assert.equal((log.match(/^## Run started/gm) ?? []).length, 2)
  assert.equal((log.match(/^## Plan$/gm) ?? []).length, 2)
})

test('5: plan revision drift is reverted when unnamed, and fails the round when files are added', async () => {
  const initialFiles = [{ path: 'a.py', purpose: 'orig a' }, { path: 'b.py', purpose: 'orig b' }]
  const revisedFiles = [{ path: 'a.py', purpose: 'revised a' }, { path: 'b.py', purpose: 'revised b (drift)' }]
  const findingForA = {
    file: 'a.py', line: 1, rule: 'code-quality § Shape', kind: 'defect', basis: 'rule', change: 'fix a', addressee: 'plan-author',
  }
  const reverted = await run(baseArgs(), {
    'plan:PAT-301': planFixture(initialFiles),
    'signatures:PAT-301': sigFixtureFor(initialFiles),
    'planreview:PAT-301:r1': { pass: false, findings: [findingForA] },
    'plan:PAT-301:r1': planFixture(revisedFiles),
    'signatures:PAT-301:r1': sigFixtureFor(revisedFiles),
  })
  assert.ok(reverted.logs.includes('revision drift reverted: b.py'))
  assert.equal(reverted.result.paused, 'PlanGate')

  const addedFiles = [{ path: 'a.py', purpose: 'revised a' }, { path: 'c.py', purpose: 'new c (drift)' }]
  const failedRun = await run(baseArgs(), {
    'plan:PAT-301': planFixture([{ path: 'a.py', purpose: 'orig a' }]),
    'signatures:PAT-301': sigFixtureFor([{ path: 'a.py', purpose: 'orig a' }]),
    'planreview:PAT-301:r1': { pass: false, findings: [findingForA] },
    'plan:PAT-301:r1': planFixture(addedFiles),
  })
  assert.equal(failedRun.result.failed, 'PlanReview')
  assert.equal(failedRun.result.reason, 'plan revision drift')
})

test('6: a plan/signatures file-set mismatch is reconciled before the first review round', async () => {
  const files = [{ path: 'a.py', purpose: 'a' }, { path: 'b.py', purpose: 'b' }]
  const { calls } = await run(baseArgs(), {
    'plan:PAT-301': planFixture(files),
    'signatures:PAT-301': sigFixtureFor([files[0]]),
  })
  const relevant = calls.filter(c => c.agentType === 'ordinator:plan-signer' || c.agentType === 'ordinator:plan-reviewer')
  const labels = relevant.map(c => c.label)
  const reconcileIdx = labels.indexOf('reconcile:PAT-301')
  const reviewIdx = labels.indexOf('planreview:PAT-301:r1')
  assert.ok(reconcileIdx >= 0, 'a reconcile call happened')
  assert.ok(reviewIdx >= 0, 'the first review round happened')
  assert.ok(reconcileIdx < reviewIdx, 'reconcile happened before the first review round')
  assert.equal(calls.filter(c => c.agentType === 'ordinator:plan-signer').length, 2, 'exactly one extra plan-signer call')
})

test('7: existing behaviour is kept for blocking questions, smoke, and BLOCKED replies', async () => {
  const blocked = await run(baseArgs(), {
    'plan:PAT-301': {
      summary: 's', files: [{ path: 'a.py', purpose: 'a' }], dataStores: [], errors: '', logging: '',
      tests: [], questions: [{ text: 'which db?', blocking: true }],
    },
  })
  assert.equal(blocked.result.paused, 'Plan')
  assert.equal(blocked.calls.filter(c => c.agentType !== 'ordinator:record-writer').length, 1)

  const smoked = await run({ ...baseArgs(), sources: [], smoke: true })
  assert.equal(smoked.result.smoke, true)
  assert.equal(smoked.result.ok, true)
  assert.equal(smoked.calls.length, 0)

  const rejected = await run(baseArgs(), { 'plan:PAT-301': 'BLOCKED: no scope named' })
  assert.equal(rejected.result.failed, 'Plan')
})

test('8: a blocking pause at Plan or Signatures still leaves that stage checkpointed', async () => {
  const planQ = { summary: 's', files: [{ path: 'a.py', purpose: 'a' }], dataStores: [], errors: '', logging: '', tests: [], questions: [{ text: 'which db?', blocking: true }] }
  const atPlan = await run(baseArgs(), { 'plan:PAT-301': planQ })
  assert.equal(atPlan.result.paused, 'Plan')
  assert.ok(atPlan.fileMap.has(`${SESSION_DIR}/checkpoints/plan.json`), 'plan checkpoint written before the pause')
  assert.match(atPlan.fileMap.get(`${SESSION_DIR}/plan.md`), /pre-review/, 'plan.md rewritten at the Plan stage')

  const sigQ = { ...sigFixtureFor([{ path: 'a.py' }]), questions: [{ text: 'sync or async?', blocking: true }] }
  const atSig = await run(baseArgs(), { 'plan:PAT-301': { ...planQ, questions: [] }, 'signatures:PAT-301': sigQ })
  assert.equal(atSig.result.paused, 'Signatures')
  assert.ok(atSig.fileMap.has(`${SESSION_DIR}/checkpoints/signatures.json`), 'signatures checkpoint written before the pause')
})

test('9: a restored stage with a ruled blocking question does not pause again', async () => {
  const planQ = { summary: 's', files: [{ path: 'a.py', purpose: 'a' }], dataStores: [], errors: '', logging: '', tests: [], questions: [{ text: 'which db?', blocking: true }] }
  const first = await run(baseArgs(), { 'plan:PAT-301': planQ })
  const ck = checkpointsFrom(first.fileMap, SESSION_DIR)
  const resumed = await run({ ...baseArgs(), checkpoints: ck, rulings: [{ stage: 'Plan', text: 'postgres' }] }, { 'signatures:PAT-301': sigFixtureFor([{ path: 'a.py' }]) }, first.fileMap)
  assert.equal(resumed.result.paused, 'PlanGate')
  assert.equal(resumed.calls.filter(c => c.agentType === 'ordinator:plan-author').length, 0, 'Plan not re-run')
  assert.equal((resumed.fileMap.get(`${SESSION_DIR}/plan-log.md`).match(/## Run started/g) ?? []).length, 1, 'one run header only')

  const sigQ = { ...sigFixtureFor([{ path: 'a.py' }]), questions: [{ text: 'sync or async?', blocking: true }] }
  const atSig = await run(baseArgs(), { 'plan:PAT-301': { ...planQ, questions: [] }, 'signatures:PAT-301': sigQ })
  assert.equal(atSig.result.paused, 'Signatures')
  const ck2 = checkpointsFrom(atSig.fileMap, SESSION_DIR)
  const resumed2 = await run({ ...baseArgs(), checkpoints: ck2, rulings: [{ stage: 'Signatures', text: 'async' }] }, {}, atSig.fileMap)
  assert.equal(resumed2.result.paused, 'PlanGate')
  assert.equal(resumed2.calls.filter(c => ['ordinator:plan-author', 'ordinator:plan-signer'].includes(c.agentType)).length, 0, 'neither Plan nor Signatures re-run')
})
