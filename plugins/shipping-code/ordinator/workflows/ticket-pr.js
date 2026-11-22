export const meta = {
  name: 'ticket-pr',
  description: 'Build one ticket into a review-ready branch: plan, signatures, plan review, build, simplify, review loop, PR body draft',
  whenToUse: 'One invocation per ticket (or per slice). The implementation session runs it after the Scope step, passes {ticket, worktree, branch, sessionDir, scopePath, hub, reference, rulebookDir, sources, base?, rulings?, slice?, startedAt?, usage?, smoke?, checkpoints?, planApproved?}, relays paused questions to the orchestrator, resumes by reading checkpoints/*.json from sessionDir and passing them back as args.checkpoints (plus rulings as {stage, text} and planApproved once the PlanGate ruling arrives), then pushes and opens the draft PR itself.',
  phases: [
    { title: 'Plan', detail: 'plan-author: files, data stores, contracts, tests, questions' },
    { title: 'Signatures', detail: 'plan-signer: per-symbol signatures for every planned file' },
    { title: 'PlanReview', detail: 'plan-reviewer gate, signer or author revises, max 3 rounds, then a human PlanGate pause' },
    { title: 'Build', detail: 'code-implementor: tests green, staged commits' },
    { title: 'Simplify', detail: 'code-simplifier: style pass, one commit or none' },
    { title: 'Review', detail: 'code-reviewer gate, code-fixer, max 3 rounds' },
    { title: 'PRDraft', detail: 'pr-author: title and body' },
  ],
}

// Models and effort come from the agent files. Override per call only when a ticket needs it,
// e.g. agent(prompt, { agentType: 'ordinator:code-implementor', model: 'opus' }).
// Agent types carry the ordinator: namespace because they are plugin-shipped agents, not project
// agents; a project's own .claude/agents/ entries resolve bare, but a plugin's do not (verified
// against another plugin's agents, which resolve as <plugin>:<agent>).
const AGENT = name => `ordinator:${name}`
const { ticket, worktree, branch, sessionDir, scopePath, hub, reference, rulebookDir } = args
const base = args.base ?? 'main'
const slice = args.slice ?? 'single'
const sources = args.sources ?? []
const smoke = args.smoke === true
for (const [k, v] of Object.entries({ ticket, worktree, branch, sessionDir, scopePath, hub, reference, rulebookDir })) {
  if (!v) throw new Error(`args.${k} is required`)
}
if (!smoke && sources.length === 0) throw new Error('args.sources is required and may be empty only when args.smoke is true')

// Pointers the agents are handed. Agents carry behaviour only; every rule, fact and template is reached through these.
const HUB = hub
const REF = reference
// Rulebook directory is a project fact, lifted from PROJECT.md via the handoff into rulebookDir; never hardcoded here.
const RB = n => `${worktree}/${rulebookDir}/${n}.md`
const RULEBOOKS = ['code-quality', 'error-handling', 'logging', 'code-comments'].map(RB)
const PLAN_LOG_PATH = `${sessionDir}/plan-log.md`
const PLAN_MD_PATH = `${sessionDir}/plan.md`
const USAGE_PATH = `${sessionDir}/usage.md`
const CHECKPOINTS_DIR = `${sessionDir}/checkpoints`

const rulebooksText = `Rulebooks: ${RULEBOOKS.join(', ')}.`
const protocolText = `Finding protocol: ${REF} (section "Finding protocol").`
const toolingText = `Tooling reference: ${REF}.`
const sourcesText = sources.length ? `Sources (settled outrank history): ${sources.map(s => `${s.path} (${s.tag}, ${s.origin})`).join('; ')}` : 'Sources: none named.'
const questions = []

// A stage only sees rulings made at or before it, so a Signatures ruling never invalidates the Plan prompt's cache entry. A bare string ruling is pre-scoping and treated as Plan-stage.
const STAGES = ['Plan', 'Signatures', 'PlanReview', 'Build', 'Simplify', 'Review', 'PRDraft']
const rulings = (args.rulings ?? []).map(r => typeof r === 'string' ? { stage: 'Plan', text: r } : r)
const rulingsFor = stage => {
  const idx = STAGES.indexOf(stage)
  return rulings.filter(r => STAGES.indexOf(r.stage) <= idx)
}
const rulingsTextFor = stage => {
  const rs = rulingsFor(stage)
  return rs.length ? `Rulings from the user for this flow:\n${rs.map(r => `- ${r.text}`).join('\n')}` : 'Rulings: none yet.'
}

