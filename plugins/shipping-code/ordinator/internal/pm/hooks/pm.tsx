import { atom, read, update } from 'claude-code'
import type { EngineInterface, ModelEffort, Register } from 'claude-code'

import type { Footer, Phase } from '../types'

// Plan manager. When the person approves a plan (ExitPlanMode answered yes) and pm is on, the main
// conversation is not compacted and does not implement it: pm archives the plan, has the main thread
// write a brief of the conversation over its own transcript ($.model.fork, so from the prompt cache),
// and hands brief and plan to an implementer subagent (pm:implementer) in the background. This is the
// old "compact and exit plan mode" without losing the main conversation's context. The main thread is
// told, as the plan tool's result, that a subagent has it, and gets a note naming the agent once it runs.
// The implementer reports its steps through pm's own tool (mcp__pm__step), drawn in the footer as
// `pm ▸ <slug> 2/7`; when it ends, a verifier (pm:verifier, no edit tools) checks the work against the
// plan, and both reports are appended to the main conversation, where the model reads them on its next
// turn: nothing interrupts. The implementer is a subagent like any other to om, so it gets om's agents
// mode. Off by default (/pm:on); /pm:send hands off the last approved plan by hand.

type Settings = { model: string; effort: ModelEffort; verify: boolean }
type Run = {
  title: string
  slug: string
  plan: string
  // The engine's own plan file, and pm's copy in the project's mods/pm/plans.
  planPath: string | null
  archived: string | null
  brief: string | null
  agentId: string | null
  verifierId: string | null
  steps: string[]
  done: number[]
  phase: Phase
  startedAt: string
  report: string | null
  verdict: string | null
  error: string | null
  // The implementer's step-tool notes, for the reviewer.
  notes: string[]
}
type Plan = { plan: string; planPath: string | null }

export const EFFORTS: readonly ModelEffort[] = ['low', 'medium', 'high', 'xhigh', 'max']
const IMPLEMENTER = 'pm:implementer'
const VERIFIER = 'pm:verifier'
const STEP_TOOL = 'mcp__pm__step'
const REPORT_CHARS = 12_000

const footer = atom({ plugin: 'pm', key: 'footer' } as const, null as Footer | null)

const C = { overlay0: '#6c7086', subtext1: '#bac2de', mauve: '#cba6f7', green: '#a6e3a1', red: '#f38ba8' }