const Q = { type: 'array', items: { type: 'object', required: ['text', 'blocking'], properties: {
  text: { type: 'string' }, options: { type: 'array', items: { type: 'string' } }, blocking: { type: 'boolean' }, default: { type: 'string' } } } }
const PLAN = { type: 'object', required: ['summary', 'files', 'tests', 'questions'], properties: {
  summary: { type: 'string' },
  files: { type: 'array', items: { type: 'object', required: ['path', 'purpose'], properties: { path: { type: 'string' }, purpose: { type: 'string' } } } },
  dataStores: { type: 'array', items: { type: 'string' } }, errors: { type: 'string' }, logging: { type: 'string' },
  tests: { type: 'array', items: { type: 'string' } }, questions: Q } }
const SIGNATURES = { type: 'object', required: ['files', 'questions'], properties: {
  files: { type: 'array', items: { type: 'object', required: ['path', 'symbols'], properties: {
    path: { type: 'string' },
    symbols: { type: 'array', items: { type: 'object', required: ['signature', 'boundary'], properties: {
      signature: { type: 'string' }, raises: { type: 'string' }, logs: { type: 'string' },
      boundary: { type: 'string', enum: ['interface', 'internal'] } } } } } } },
  questions: Q } }
const FINDING = { type: 'object', required: ['file', 'rule', 'kind', 'basis', 'change'], properties: {
  file: { type: 'string' }, line: { type: 'integer' }, signature: { type: 'string' }, rule: { type: 'string' },
  kind: { type: 'string', enum: ['defect', 'plan conflict'] }, basis: { type: 'string', enum: ['rule', 'judgement'] },
  change: { type: 'string' }, addressee: { type: 'string', enum: ['plan-author', 'plan-signer', 'user'] } } }
const REVIEW = { type: 'object', required: ['pass', 'findings'], properties: { pass: { type: 'boolean' }, findings: { type: 'array', items: FINDING } } }
const BUILD = { type: 'object', required: ['commits', 'testsPassed', 'testOutput', 'questions'], properties: {
  commits: { type: 'array', items: { type: 'string' } }, testsPassed: { type: 'boolean' }, testOutput: { type: 'string' }, questions: Q } }
const PR = { type: 'object', required: ['title', 'body'], properties: { title: { type: 'string' }, body: { type: 'string' } } }

// Observability. Every agent call lands one ledger row (stage, label, tokens before/after, outcome incl. restored), written to usage.md at every exit. Timestamps and window usage come from args because the script cannot read a clock.
const ledger = []
let seq = 0
const RESERVE = 40_000
const spent = () => budget.spent()
const usageHeader = () => [
  `# Usage ${ticket} (${slice})`,
  `startedAt: ${args.startedAt ?? 'not supplied'}`,
  `windowUsageAtStart: ${js(args.usage ?? 'not supplied')}`,
  `budgetTotal: ${budget.total ?? 'none'}`,
  `reserve: ${RESERVE}`,
].join('\n')
const ledgerMd = (exit) => `${usageHeader()}\nexit: ${js(exit)}\nspentTotal: ${spent()}\n\n| seq | stage | label | before | after | delta | outcome |\n|---|---|---|---|---|---|---|\n${ledger.map(r => `| ${r.seq} | ${r.stage} | ${r.label} | ${r.before} | ${r.after} | ${r.delta} | ${r.outcome} |`).join('\n')}\n`

const rawPersist = (mode, path, content) => agent(`MODE: ${mode}\nPATH: ${path}\n---\n${content}`, { agentType: AGENT('record-writer'), label: `persist:${path.split('/').pop()}` })
const done = async (result) => { await rawPersist('write', USAGE_PATH, ledgerMd(result)); return result }

// call() wraps agent(): records the ledger row, turns a null result (API error after retries, user skip) into a clean
// failure the caller can resume from, and treats a BLOCKED reply as a failure of this stage rather than data.
const call = async (stage, prompt, opts) => {
  const before = spent()
  const r = await agent(prompt, { ...opts, phase: opts.phase ?? stage })
  const after = spent()
  const outcome = r === null ? 'null' : (typeof r === 'string' && r.startsWith('BLOCKED:')) ? 'blocked' : 'ok'
  ledger.push({ seq: ++seq, stage, label: opts.label, before, after, delta: after - before, outcome })
  if (outcome !== 'ok') log(`${stage}: ${opts.label} ${outcome}${outcome === 'blocked' ? `: ${r}` : ''}`)
  return r
}
const failed = (stage, r, extra = {}) => done({ ticket, failed: stage, reason: r === null ? 'agent unavailable (API error after retries or skipped); resume with resumeFromRunId' : r, questions, ...extra })
const persist = (mode, path, content) => call('persist', `MODE: ${mode}\nPATH: ${path}\n---\n${content}`, { agentType: AGENT('record-writer'), label: `persist:${path.split('/').pop()}` })
// Budget guard at each phase boundary: stop cleanly with headroom left rather than let agent() throw mid-stage.
const overBudget = (stage) => budget.total && budget.remaining() < RESERVE ? done({ ticket, paused: stage, reason: `budget: ${budget.remaining()} output tokens left, reserve ${RESERVE}`, questions }) : null

// A restored stage costs nothing: no agent call, no record append, just a ledger row so usage.md still shows it ran.
const markRestored = (stage, label) => {
  const s = spent()
  ledger.push({ seq: ++seq, stage, label, before: s, after: s, delta: 0, outcome: 'restored' })
  log(`${stage}: restored from checkpoint`)
}
const saveCheckpoint = (name, value) => persist('write', `${CHECKPOINTS_DIR}/${name}.json`, js(value))

const js = obj => JSON.stringify(obj, null, 2)
const section = (heading, body) => `## ${heading}\n\n${body}`
const collect = (stage, qs) => { for (const q of qs ?? []) questions.push({ stage, ...q }) }
const blocking = qs => (qs ?? []).filter(q => q.blocking)
const nonBlocking = qs => (qs ?? []).filter(q => !q.blocking)
// Collects a stage's questions and, if any are blocking, returns the paused done() value; else null.
const checkBlocking = async (stage, qs) => {
  collect(stage, qs)
  const b = blocking(qs)
  return b.length ? done({ paused: stage, questions: b, ticket }) : null
}
const worktreeText = `Worktree: ${worktree}. Branch: ${branch}. Base: ${base}.`
const testPaths = plan => plan.files.map(f => f.path).filter(p => p.startsWith('tests/'))
const bad = r => r === null || (typeof r === 'string' && r.startsWith('BLOCKED:'))

// Human-readable renderers, replacing raw JSON dumps. Each keeps the machine copy too, folded under <details> for a resume path or a reviewer agent to parse.
const renderQuestions = qs => {
  if (!qs || !qs.length) return '(none)'
  const rows = qs.map(q => `| ${q.text} | ${q.blocking} | ${q.default ?? ''} | ${(q.options ?? []).join(', ')} |`).join('\n')
  return ['| text | blocking | default | options |', '|---|---|---|---|', rows].join('\n')
}
const renderPlan = plan => {
  const files = plan.files.map(f => `| ${f.path} | ${f.purpose} |`).join('\n') || '| (none) | |'
  const tests = (plan.tests ?? []).map((t, i) => `${i + 1}. ${t}`).join('\n') || '(none)'
  return [
    plan.summary,
    '',
    '### Files',
    '| path | purpose |',
    '|---|---|',
    files,
    '',
    '### Data stores',
    (plan.dataStores ?? []).join(', ') || '(none)',
    '',
    '### Errors',
    plan.errors || '(none)',
    '',
    '### Logging',
    plan.logging || '(none)',
    '',
    '### Tests',
    tests,
    '',
    '### Questions',
    renderQuestions(plan.questions),
    '',
    `<details><summary>JSON</summary>\n\n\`\`\`json\n${js(plan)}\n\`\`\`\n\n</details>`,
  ].join('\n')
}
const renderSignatures = sig => {
  const fileBlocks = sig.files.map(f => {
    const rows = f.symbols.map(s => `| ${s.signature} | ${s.boundary} | ${s.raises ?? ''} | ${s.logs ?? ''} |`).join('\n')
    return [`### ${f.path}`, '', '| signature | boundary | raises | logs |', '|---|---|---|---|', rows].join('\n')
  }).join('\n\n')
  return [
    fileBlocks,
    '',
    '### Questions',
    renderQuestions(sig.questions),
    '',
    `<details><summary>JSON</summary>\n\n\`\`\`json\n${js(sig)}\n\`\`\`\n\n</details>`,
  ].join('\n')
}
const renderReview = v => {
  const pass = v.pass ? 'pass' : `${(v.findings ?? []).length} finding(s)`
  const rows = (v.findings ?? []).map(f => `| ${f.file} | ${f.line ?? ''} | ${f.rule} | ${f.kind} | ${f.basis} | ${f.addressee ?? ''} | ${f.change} |`).join('\n')
  const table = (v.findings ?? []).length
    ? ['| file | line | rule | kind | basis | addressee | change |', '|---|---|---|---|---|---|---|', rows].join('\n')
    : '(none)'
  return [
    pass,
    '',
    table,
    '',
    `<details><summary>JSON</summary>\n\n\`\`\`json\n${js(v)}\n\`\`\`\n\n</details>`,
  ].join('\n')
}