const stamp = (d = new Date()) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n)}\n[... ${s.length - n} more characters in /pm:report]` : s)

// --- Pure helpers ---

// The plan's steps: its top-level numbered items, else its numbered headings. None: the implementer
// names them through the step tool.
export function parseSteps(plan: string): string[] {
  const strip = (s: string) => s.replace(/\*\*|__|`/g, '').trim()
  const items = [...plan.matchAll(/^\d+[.)]\s+(.+)$/gm)].map(m => strip(m[1]!))
  if (items.length >= 2) return items
  const heads = [...plan.matchAll(/^#{2,4}\s+(?:step\s*)?\d+[.:)]?\s+(.+)$/gim)].map(m => strip(m[1]!))
  return heads.length >= 2 ? heads : []
}

export function titleOf(plan: string): string {
  const h = /^#\s+(.+)$/m.exec(plan)?.[1] ?? plan.split('\n').find(l => l.trim())?.replace(/^#+\s*/, '') ?? 'plan'
  return h.trim().slice(0, 120)
}

export function slugOf(title: string): string {
  const words = title.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim().split(' ').filter(w => w && !['the', 'a', 'an', 'plan', 'for', 'to', 'of', 'and'].includes(w))
  return words.slice(0, 4).join('-').slice(0, 40) || 'plan'
}

// <TICKET-ID>-<slug>.md when the title names a ticket, else <YYYY-MM-DD>-<slug>.md (the naming of
// PROJECT-LAYOUT.md's artifacts/plans).
export function planFileName(date: string, title: string): string {
  const ticket = /\b([A-Z][A-Z0-9]+-\d+)\b/.exec(title)?.[1]
  return `${ticket ?? date}-${slugOf(title)}.md`
}

// The names the engine may have given a project's folder under <config>/projects: today's encoding
// first, then the older ones that kept `_` and `.`.
export function projectKeys(path: string): string[] {
  return [...new Set([path.replace(/[^a-zA-Z0-9]/g, '-'), path.replace(/[/.]/g, '-'), path.replace(/\//g, '-')])]
}

export function footerLabel(f: Footer): string {
  const count = f.total ? ` ${f.done}/${f.total}` : ''
  switch (f.phase) {
    case 'briefing': return `pm ▸ ${f.slug} briefing`
    case 'implementing': return `pm ▸ ${f.slug}${count}`
    case 'verifying': return `pm ▸ ${f.slug}${count} verifying`
    case 'done': return `pm ▸ ${f.slug}${count} ${f.verdict === 'fail' ? '✗' : '✓'}`
    case 'failed': return `pm ▸ ${f.slug} failed`
    case 'stopped': return `pm ▸ ${f.slug} stopped`
  }
}

export function parseConfig(args: string): { model?: string; effort?: ModelEffort; verify?: boolean; error?: string } {
  const words = args.trim().split(/\s+/).filter(Boolean)
  const out: { model?: string; effort?: ModelEffort; verify?: boolean } = {}
  for (let i = 0; i < words.length; i += 2) {
    const [k, v] = [words[i]!.toLowerCase(), words[i + 1]]
    if (k === 'model' && v) out.model = v
    else if (k === 'effort' && EFFORTS.includes(v?.toLowerCase() as ModelEffort)) out.effort = v!.toLowerCase() as ModelEffort
    else if (k === 'verify' && (v === 'on' || v === 'off')) out.verify = v === 'on'
    else return { error: `Expected model <name>, effort ${EFFORTS.join('|')}, verify on|off; got "${args.trim()}".` }
  }
  return out
}

// The verifier ends its report with VERDICT: PASS or VERDICT: FAIL.
export const verdictOf = (report: string): 'pass' | 'fail' | null => {
  const m = /VERDICT:\s*(PASS|FAIL)/i.exec(report)
  return m ? (m[1]!.toUpperCase() === 'PASS' ? 'pass' : 'fail') : null
}

const BRIEF_PROMPT = [
  'pm: the plan you just presented was approved, and a subagent will implement it in a fresh context while',
  'this conversation carries on. Write its handoff brief: everything from this conversation it needs that the',
  'plan itself does not say. Do not restate the plan. Cover, under short headings:',
  '- Goal and why, in the user\'s words where they set a requirement',
  '- Constraints and rules the user gave (style, tools, what not to touch, what needs their yes)',
  '- Decisions made, with the alternatives rejected and why',
  '- Files, paths, commands and APIs already found, and gotchas hit',
  '- How the work will be checked (tests, commands, what "done" looks like)',
  '- Open questions the implementer should not decide alone',
  'Plain markdown, at most 1,500 words. Facts only: no greeting, no sign-off.',
].join('\n')

const IMPLEMENTER_PROMPT = [
  'You implement a plan the user approved in another conversation. Your first message holds a brief of that',
  'conversation, the plan, and its steps. The user is not watching you work: a later reviewer checks your work',
  'against the plan, and your final message is the report they read.',
  '',
  `Report progress through the ${STEP_TOOL} tool: call it with { "steps": [...] } first if the plan's steps`,
  'are not listed in your message (short names, in order); then with { "done": <step number> } as each one is',
  'finished. Add "note" for anything the reviewer must know.',
  '',
  'Work as a careful senior engineer: read before you edit, match the surrounding code, run the checks the plan',
  'names. Stay inside the plan. Where it is wrong or blocked, do what is safe, stop short of anything outward',
  'facing or destructive (pushing, deleting, posting), and say so in the report rather than improvising scope.',
  '',
  'End with a report: per step, what was done or why not; files changed; checks run and their output;',
  'deviations from the plan; anything left for the user.',
].join('\n')

const VERIFIER_PROMPT = [
  'You verify that a plan was implemented. Your message holds the plan and the implementer\'s report. Trust',
  'neither: check the repository itself. For each step, read the code it should have changed and say done,',
  'partly done or not done, with the evidence (file:line, command output). Run the tests and checks the plan',
  'or the report names; do not fix anything. Note anything changed that the plan did not ask for.',
  'End with one line: VERDICT: PASS when every step is done and the checks pass, else VERDICT: FAIL.',
].join('\n')

export function implementerMessage(run: Pick<Run, 'title' | 'brief' | 'plan' | 'steps' | 'archived'>): string {
  const steps = run.steps.length ? run.steps.map((s, i) => `${i + 1}. ${s}`).join('\n') : '(not numbered: name them with the step tool first)'
  return [
    `# Implement: ${run.title}`,
    '',
    '## Brief of the conversation',
    run.brief ?? '(No brief could be written; the plan is all there is.)',
    '',
    `## The plan${run.archived ? ` (also at ${run.archived})` : ''}`,
    run.plan,
    '',
    '## Steps, for the step tool',
    steps,
  ].join('\n')
}

const verifierMessage = (run: Run) =>
  [`# Verify: ${run.title}`, '', '## The plan', run.plan, '', '## The implementer\'s report', run.report ?? '(none)', ...run.notes.map(n => `- ${n}`)].join('\n')

// --- Store ---

const key = async ($: EngineInterface) => `run:${await $.session.id()}`
const planKey = async ($: EngineInterface) => `plan:${await $.session.id()}`
const loadRun = async ($: EngineInterface) => ((await $.store.get(await key($))) as Run | undefined) ?? null
const saveRun = async ($: EngineInterface, run: Run) => {
  await $.store.set(await key($), run)
  await update($, footer, () => ({ slug: run.slug, phase: run.phase, done: run.done.length, total: run.steps.length, verdict: run.phase === 'done' ? verdictOf(run.verdict ?? '') : null }))
}
const isOn = async ($: EngineInterface) => (await $.store.get('enabled')) === true

async function settings($: EngineInterface, defaults: Settings): Promise<Settings> {
  const model = await $.store.get('model')
  const effort = await $.store.get('effort')
  const verify = await $.store.get('verify')
  return {
    model: typeof model === 'string' ? model : defaults.model,
    effort: EFFORTS.includes(effort as ModelEffort) ? (effort as ModelEffort) : defaults.effort,
    verify: typeof verify === 'boolean' ? verify : defaults.verify,
  }
}

// The implementer and verifier types, at the configured model; re-registered when /pm:config changes it.
async function registerAgents($: EngineInterface, s: Settings) {
  await $.agent.register({ name: 'implementer', description: 'pm: implements an approved plan from its brief', prompt: IMPLEMENTER_PROMPT, model: s.model, effort: s.effort })
  await $.agent.register({ name: 'verifier', description: 'pm: checks an implemented plan against the repository', prompt: VERIFIER_PROMPT, model: s.model, effort: s.effort, disallowedTools: ['Edit', 'Write', 'NotebookEdit'] })
}

// A note the model reads on its next request: the main conversation's, or a subagent's with `agentId`. The
// person does not see it as typed. False when the engine would not take it; the note is logged then.
async function append($: EngineInterface, text: string, agentId?: string): Promise<boolean> {
  try {
    await $.session.append({ message: { type: 'user', content: [{ type: 'text', text }] }, ...(agentId ? { agentId } : {}) })
    return true
  } catch (err) {
    $.ui.log(`pm: could not append to ${agentId ?? 'main'} (${String(err)}): ${text}`)
    return false
  }
}

async function tellMain($: EngineInterface, text: string) {
  await append($, text)
}

// The project the session is in: the nearest folder above it with artifacts/ or worktrees/ (the project
// space of PROJECT-LAYOUT.md), else the session's root.
async function projectRoot($: EngineInterface): Promise<string> {
  const start = await $.session.root()
  for (let d = start; d && d !== '/'; d = d.slice(0, d.lastIndexOf('/')) || '/') {
    if ((await $.fs.exists(`${d}/artifacts`)) || (await $.fs.exists(`${d}/worktrees`))) return d
  }
  return start
}

// The mods' folder of the project, beside the engine's own transcripts and memory:
// <config>/projects/<project key>/mods. The key is the project space's, so a worktree's plans file there.
async function modsDir($: EngineInterface): Promise<string> {
  const config = (await $.env.get('CLAUDE_CONFIG_DIR')) ?? `${await $.env.get('HOME')}/.claude`
  const keys = projectKeys(await projectRoot($))
  for (const k of keys) if (await $.fs.exists(`${config}/projects/${k}`)) return `${config}/projects/${k}/mods`
  return `${config}/projects/${keys[0]}/mods`
}

async function archive($: EngineInterface, run: Run): Promise<string | null> {
  try {
    const path = `${await modsDir($)}/pm/plans/${planFileName(stamp(), run.title)}`
    const head = ['---', `date: ${stamp()}`, `session: ${await $.session.id()}`, run.planPath ? `source: ${run.planPath}` : null, `implementer: ${IMPLEMENTER}`, '---', ''].filter(l => l !== null)
    await $.fs.write(path, `${head.join('\n')}\n${run.plan}\n`)
    return path
  } catch (err) {
    $.ui.log(`pm: could not archive the plan: ${String(err)}`)
    return null
  }
}

// --- The handoff ---

// Runs in the background: the main thread's turn goes on while the brief is written and the agent starts.
async function handoff($: EngineInterface, plan: Plan) {
  const title = titleOf(plan.plan)
  let run: Run = {
    title, slug: slugOf(title), plan: plan.plan, planPath: plan.planPath, archived: null, brief: null,
    agentId: null, verifierId: null, steps: parseSteps(plan.plan), done: [], phase: 'briefing',
    startedAt: new Date().toISOString(), report: null, verdict: null, error: null, notes: [],
  }
  await saveRun($, run)
  run = { ...run, archived: await archive($, run) }
  const brief = await $.model.fork({ prompt: BRIEF_PROMPT })
  if (brief.isAnswered) run = { ...run, brief: brief.text }
  else $.ui.log(`pm: no brief (${brief.reason}); the implementer gets the plan alone`)
  await saveRun($, run)
  const spawned = await $.agent.spawn({ subagentType: IMPLEMENTER, prompt: implementerMessage(run), description: `pm: implement ${run.slug}` })
  if (spawned.deny !== undefined || !spawned.agentId) {
    run = { ...run, phase: 'failed', error: spawned.deny ?? 'no agent id' }
    await saveRun($, run)
    await tellMain($, `[pm] The implementer for "${title}" could not start (${run.error}). The plan is not being implemented; say how to go on.`)
    return
  }
  run = { ...run, agentId: spawned.agentId, phase: 'implementing' }
  await saveRun($, run)
  const steps = run.steps.length ? `${run.steps.length} steps` : 'steps to be named by the agent'
  await tellMain($, `[pm] The plan "${title}" is being implemented by subagent ${IMPLEMENTER} (agent ${spawned.agentId}, ${spawned.model}), in the background: ${steps}. Do not implement it yourself; carry on with the user. Its report, and a verification, will be appended here when it ends.${run.archived ? ` The plan is archived at ${run.archived}.` : ''}`)
}

// The implementer, then the verifier, ending.
async function ended($: EngineInterface, s: Settings, agentId: string, answer: string) {
  let run = await loadRun($)
  if (!run) return
  if (agentId === run.agentId && (run.phase === 'implementing' || run.phase === 'stopped')) {
    run = { ...run, report: answer }
    if (run.phase === 'implementing' && s.verify) {
      const spawned = await $.agent.spawn({ subagentType: VERIFIER, prompt: verifierMessage(run), description: `pm: verify ${run.slug}` })
      if (spawned.deny === undefined && spawned.agentId) {
        await saveRun($, { ...run, verifierId: spawned.agentId, phase: 'verifying' })
        return
      }
      run = { ...run, verdict: `The verifier could not start: ${spawned.deny ?? 'no agent id'}` }
    }
    await deliver($, { ...run, phase: run.phase === 'stopped' ? 'stopped' : 'done' })
  } else if (agentId === run.verifierId && run.phase === 'verifying') {
    await deliver($, { ...run, verdict: answer, phase: 'done' })
  }
}

async function deliver($: EngineInterface, run: Run) {
  await saveRun($, run)
  const v = verdictOf(run.verdict ?? '')
  const steps = run.steps.length ? ` (${run.done.length}/${run.steps.length} steps reported done)` : ''
  await tellMain($, [
    `[pm] The plan "${run.title}" ${run.phase === 'stopped' ? 'was stopped by the user' : 'has been implemented'}${steps}.${v ? ` Verification: ${v.toUpperCase()}.` : ''}`,
    '', '## Implementer\'s report', clip(run.report ?? '(none)', REPORT_CHARS),
    ...(run.notes.length ? ['', '## Its notes along the way', ...run.notes.map(n => `- ${n}`)] : []),
    ...(run.verdict ? ['', '## Verification', clip(run.verdict, REPORT_CHARS)] : []),
  ].join('\n'))
  $.ui.toast(`pm: ${run.slug} ${run.phase === 'stopped' ? 'stopped' : 'done'}${v ? ` · ${v}` : ''} · /pm:report`)
}

// --- /pm: commands ---

async function statusText($: EngineInterface, s: Settings): Promise<string> {
  const run = await loadRun($)
  const head = `pm ${(await isOn($)) ? 'on' : 'off'} · implementer ${s.model} at ${s.effort} · verify ${s.verify ? 'on' : 'off'}`
  if (!run) return `${head}\nNo plan handed off this session.${(await $.store.get(await planKey($))) ? ' /pm:send hands off the last approved plan.' : ''}`
  const steps = run.steps.map((t, i) => `  ${run.done.includes(i + 1) ? '✓' : '·'} ${i + 1}. ${t}`)
  return [
    head,
    `${run.title}: ${run.phase}${run.agentId ? ` · agent ${run.agentId}` : ''}${run.verifierId ? ` · verifier ${run.verifierId}` : ''}`,
    ...(steps.length ? steps : ['  (no steps named yet)']),
    run.archived ? `archived ${run.archived}` : 'not archived',
    run.error ? `error: ${run.error}` : null,
  ].filter(l => l !== null).join('\n')
}

const isRunning = (run: Run | null) => run !== null && (run.phase === 'briefing' || run.phase === 'implementing' || run.phase === 'verifying')

export const register: Register = (on, options) => {
  const defaults: Settings = {
    model: String(options.model ?? 'sonnet'),
    effort: EFFORTS.includes(options.effort as ModelEffort) ? (options.effort as ModelEffort) : 'high',
    verify: true,
  }

  on('session.start', async ($, e, next) => {
    const r = await next(e)
    await registerAgents($, await settings($, defaults))
    await $.tool.register({
      name: 'step',
      description: 'pm: report progress on the plan you are implementing. { steps: [...] } names the steps when your message did not; { done: n } marks step n finished; note adds a line for the reviewer.',
      inputSchema: {
        type: 'object',
        properties: { steps: { type: 'array', items: { type: 'string' } }, done: { type: 'integer', minimum: 1 }, note: { type: 'string' } },
      },
    })
    const run = await loadRun($)
    if (run) await saveRun($, run)
    return r
  })

  // pm's own agents are spawned by pm alone.
  on('agent.offer', async ($, e, next) => (e.agent === IMPLEMENTER || e.agent === VERIFIER ? { isOffered: false } : next(e)))

  on('tool.call', { tool: 'ExitPlanMode' }, async ($, e, next) => {
    const r = await next(e)
    if (e.agentId !== undefined || r.deny !== undefined || r.isError) return r
    const res = r.result as { plan?: string | null; filePath?: string; awaitingLeaderApproval?: boolean } | undefined
    if (!res?.plan || res.awaitingLeaderApproval) return r
    const plan: Plan = { plan: res.plan, planPath: res.filePath ?? null }
    await $.store.set(await planKey($), plan)
    if (!(await isOn($))) return r
    if (isRunning(await loadRun($))) {
      return { ...r, context: [...(r.context ?? []), '[pm] Another plan is still being implemented, so this one was not handed off: implement it here as usual, or wait and use /pm:send.'] }
    }
    void handoff($, plan).catch(err => $.ui.log(`pm: handoff failed: ${String(err)}`))
    return {
      ...r,
      context: [...(r.context ?? []), `[pm] pm is handing this plan to an implementer subagent (${IMPLEMENTER}) with a brief of this conversation. Do NOT implement it yourself: tell the user it has been handed off, then carry on with whatever they ask. A note naming the agent follows once it runs; its report and a verification are appended here when it ends.`],
    }
  })

  on('tool.call', { tool: STEP_TOOL }, async ($, e) => {
    const run = await loadRun($)
    if (!run || e.agentId === undefined || e.agentId !== run.agentId) return { result: 'pm: no plan of yours is being tracked; nothing recorded.' }
    const input = e as unknown as { steps?: unknown; done?: unknown; note?: unknown }
    let next = run
    if (Array.isArray(input.steps)) next = { ...next, steps: input.steps.map(String), done: [] }
    if (typeof input.done === 'number' && !next.done.includes(input.done)) next = { ...next, done: [...next.done, input.done].sort((a, b) => a - b) }
    if (typeof input.note === 'string' && input.note) next = { ...next, notes: [...next.notes, input.note] }
    await saveRun($, next)
    return { result: `pm: ${next.done.length} of ${next.steps.length} steps done.` }
  })

  // /pm:stop: every later tool call of the stopped agent is refused, so it ends and reports.
  on('tool.call', async ($, e, next) => {
    if (e.agentId === undefined) return next(e)
    const run = await loadRun($)
    if (run?.phase === 'stopped' && e.agentId === run.agentId) return { deny: 'pm: the user stopped this plan. Do no more work: end now with a short report of what was done and what was left.' }
    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    const r = await next(e)
    if (e.agentId !== undefined) void ended($, await settings($, defaults), e.agentId, e.answer).catch(err => $.ui.log(`pm: ${String(err)}`))
    return r
  })

  // The footer entry, before what the hooks beneath and the engine draw on the row.
  on('ui.render', { component: 'PromptHint' }, async ($, e, next) => {
    const f = await read($, footer)
    if (f === null) return next(e)
    const { Box, Text } = $.ui.resolve(e)
    const color = f.phase === 'done' ? (f.verdict === 'fail' ? C.red : C.green) : f.phase === 'failed' ? C.red : C.mauve
    return (
      <Box flexDirection="row">
        <Text color={color} wrap="truncate-end">{footerLabel(f)}   </Text>
        {await next(e)}
      </Box>
    )
  })

  on('command.run', { command: 'pm:status' }, async $ => ({ text: await statusText($, await settings($, defaults)) }))

  on('command.run', { command: 'pm:on' }, async $ => {
    await $.store.set('enabled', true)
    return { text: 'pm on: an approved plan goes to an implementer subagent; this conversation carries on (every session).' }
  })

  on('command.run', { command: 'pm:off' }, async $ => {
    await $.store.set('enabled', false)
    return { text: 'pm off: approved plans are implemented here, as the engine does. /pm:send still hands one off by hand.' }
  })

  on('command.run', { command: 'pm:config' }, async ($, e) => {
    const set = parseConfig(e.args)
    if (set.error) return { text: set.error }
    if (set.model) await $.store.set('model', set.model)
    if (set.effort) await $.store.set('effort', set.effort)
    if (set.verify !== undefined) await $.store.set('verify', set.verify)
    const s = await settings($, defaults)
    if (set.model || set.effort) await registerAgents($, s)
    return { text: `implementer and verifier ${s.model} at ${s.effort} · verify ${s.verify ? 'on' : 'off'}` }
  })

  on('command.run', { command: 'pm:send' }, async $ => {
    const plan = (await $.store.get(await planKey($))) as Plan | undefined
    if (!plan) return { text: 'No approved plan this session to hand off.' }
    if (isRunning(await loadRun($))) return { text: 'A plan is still being implemented: /pm:status, or /pm:stop it first.' }
    void handoff($, plan).catch(err => $.ui.log(`pm: handoff failed: ${String(err)}`))
    return { text: `Handing off "${titleOf(plan.plan)}": the brief is being written; the footer shows when the implementer runs.` }
  })

  on('command.run', { command: 'pm:steer' }, async ($, e) => {
    const run = await loadRun($)
    const to = run?.phase === 'verifying' ? run.verifierId : run?.phase === 'implementing' ? run.agentId : null
    if (!run || !to) return { text: 'No implementer or verifier is running.' }
    if (!e.args.trim()) return { text: 'Usage: /pm:steer <what the agent should know or do>' }
    if (!(await append($, `[pm] From the user: ${e.args.trim()}`, to))) return { text: `Could not reach ${to}: the engine refused the message.` }
    return { text: `Sent to ${run.phase === 'verifying' ? 'the verifier' : 'the implementer'} (${to}); it reads it on its next step.` }
  })

  on('command.run', { command: 'pm:stop' }, async $ => {
    const run = await loadRun($)
    if (!run || !isRunning(run)) return { text: 'Nothing is running.' }
    await saveRun($, { ...run, phase: 'stopped' })
    return { text: `Stopping "${run.title}": the agent's next tool call is refused and it ends with a report.` }
  })

  on('command.run', { command: 'pm:brief' }, async $ => {
    const run = await loadRun($)
    return { text: run?.brief ?? (run ? 'No brief was written for this plan.' : 'No plan handed off this session.') }
  })

  on('command.run', { command: 'pm:report' }, async $ => {
    const run = await loadRun($)
    if (!run) return { text: 'No plan handed off this session.' }
    return { text: [`${run.title}: ${run.phase}`, '', '## Implementer', run.report ?? '(not yet)', '', '## Verification', run.verdict ?? '(not yet)'].join('\n') }
  })
}