// Self-consistency, run before the reviewer ever sees the plan: the file sets must agree, and every tests/ path a test line names must be a planned file. Catches trivia a reviewer round would otherwise burn on.
const TESTS_PATH_RE = /tests\/[^\s,;:()]+/g
const selfConsistencyMismatches = (plan, signatures) => {
  const planPaths = new Set(plan.files.map(f => f.path))
  const sigPaths = new Set(signatures.files.map(f => f.path))
  const missing = [...planPaths].filter(p => !sigPaths.has(p))
  const extra = [...sigPaths].filter(p => !planPaths.has(p))
  const testPaths = new Set()
  for (const line of plan.tests ?? []) for (const m of line.matchAll(TESTS_PATH_RE)) testPaths.add(m[0])
  const testMismatch = [...testPaths].filter(p => !planPaths.has(p))
  return { missing, extra, testMismatch }
}
const hasMismatch = m => m.missing.length > 0 || m.extra.length > 0 || m.testMismatch.length > 0

// A revision may only touch the files the findings named. Anything else changed is reverted; anything else added or removed fails the round rather than being reviewed unseen.
const applyDriftGuard = (originalFiles, revisedFiles, named) => {
  const originalPaths = new Set(originalFiles.map(f => f.path))
  const revisedPaths = new Set(revisedFiles.map(f => f.path))
  const added = [...revisedPaths].filter(p => !originalPaths.has(p) && !named.has(p))
  const removed = [...originalPaths].filter(p => !revisedPaths.has(p) && !named.has(p))
  if (added.length || removed.length) return { drift: { added, removed } }
  const origByPath = new Map(originalFiles.map(f => [f.path, f]))
  const files = revisedFiles.map(f => {
    if (originalPaths.has(f.path) && !named.has(f.path)) {
      const orig = origByPath.get(f.path)
      if (js(orig) !== js(f)) {
        log(`revision drift reverted: ${f.path}`)
        return orig
      }
    }
    return f
  })
  return { files }
}

phase('Plan')
{ const p = await overBudget('Plan'); if (p) return p }
if (smoke) return { ticket, smoke: true, ok: true, budgetTotal: budget.total ?? null }
const planBase = `Scope document: ${scopePath}. Ticket document: ${HUB}. ${sourcesText} ${worktreeText} ${rulebooksText}`
const planPrompt = `${planBase} ${rulingsTextFor('Plan')}`
const planRevisionPrompt = `${planBase} ${rulingsTextFor('PlanReview')}`
let plan
if (args.checkpoints?.plan) {
  plan = args.checkpoints.plan
  markRestored('Plan', `plan:${ticket}`)
  collect('Plan', nonBlocking(plan.questions))
} else {
  plan = await call('Plan', `${planPrompt}\nProduce the plan for ${ticket} (${slice}).`, { agentType: AGENT('plan-author'), label: `plan:${ticket}`, schema: PLAN })
  if (bad(plan)) return failed('Plan', plan)
  await persist('append', PLAN_LOG_PATH, `## Run started ${args.startedAt ?? 'not supplied'}`)
  await persist('append', PLAN_LOG_PATH, section('Plan', renderPlan(plan)))
  // plan.md is overwritten here so a pause before the gate never leaves a previous run's plan in place.
  await persist('write', PLAN_MD_PATH, `# Plan ${ticket} (pre-review, run started ${args.startedAt ?? 'not supplied'})\n\n${section('Plan', renderPlan(plan))}`)
  // Checkpoint before the blocking check: the pause is the exit this stage usually takes, and a
  // restored plan skips the check because its blocking questions were ruled before the re-invocation.
  await saveCheckpoint('plan', plan)
  { const p = await checkBlocking('Plan', plan.questions); if (p) return p }
}

phase('Signatures')
{ const p = await overBudget('Signatures'); if (p) return p }
const signBase = `${worktreeText} ${rulebooksText} ${sourcesText}`
const signPrompt = `${signBase} ${rulingsTextFor('Signatures')}`
const signRevisionPrompt = `${signBase} ${rulingsTextFor('PlanReview')}`
let signatures
if (args.checkpoints?.signatures) {
  signatures = args.checkpoints.signatures
  markRestored('Signatures', `signatures:${ticket}`)
  collect('Signatures', nonBlocking(signatures.questions))
} else {
  signatures = await call('Signatures', `${signPrompt}\nPlan:\n${js(plan)}\nProduce the signature plan.`, { agentType: AGENT('plan-signer'), label: `signatures:${ticket}`, schema: SIGNATURES })
  if (bad(signatures)) return failed('Signatures', signatures)
  await persist('append', PLAN_LOG_PATH, section('Signatures', renderSignatures(signatures)))
  await saveCheckpoint('signatures', signatures)
  { const p = await checkBlocking('Signatures', signatures.questions); if (p) return p }
}

phase('PlanReview')
let planVerdict = null
const roundHistory = []
const finalCk = args.checkpoints?.['plan-final']
if (finalCk) {
  plan = finalCk.plan
  signatures = finalCk.signatures
  markRestored('PlanReview', `planfinal:${ticket}`)
} else {
  let round = 1
  let restoredRound = 0
  for (let i = 1; i <= 3; i++) if (args.checkpoints?.[`planreview-r${i}`]) restoredRound = i
  let syntheticNote = ''
  if (restoredRound) {
    const ck = args.checkpoints[`planreview-r${restoredRound}`]
    plan = ck.plan
    signatures = ck.signatures
    planVerdict = ck.verdict
    roundHistory.push({ round: restoredRound, verdict: planVerdict })
    markRestored('PlanReview', `planreview:${ticket}:r${restoredRound}`)
    round = restoredRound + 1
  } else {
    const mismatches = selfConsistencyMismatches(plan, signatures)
    if (hasMismatch(mismatches)) {
      const reconciled = await call('PlanReview',
        `${signPrompt}\nPlan:\n${js(plan)}\nCurrent signatures:\n${js(signatures)}\nMismatches:\n${js(mismatches)}\nReconcile these mismatches and nothing else.`,
        { agentType: AGENT('plan-signer'), label: `reconcile:${ticket}`, schema: SIGNATURES })
      if (bad(reconciled)) return failed('PlanReview', reconciled)
      signatures = reconciled
      await persist('append', PLAN_LOG_PATH, section('Signatures reconciliation', renderSignatures(signatures)))
      const stillMismatched = selfConsistencyMismatches(plan, signatures)
      if (hasMismatch(stillMismatched)) syntheticNote = `Unresolved self-consistency mismatch (synthetic finding, not a failure): ${js(stillMismatched)}\n`
    }
  }
  if (!planVerdict || !planVerdict.pass) {
    for (; round <= 3; round++) {
      { const p = await overBudget('PlanReview'); if (p) return p }
      const note = round === 1 ? syntheticNote : ''
      planVerdict = await call('PlanReview',
        `Ticket document: ${HUB}. Scope document: ${scopePath}. ${rulebooksText} ${protocolText} ${rulingsTextFor('PlanReview')}\n${note}Plan:\n${js(plan)}\nSignatures:\n${js(signatures)}\nReturn pass and findings.`,
        { agentType: AGENT('plan-reviewer'), label: `planreview:${ticket}:r${round}`, schema: REVIEW })
      if (bad(planVerdict)) return failed('PlanReview', planVerdict)
      await persist('append', PLAN_LOG_PATH, section(`Plan review round ${round}`, renderReview(planVerdict)))
      if (planVerdict.pass) {
        roundHistory.push({ round, verdict: planVerdict })
        await saveCheckpoint(`planreview-r${round}`, { plan, signatures, verdict: planVerdict })
        break
      }
      const toUser = planVerdict.findings.filter(f => f.addressee === 'user')
      if (toUser.length) return done({ paused: 'Signatures', questions: toUser.map(f => ({ text: `${f.file}: ${f.change} (${f.rule})`, blocking: true })), ticket })

      const toAuthor = planVerdict.findings.filter(f => f.addressee === 'plan-author')
      if (toAuthor.length) {
        const named = new Set(toAuthor.map(f => f.file))
        const revised = await call('PlanReview',
          `${planRevisionPrompt}\nRevise this plan to address these findings and nothing else.\nPlan:\n${js(plan)}\nFindings:\n${js(toAuthor)}`,
          { agentType: AGENT('plan-author'), label: `plan:${ticket}:r${round}`, schema: PLAN })
        if (bad(revised)) return failed('PlanReview', revised)
        const guard = applyDriftGuard(plan.files, revised.files, named)
        if (guard.drift) return failed('PlanReview', 'plan revision drift', { drift: guard.drift })
        plan = { ...revised, files: guard.files }
        await persist('append', PLAN_LOG_PATH, section(`Plan revision round ${round}`, renderPlan(plan)))
      }

      const namedAll = new Set(planVerdict.findings.map(f => f.file))
      const resigned = await call('PlanReview',
        `${signRevisionPrompt}\nPlan:\n${js(plan)}\nCurrent signatures:\n${js(signatures)}\nFindings to address (yours, plus any plan changes):\n${js(planVerdict.findings)}\nReturn the revised signature plan.`,
        { agentType: AGENT('plan-signer'), label: `signatures:${ticket}:r${round}`, schema: SIGNATURES })
      if (bad(resigned)) return failed('PlanReview', resigned)
      const sigGuard = applyDriftGuard(signatures.files, resigned.files, namedAll)
      if (sigGuard.drift) return failed('PlanReview', 'plan revision drift', { drift: sigGuard.drift })
      signatures = { ...resigned, files: sigGuard.files }
      await persist('append', PLAN_LOG_PATH, section(`Signatures revision round ${round}`, renderSignatures(signatures)))

      roundHistory.push({ round, verdict: planVerdict })
      await saveCheckpoint(`planreview-r${round}`, { plan, signatures, verdict: planVerdict })
    }
  }
  if (!planVerdict.pass) return failed('PlanReview', 'plan review did not pass in 3 rounds', { findings: planVerdict.findings })
  await saveCheckpoint('plan-final', { plan, signatures })
  const nonBlocking = questions.filter(q => q.blocking === false)
  const decisions = nonBlocking.length ? renderQuestions(nonBlocking) : 'none'
  const reviewHistory = roundHistory.length
    ? roundHistory.map(h => `- Round ${h.round}: ${h.verdict.pass ? 'pass' : `${h.verdict.findings.length} finding(s)`} (see plan-log.md)`).join('\n')
    : '(none)'
  const planMd = [
    `# Plan ${ticket} (${slice})`,
    '',
    section('Decisions the plan took for you', decisions),
    '',
    section('Plan', renderPlan(plan)),
    '',
    section('Signatures', renderSignatures(signatures)),
    '',
    section('Review history', reviewHistory),
  ].join('\n')
  await persist('write', PLAN_MD_PATH, planMd)
}

if (args.planApproved !== true) return done({ paused: 'PlanGate', ticket, planPath: PLAN_MD_PATH, questions: [] })

phase('Build')
{ const p = await overBudget('Build'); if (p) return p }
const buildPrompt = `${worktreeText} ${rulebooksText} ${toolingText} ${rulingsTextFor('Build')}`
let build
if (args.checkpoints?.build) {
  build = args.checkpoints.build
  markRestored('Build', `build:${ticket}`)
} else {
  build = await call('Build',
    `${buildPrompt}\nSignatures:\n${js(signatures)}\nTests to write:\n${js(plan.tests)}\nImplement ${ticket}.`,
    { agentType: AGENT('code-implementor'), label: `build:${ticket}`, schema: BUILD })
  if (bad(build)) return failed('Build', build)
  const buildJson = `\`\`\`json\n${js(build)}\n\`\`\``
  await persist('write', `${sessionDir}/build.md`, `# Build ${ticket}\n\n${section('Build', buildJson)}`)
}
collect('Build', build.questions)
if (!build.testsPassed) return failed('Build', 'tests not green', { detail: build.testOutput })
if (!args.checkpoints?.build) await saveCheckpoint('build', build)

phase('Simplify')
{ const p = await overBudget('Simplify'); if (p) return p }
let simplified
if (args.checkpoints?.simplify) {
  simplified = args.checkpoints.simplify
  markRestored('Simplify', `simplify:${ticket}`)
} else {
  simplified = await call('Simplify',
    `${worktreeText} Rulebook: ${RB('code-quality')}, section "Style". ${toolingText} Test paths: ${js(testPaths(plan))}.\nRun the style pass on the files changed on this branch since its base.`,
    { agentType: AGENT('code-simplifier'), label: `simplify:${ticket}` })
  if (bad(simplified)) return failed('Simplify', simplified)
  await persist('write', `${sessionDir}/simplify.md`, `# Simplify ${ticket}\n\n${simplified}`)
  await saveCheckpoint('simplify', simplified)
}

phase('Review')
let verdict = null
let reviewRounds = 0
{
  let round = 1
  let restoredRound = 0
  for (let i = 1; i <= 3; i++) if (args.checkpoints?.[`review-r${i}`]) restoredRound = i
  if (restoredRound) {
    const ck = args.checkpoints[`review-r${restoredRound}`]
    verdict = ck.verdict
    reviewRounds = restoredRound
    markRestored('Review', `review:${ticket}:r${restoredRound}`)
    round = restoredRound + 1
  }
  if (!verdict || !verdict.pass) {
    for (; round <= 3; round++) {
      { const p = await overBudget('Review'); if (p) return p }
      reviewRounds = round
      verdict = await call('Review',
        `${worktreeText} Ticket document: ${HUB}. Plan document: ${PLAN_MD_PATH}. ${sourcesText} ${rulebooksText} ${protocolText}\nReview the full diff from the base and read touched files whole. Return pass and findings.`,
        { agentType: AGENT('code-reviewer'), label: `review:${ticket}:r${round}`, schema: REVIEW })
      if (bad(verdict)) return failed('Review', verdict)
      await persist('write', `${sessionDir}/review-r${round}.md`, `# Review ${ticket} round ${round}\n\n${renderReview(verdict)}`)
      if (verdict.pass) {
        await saveCheckpoint(`review-r${round}`, { verdict, fixed: null })
        break
      }
      if (verdict.findings.some(f => f.kind === 'plan conflict')) {
        return failed('Review', 'plan conflict', { findings: verdict.findings, recommendation: 'new flow from Plan with a ruling' })
      }
      log(`review round ${round}: ${verdict.findings.length} findings, dispatching fixes`)
      const fixed = await call('Review',
        `${worktreeText} ${rulebooksText} ${protocolText} ${toolingText} Test paths: ${js(testPaths(plan))}.\nFindings:\n${js(verdict.findings)}`,
        { agentType: AGENT('code-fixer'), label: `fix:${ticket}:r${round}` })
      if (bad(fixed)) return failed('Review', fixed)
      await persist('write', `${sessionDir}/fix-r${round}.md`, `# Fix ${ticket} round ${round}\n\n${fixed}`)
      await saveCheckpoint(`review-r${round}`, { verdict, fixed })
    }
  }
}
if (!verdict.pass) return failed('Review', 'review did not pass in 3 rounds', { findings: verdict.findings })

phase('PRDraft')
{ const p = await overBudget('PRDraft'); if (p) return p }
let pr
if (args.checkpoints?.pr) {
  pr = args.checkpoints.pr
  markRestored('PRDraft', `prdraft:${ticket}`)
} else {
  pr = await call('PRDraft',
    `${worktreeText} Ticket document: ${HUB}. ${sourcesText} Rulebook with the PR template: ${RB('code-quality')}. Stack position: ${slice}.\nDraft the PR title and body.`,
    { agentType: AGENT('pr-author'), label: `prdraft:${ticket}`, schema: PR })
  if (bad(pr)) return failed('PRDraft', pr)
  await persist('write', `${sessionDir}/pr.md`, `# PR ${ticket}\n\n## Title\n${pr.title}\n\n## Body\n${pr.body}\n\n## URL\n(pending)`)
  await saveCheckpoint('pr', pr)
}

return done({ ticket, branch, worktree, commits: build.commits, reviewRounds, pr, questions })
