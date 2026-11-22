import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, SessionMessage } from 'claude-code'

import type { Item, Task, TaskStatus } from '../types'

// Task manager. The built-in task list (TaskCreate, ctrl+t) lasts one session; tm keeps a list per project in
// the engine's own project folder, <config>/projects/<project key>/mods/tm/tasks.jsonl, and a global one in
// <config>/mods/tm/tasks.jsonl, both one JSON task per line. A task is ready when it is todo, does not wait on
// the person and every task it comes after is done. The list is drawn in the band above the prompt (at most
// 5 rows, the last `+N more · /tm` when some are hidden) and in the /tm pane. The model files and updates
// tasks through its own tool (mcp__tm__task); a task's done check is set by the person and the model cannot
// change it, and closing needs evidence. The built-in task tools are mirrored into the list. After a
// compaction, and when a session is resumed, the list is put back in front of the model. Writes re-read the
// file and merge by id, newer `updated` first, so two sessions do not lose each other's changes. /tm:off keeps
// tm quiet toward the model (no list after a compaction or on resume) and hides the band; the tool, the
// commands and the pane stay. The switch is a file per project, <project mods folder>/tm/state.json.

const PANE = 'tm'
const ROW = 'row:'
const MAX_ROWS = 5
const TOOL = 'mcp__tm__task'
const OM_NOTE = 'Notes the om observer recorded earlier in this session'
const STATUSES: readonly TaskStatus[] = ['todo', 'doing', 'blocked', 'done']

const view = atom({ plugin: 'tm', key: 'view' } as const, [] as Item[])
const open = atom({ plugin: 'tm', key: 'open' } as const, null as string | null)

const C = { overlay0: '#6c7086', subtext1: '#bac2de', mauve: '#cba6f7', green: '#a6e3a1', red: '#f38ba8', peach: '#fab387' }

const iso = (ms: number) => new Date(ms).toISOString()
const oneLine = (s: string) => s.replace(/\s+/g, ' ').trim()
const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, Math.max(0, n - 1))}…` : s)
const pad2 = (n: number) => String(n).padStart(2, '0')

// --- Pure helpers ---

export function newId(existing: Iterable<string>): string {
  const taken = new Set(existing)
  for (let size = 4; ; size++) {
    for (let i = 0; i < 64; i++) {
      const id = Array.from({ length: size }, () => Math.floor(Math.random() * 16).toString(16)).join('')
      if (!taken.has(id)) return id
    }
  }
}

export function blank(id: string, title: string, now: string): Task {
  return {
    id, title, status: 'todo', check: null, next: null, decisions: [], parent: null, after: [], waits_on: null, owner: null,
    found: false, harness_id: null, area: null, evidence: null, created: now, updated: now, closed: null,
  }
}

const str = (v: unknown) => (typeof v === 'string' && v ? v : null)

// A line that is not a task (no id or title, or not JSON) is left out; missing fields take their defaults.
export function parseTasks(text: string): Task[] {
  const tasks: Task[] = []
  for (const line of text.split('\n')) {
    if (!line.trim()) continue
    let o: Record<string, unknown>
    try {
      o = JSON.parse(line) as Record<string, unknown>
    } catch {
      continue
    }
    if (typeof o !== 'object' || o === null || typeof o.id !== 'string' || typeof o.title !== 'string') continue
    const created = str(o.created) ?? new Date(0).toISOString()
    tasks.push({
      id: o.id,
      title: o.title,
      status: STATUSES.includes(o.status as TaskStatus) ? (o.status as TaskStatus) : 'todo',
      check: str(o.check),
      next: str(o.next),
      decisions: Array.isArray(o.decisions) ? o.decisions.filter((d): d is { at: string; text: string } => typeof d?.at === 'string' && typeof d?.text === 'string') : [],
      parent: str(o.parent),
      after: Array.isArray(o.after) ? o.after.filter((a): a is string => typeof a === 'string') : [],
      waits_on: str(o.waits_on),
      owner: str(o.owner),
      found: o.found === true,
      harness_id: str(o.harness_id),
      area: str(o.area),
      evidence: str(o.evidence),
      created,
      updated: str(o.updated) ?? created,
      closed: str(o.closed),
    })
  }
  return tasks
}

export const serialise = (tasks: readonly Task[]) => tasks.map(t => JSON.stringify(t)).join('\n') + (tasks.length ? '\n' : '')

// What is on disk with `mine` laid over it: a task of mine replaces the disk's unless the disk's was updated
// later. A task only the disk has stays.
export function merge(disk: readonly Task[], mine: readonly Task[]): Task[] {
  const out = new Map(disk.map(t => [t.id, t]))
  for (const t of mine) {
    const d = out.get(t.id)
    if (!d || d.updated <= t.updated) out.set(t.id, t)
  }
  return [...out.values()]
}

export type Groups<T extends Task = Task> = { doing: T[]; needsYou: T[]; ready: T[]; blocked: T[]; done: T[] }

const oldest = (a: Task, b: Task) => a.created.localeCompare(b.created)

// Needs you: waits on the person. Ready: todo, waiting on nothing, every task it comes after done (one that
// is gone counts as done). Blocked: the rest that is not done or doing.
export function groups<T extends Task>(tasks: readonly T[]): Groups<T> {
  const byId = new Map(tasks.map(t => [t.id, t]))
  const met = (id: string) => byId.get(id)?.status === 'done' || !byId.has(id)
  const g: Groups<T> = { doing: [], needsYou: [], ready: [], blocked: [], done: [] }
  for (const t of tasks) {
    if (t.status === 'done') g.done.push(t)
    else if (t.waits_on === 'user') g.needsYou.push(t)
    else if (t.status === 'doing') g.doing.push(t)
    else if (t.status === 'todo' && t.waits_on === null && t.after.every(met)) g.ready.push(t)
    else g.blocked.push(t)
  }
  for (const k of ['doing', 'needsYou', 'ready', 'blocked'] as const) g[k].sort(oldest)
  g.done.sort((a, b) => (b.closed ?? b.updated).localeCompare(a.closed ?? a.updated))
  return g
}

export type RowKind = 'doing' | 'needs' | 'ready'
export type Row<T extends Task = Task> = { kind: RowKind; task: T } | { kind: 'more'; hidden: number }

// Doing, then needs you, then ready; when more than `max` there are, the last row stands for the hidden ones.
export function bandRows<T extends Task>(g: Groups<T>, max = MAX_ROWS): Row<T>[] {
  const all: Row<T>[] = [
    ...g.doing.map(task => ({ kind: 'doing' as const, task })),
    ...g.needsYou.map(task => ({ kind: 'needs' as const, task })),
    ...g.ready.map(task => ({ kind: 'ready' as const, task })),
  ]
  if (all.length <= max) return all
  return [...all.slice(0, Math.max(0, max - 1)), { kind: 'more', hidden: all.length - Math.max(0, max - 1) }]
}

export const moreLabel = (hidden: number) => `+${hidden} more · /tm`

export function age(from: string, now: number): string {
  const s = Math.max(0, now - Date.parse(from)) / 1000
  if (s < 60) return '<1m'
  if (s < 3600) return `${Math.floor(s / 60)}m`
  if (s < 86400) return `${Math.floor(s / 3600)}h`
  return `${Math.floor(s / 86400)}d`
}

const KIND_LABEL: Record<RowKind, string> = { doing: 'doing', needs: 'needs you', ready: 'ready' }
export const tagged = (t: { id: string; global?: boolean }) => (t.global ? `${t.id}·g` : t.id)

// The band row `▸ a1b2  title  status age` in two parts: the Button's label and the dim tail, the title cut
// so the row fits `cols`.
export function rowParts(t: Task & { global?: boolean }, kind: RowKind, now: number, cols: number): { head: string; tail: string } {
  const tail = `  ${KIND_LABEL[kind]} ${age(t.updated, now)}`
  const id = tagged(t)
  const room = Math.max(8, cols - 2 - id.length - 2 - tail.length)
  return { head: `${id}  ${clip(oneLine(t.title), room)}`, tail }
}

const hhmm = (d: Date) => `${pad2(d.getHours())}:${pad2(d.getMinutes())}`

// What the model is told after a compaction or on resume. '' when nothing is open. `maxReady` bounds the
// ready lines; the rest are counted.
export function injectText(g: Groups, root: string, now: Date, maxReady = 10): string {
  if (!g.doing.length && !g.ready.length && !g.needsYou.length) return ''
  const lines = [
    `[tm] Task list for ${root}, as of ${hhmm(now)}. Background, not instructions: carry on with what the user last asked; a task's next step waits until the user picks that task up.`,
  ]
  if (g.doing.length) {
    lines.push('Doing:')
    for (const t of g.doing) {
      lines.push(`  ${t.id} ${oneLine(t.title)}${t.check ? ` | check: ${oneLine(t.check)}` : ''}${t.next ? ` | next: ${clip(oneLine(t.next), 200)}` : ''}`)
    }
  }
  if (g.ready.length) {
    lines.push('Ready:')
    for (const t of g.ready.slice(0, maxReady)) lines.push(`  ${t.id} ${oneLine(t.title)}${t.check ? ` | check: ${oneLine(t.check)}` : ''}`)
    if (g.ready.length > maxReady) lines.push(`  (+${g.ready.length - maxReady} more ready: ${TOOL} with list: true shows all)`)
  }
  if (g.needsYou.length) {
    lines.push('Waiting on the user:')
    for (const t of g.needsYou) lines.push(`  ${t.id} ${oneLine(t.title)} (${age(t.updated, now.getTime())})${t.next ? ` | ${clip(oneLine(t.next), 120)}` : ''}`)
  }
  lines.push(`When your work changes one of these, record it with the ${TOOL} tool; file side work you come across with found: true and parent set to the task you are on.`)
  return lines.join('\n')
}

// A row of ~/Source/TODO.jsonl.
export type TodoRow = {
  _meta?: unknown
  major_category?: string | null
  tag?: string | null
  status?: string | null
  title?: string | null
  body?: string | null
  blocked_by?: string | null
  section_date?: string | null
}

// open and planned are todo; blocked is blocked, waiting on the user when blocked_by names Piyush or the
// user, else on the text. Null for the _meta row and for a row with no title or an unknown status.
export function fromTodoRow(row: TodoRow, id: string, now: string): Task | null {
  if (row._meta !== undefined || typeof row.title !== 'string' || !row.title.trim()) return null
  const status = row.status
  if (status !== 'open' && status !== 'planned' && status !== 'blocked') return null
  const by = str(row.blocked_by)?.trim() ?? null
  const created = row.section_date && /^\d{4}-\d\d-\d\d$/.test(row.section_date) ? `${row.section_date}T00:00:00.000Z` : now
  return {
    ...blank(id, row.title.trim(), created),
    status: status === 'blocked' ? 'blocked' : 'todo',
    next: str(row.body),
    waits_on: status === 'blocked' && by ? (/\b(piyush|user)\b/i.test(by) ? 'user' : by) : null,
    area: [row.major_category, row.tag].filter(Boolean).join('/') || null,
  }
}

export type Imported = {
  tasks: Task[]
  // Rows whose title the global list already has.
  skipped: number
  // Lines that are not a TODO row: line number and why.
  unmapped: string[]
  // Rows with a blocked_by whose status is not blocked: imported as their status says.
  flagged: string[]
}

// The tasks to add to `existing` (the global list) from a TODO.jsonl, none for a title it already has.
export function importRows(text: string, existing: readonly Task[], now: string, taken: Iterable<string>): Imported {
  const out: Imported = { tasks: [], skipped: 0, unmapped: [], flagged: [] }
  const titles = new Set(existing.map(t => t.title.trim().toLowerCase()))
  const ids = new Set(taken)
  text.split('\n').forEach((line, i) => {
    if (!line.trim()) return
    let row: TodoRow
    try {
      row = JSON.parse(line) as TodoRow
    } catch {
      out.unmapped.push(`line ${i + 1}: not JSON`)
      return
    }
    if (row._meta !== undefined) return
    const id = newId(ids)
    const task = fromTodoRow(row, id, now)
    if (!task) {
      out.unmapped.push(`line ${i + 1}: ${typeof row.title === 'string' ? `"${clip(row.title, 50)}" has status ${String(row.status)}` : 'no title'}`)
      return
    }
    if (titles.has(task.title.toLowerCase())) {
      out.skipped++
      return
    }
    ids.add(id)
    titles.add(task.title.toLowerCase())
    out.tasks.push(task)
    if (row.status !== 'blocked' && str(row.blocked_by)) out.flagged.push(`"${clip(task.title, 50)}" (${row.status}, blocked_by: ${clip(oneLine(row.blocked_by!), 40)})`)
  })
  return out
}

// `<title words> [--global] [--check <words>] [--after <id,...>]`; double quotes keep words together.
export function parseAdd(args: string): { title: string; global: boolean; check: string | null; after: string[] } {
  const tokens = [...args.matchAll(/"([^"]*)"|(\S+)/g)].map(m => m[1] ?? m[2] ?? '')
  const words: Record<'title' | 'check' | 'after', string[]> = { title: [], check: [], after: [] }
  let into: 'title' | 'check' | 'after' = 'title'
  let global = false
  for (const t of tokens) {
    if (t === '--global') global = true
    else if (t === '--check') into = 'check'
    else if (t === '--after') into = 'after'
    else words[into].push(t)
  }
  return {
    title: words.title.join(' ').trim(),
    global,
    check: words.check.join(' ').trim() || null,
    after: words.after.join(' ').split(/[,\s]+/).filter(Boolean).map(s => s.toLowerCase()),
  }
}

const isOmNote = (m: SessionMessage) => m.role === 'user' && m.text.startsWith(OM_NOTE)

// The compacted conversation with tm's note right after the summary, and after om's note when om put one there
// (index 0 in om's own mode, where there is no summary, else index 1).
export function withNote(messages: readonly SessionMessage[], text: string): SessionMessage[] {
  const note: SessionMessage = { role: 'user', text, toolUses: [] }
  if (!messages.length) return [note]
  const om = messages.findIndex((m, i) => i < 2 && isOmNote(m))
  const at = om >= 0 ? om + 1 : 1
  return [...messages.slice(0, at), note, ...messages.slice(at)]
}

// The task with its status changed: closing stamps `closed` and the evidence, anything but blocked ends a
// wait on someone, and reopening clears `closed`.
export function withStatus(t: Task, status: TaskStatus, now: string, evidence: string | null = null): Task {
  const base = { ...t, status, updated: now, closed: status === 'done' ? now : null }
  if (status === 'done') return { ...base, waits_on: null, evidence: evidence ?? t.evidence }
  if (status === 'blocked') return base
  return { ...base, waits_on: null }
}

// The engine's names for a project's folder under <config>/projects: today's encoding first, then the older
// ones that kept `_` and `.`.
export function projectKeys(path: string): string[] {
  return [...new Set([path.replace(/[^a-zA-Z0-9]/g, '-'), path.replace(/[/.]/g, '-'), path.replace(/\//g, '-')])]
}

// --- Store ---

async function projectRoot($: EngineInterface): Promise<string> {
  const start = await $.session.root()
  for (let d = start; d && d !== '/'; d = d.slice(0, d.lastIndexOf('/')) || '/') {
    if ((await $.fs.exists(`${d}/artifacts`)) || (await $.fs.exists(`${d}/worktrees`))) return d
  }
  return start
}

const configDir = async ($: EngineInterface) => (await $.env.get('CLAUDE_CONFIG_DIR')) || `${await $.env.get('HOME')}/.claude`

// The mods' folder of the project, beside the engine's own transcripts and memory:
// <config>/projects/<project key>/mods. The key is the project space's, so a worktree shares its project's.
async function modsDir($: EngineInterface): Promise<string> {
  const config = await configDir($)
  const keys = projectKeys(await projectRoot($))
  for (const k of keys) if (await $.fs.exists(`${config}/projects/${k}`)) return `${config}/projects/${k}/mods`
  return `${config}/projects/${keys[0]}/mods`
}

// Per project, since $.store is the plugin's one store. On unless the file says otherwise.
const statePath = async ($: EngineInterface) => `${await modsDir($)}/tm/state.json`

async function isOn($: EngineInterface): Promise<boolean> {
  const path = await statePath($)
  if (!(await $.fs.exists(path))) return true
  try {
    return (JSON.parse(String(await $.fs.read(path))) as { on?: unknown }).on !== false
  } catch {
    return true
  }
}

const globalDir = async ($: EngineInterface) => `${await configDir($)}/mods/tm`

const pathOf = async ($: EngineInterface, global: boolean) => `${global ? await globalDir($) : `${await modsDir($)}/tm`}/tasks.jsonl`

async function readList($: EngineInterface, path: string): Promise<Task[]> {
  return (await $.fs.exists(path)) ? parseTasks(String(await $.fs.read(path))) : []
}

// Both lists, the project's first.
async function listAll($: EngineInterface): Promise<Item[]> {
  const project = await readList($, await pathOf($, false))
  const global = await readList($, await pathOf($, true))
  return [...project.map(t => ({ ...t, global: false })), ...global.map(t => ({ ...t, global: true }))]
}

async function refresh($: EngineInterface) {
  const all = await listAll($)
  if (JSON.stringify(all) !== JSON.stringify(await read($, view))) await update($, view, () => all)
}

// Writes `changed` over what is on disk now and drops `removed`, then redraws.
async function commit($: EngineInterface, global: boolean, changed: readonly Task[], removed: readonly string[] = []) {
  const path = await pathOf($, global)
  const tasks = merge(await readList($, path), changed).filter(t => !removed.includes(t.id))
  await $.fs.write(path, serialise(tasks))
  await refresh($)
}

async function create($: EngineInterface, title: string, global: boolean, fields: Partial<Task> = {}): Promise<Item> {
  const all = await listAll($)
  const task: Task = { ...blank(newId(all.map(t => t.id)), title, iso(await $.clock.now())), ...fields }
  await commit($, global, [task])
  return { ...task, global }
}

// The task changed by `fn` and written; null when no task has the id.
async function amend($: EngineInterface, id: string, fn: (t: Task, now: string) => Task): Promise<Item | null> {
  const cur = (await listAll($)).find(t => t.id === id)
  if (!cur) return null
  const now = iso(await $.clock.now())
  const { global, ...task } = cur
  const changed = { ...fn(task, now), updated: now }
  await commit($, global, [changed])
  return { ...changed, global }
}

// A note the model reads on its next request, as pm does it. False when the engine would not take it.
async function append($: EngineInterface, text: string): Promise<boolean> {
  try {
    await $.session.append({ message: { type: 'user', content: [{ type: 'text', text }] } })
    return true
  } catch (err) {
    $.ui.log(`tm: could not append (${String(err)}): ${text}`)
    return false
  }
}

async function injection($: EngineInterface, maxReady?: number): Promise<string> {
  return injectText(groups(await listAll($)), await projectRoot($), new Date(await $.clock.now()), maxReady)
}

// --- The model's tool ---

type ToolIn = {
  add?: string; check?: string; parent?: string; after?: string[]; found?: boolean; global?: boolean
  id?: string; status?: string; next?: string; decision?: string; owner?: string; evidence?: string
  ask?: string; why?: string; list?: boolean; agentId?: string
}

async function taskTool($: EngineInterface, input: ToolIn): Promise<string> {
  const all = await listAll($)
  if (input.list) return (await injection($, Infinity)) || 'tm: no open tasks.'

  if (input.add || input.ask) {
    const title = (input.add ?? input.ask)!
    const owner = input.agentId ?? (await $.session.id())
    const parent = input.parent?.toLowerCase() ?? null
    const after = (input.after ?? []).map(a => a.toLowerCase())
    const missing = [...(parent ? [parent] : []), ...after].filter(id => !all.some(t => t.id === id))
    if (missing.length) return `tm: no task ${missing.join(', ')}; nothing filed.`
    if (input.ask) {
      const t = await create($, input.ask, false, { waits_on: 'user', next: str(input.why), parent, owner })
      return `tm: ${t.id} is with the user now; carry on with something else.`
    }
    const found = input.found === true
    const t = await create($, title, input.global === true, { check: str(input.check), parent, after, found, owner })
    return `tm: filed ${t.id} "${clip(oneLine(title), 60)}".${found ? ` Side work: carry on with ${parent ?? 'what you were doing'}.` : ''}`
  }

  if (input.id) {
    const id = input.id.toLowerCase()
    const cur = all.find(t => t.id === id)
    if (!cur) return `tm: no task ${id}.`
    const me = input.agentId ?? (await $.session.id())
    if (input.status !== undefined && !STATUSES.includes(input.status as TaskStatus)) return `tm: status is one of ${STATUSES.join(', ')}.`
    if (input.check !== undefined && cur.check) return `tm: ${id} has a check ("${clip(oneLine(cur.check), 80)}") that only the person changes; it stays as it is.`
    if (input.status === 'done' && !str(input.evidence)) {
      return `tm: closing ${id} needs evidence: pass what you ran or saw as evidence.${cur.check ? ` Its check: ${oneLine(cur.check)}` : ''}`
    }
    const t = await amend($, id, (t, now) => {
      let n = input.status ? withStatus(t, input.status as TaskStatus, now, str(input.evidence)) : { ...t, evidence: str(input.evidence) ?? t.evidence }
      if (input.next !== undefined) n = { ...n, next: str(input.next) }
      if (input.decision) n = { ...n, decisions: [...n.decisions, { at: now, text: input.decision }] }
      if (input.check !== undefined) n = { ...n, check: str(input.check) }
      return { ...n, owner: str(input.owner) ?? (input.status === 'doing' ? me : n.owner) }
    })
    return `tm: ${id} ${t?.status ?? 'updated'}.`
  }

  return 'tm: nothing to do: give add, ask, list, or the id of a task to update.'
}

// --- The built-in task tools, mirrored ---

// The mirrored task of a built-in task id in this session; the built-in ids restart in every session.
const mirrored = (all: readonly Item[], harnessId: string, session: string) => all.find(t => t.harness_id === harnessId && t.owner === session)

async function mirrorCreate($: EngineInterface, harnessId: string, subject: string, description: string | undefined) {
  await create($, subject, false, { harness_id: harnessId, owner: await $.session.id(), next: str(description) })
}

type TaskUpdateIn = { taskId: string; status?: string; subject?: string; description?: string; addBlockedBy?: string[] }

async function mirrorUpdate($: EngineInterface, input: TaskUpdateIn) {
  const session = await $.session.id()
  const all = await listAll($)
  const cur = mirrored(all, input.taskId, session)
  if (!cur) return
  if (input.status === 'deleted') {
    await commit($, cur.global, [], [cur.id])
    return
  }
  const blockers = (input.addBlockedBy ?? []).flatMap(h => mirrored(all, h, session)?.id ?? [])
  await amend($, cur.id, (t, now) => {
    let n = t
    if (input.status === 'in_progress') n = withStatus(n, 'doing', now)
    else if (input.status === 'pending') n = withStatus(n, 'todo', now)
    else if (input.status === 'completed') n = withStatus(n, 'done', now, 'built-in task completed')
    if (input.subject) n = { ...n, title: input.subject }
    if (input.description) n = { ...n, next: input.description }
    if (blockers.length) n = { ...n, after: [...new Set([...n.after, ...blockers])] }
    return n
  })
}

// --- The pane and the band ---

async function openList($: EngineInterface) {
  await update($, open, () => null)
  await $.ui.open({ id: PANE, title: 'tm', focus: true, closeOnEscape: true, columns: 70, rows: 18 })
}

async function openTask($: EngineInterface, id: string) {
  await update($, open, () => id)
  await $.ui.open({ id: PANE, title: 'tm', focus: true, closeOnEscape: true, columns: 70, rows: 18 })
}

// The person's buttons in the pane. Done counts as forced.
async function setStatus($: EngineInterface, id: string, status: TaskStatus) {
  await amend($, id, (t, now) => withStatus(t, status, now, status === 'done' ? 'marked done by the user' : null))
}

// --- The /tm: commands ---

const usage = (u: string) => `Usage: ${u}`

async function cmdAdd($: EngineInterface, args: string): Promise<string> {
  const a = parseAdd(args)
  if (!a.title) return usage('/tm:add <title> [--global] [--check <text>] [--after <id,...>]')
  const all = await listAll($)
  const missing = a.after.filter(id => !all.some(t => t.id === id))
  if (missing.length) return `No task ${missing.join(', ')}; nothing added.`
  const t = await create($, a.title, a.global, { check: a.check, after: a.after })
  return `Added ${tagged(t)}: ${clip(a.title, 80)}${a.check ? ' (check set)' : ''}`
}

async function cmdNext($: EngineInterface): Promise<string> {
  const g = groups(await listAll($))
  const t = g.doing[0] ?? g.ready[0]
  if (!t) return `Nothing ready.${g.needsYou.length ? ` ${g.needsYou.length} waiting on you: /tm.` : ''}`
  return [`${g.doing[0] ? 'Doing' : 'Next'}: ${tagged(t)} ${oneLine(t.title)}`, t.check ? `  check: ${oneLine(t.check)}` : null, t.next ? `  next: ${clip(oneLine(t.next), 300)}` : null].filter(l => l !== null).join('\n')
}

async function cmdDone($: EngineInterface, args: string): Promise<string> {
  const [id = '', ...rest] = args.trim().split(/\s+/)
  const cur = (await listAll($)).find(t => t.id === id.toLowerCase())
  if (!id) return usage('/tm:done <id> [what you saw | force]')
  if (!cur) return `No task ${id}.`
  if (cur.status === 'done') return `${cur.id} is already done.`
  const text = rest.join(' ').trim()
  const force = text.toLowerCase() === 'force'
  if (cur.check && !text) return `${cur.id} has a check: "${clip(oneLine(cur.check), 100)}". Run it, then /tm:done ${cur.id} <what you saw>, or /tm:done ${cur.id} force.`
  await amend($, cur.id, (t, now) => withStatus(t, 'done', now, force ? 'forced by the user' : text || null))
  return `Done: ${tagged(cur)} ${clip(oneLine(cur.title), 80)}`
}

async function cmdBlock($: EngineInterface, args: string): Promise<string> {
  const m = /^\s*(\S+)\s+([\s\S]+)$/.exec(args)
  if (!m) return usage('/tm:block <id> <why>  (start the why with "me:" when it waits on you)')
  const id = m[1]!.toLowerCase()
  const me = /^(?:on\s+)?me\s*:\s*([\s\S]*)$/i.exec(m[2]!.trim())
  const t = await amend($, id, (t, now) => {
    const n = withStatus(t, 'blocked', now)
    return me ? { ...n, waits_on: 'user', next: str(me[1]!.trim()) ?? n.next } : { ...n, waits_on: m[2]!.trim() }
  })
  if (!t) return `No task ${id}.`
  return `${tagged(t)} blocked: ${me ? 'waiting on you' : `waiting on ${clip(oneLine(m[2]!), 60)}`}`
}

async function cmdNote($: EngineInterface, args: string): Promise<string> {
  const m = /^\s*(\S+)\s+([\s\S]+)$/.exec(args)
  if (!m) return usage('/tm:note <id> <text>  (start the text with "decision:" to log a decision)')
  const id = m[1]!.toLowerCase()
  const d = /^decision:\s*([\s\S]+)$/i.exec(m[2]!.trim())
  const t = await amend($, id, (t, now) => (d ? { ...t, decisions: [...t.decisions, { at: now, text: d[1]!.trim() }] } : { ...t, next: m[2]!.trim() }))
  if (!t) return `No task ${id}.`
  return `${tagged(t)} ${d ? 'decision logged' : 'next step set'}.`
}

async function cmdSwitch($: EngineInterface, on: boolean): Promise<string> {
  await $.fs.write(await statePath($), JSON.stringify({ on }) + '\n')
  await refresh($)
  return on ? 'tm is on.' : 'tm is off: no list after compaction or on resume, no band. /tm:on turns it back on.'
}

const OFF = 'tm is off. /tm:on turns it back on.'

async function cmdList($: EngineInterface, args: string): Promise<string> {
  const all = await listAll($)
  const g = groups(all)
  const now = await $.clock.now()
  const section = (name: string, ts: readonly Item[], tail: (t: Item) => string = () => '') =>
    ts.length ? [`${name} (${ts.length})`, ...ts.map(t => `  ${tagged(t)}  ${clip(oneLine(t.title), 80)}${tail(t)}`)] : []
  const lines = [
    ...section('Doing', g.doing),
    ...section('Needs you', g.needsYou, t => `  ${age(t.updated, now)}`),
    ...section('Ready', g.ready),
    ...section('Blocked', g.blocked, t => (t.waits_on ? `  waits on ${clip(oneLine(t.waits_on), 40)}` : t.after.length ? `  after ${t.after.join(',')}` : '')),
    ...(/\ball\b/i.test(args) ? section('Done', g.done) : g.done.length ? [`Done (${g.done.length}): /tm:list all`] : []),
  ]
  const body = lines.length ? lines.join('\n') : 'No tasks. /tm:add <title> files one.'
  return (await isOn($)) ? body : `${OFF}\n${body}`
}

async function cmdImport($: EngineInterface, args: string): Promise<string> {
  const given = args.trim()
  if (!given) return usage('/tm:import <path to a TODO.jsonl>')
  const path = given.startsWith('~/') ? `${await $.env.get('HOME')}${given.slice(1)}` : given
  let text: string
  try {
    text = String(await $.fs.read(path))
  } catch (err) {
    return `Could not read ${path}: ${String(err)}`
  }
  const all = await listAll($)
  const done = importRows(text, all.filter(t => t.global), iso(await $.clock.now()), all.map(t => t.id))
  if (done.tasks.length) await commit($, true, done.tasks)
  return [
    `Imported ${done.tasks.length} into the global list; ${done.skipped} already there.`,
    ...(done.unmapped.length ? [`Not mapped (${done.unmapped.length}): ${done.unmapped.join('; ')}`] : []),
    ...(done.flagged.length ? [`Open or planned with a blocked_by, imported as todo (${done.flagged.length}): ${done.flagged.join('; ')}`] : []),
  ].join('\n')
}

// --- The hooks ---

export const register: Register = on => {
  let timer: { cancel: () => void } | undefined

  on('session.start', async ($, e, next) => {
    const r = await next(e)
    await $.tool.register({
      name: 'task',
      description: [
        "tm: the project's task list, which outlasts sessions and compaction.",
        '{ add: "title", check?, parent?: id, after?: [ids], found?: true, global?: true } files a task; found: true is side work you came across: it stays todo, set parent to the task you are on and carry on with that.',
        '{ id, status?: todo|doing|blocked|done, next?, decision?, owner?, evidence? } updates one: next is the next step, decision logs a choice; done needs evidence (what you ran or saw). A check on a task is the person\'s: you cannot change it.',
        '{ ask: "question", why? } puts a question to the person and moves on. { list: true } shows the list.',
      ].join(' '),
      inputSchema: {
        type: 'object',
        properties: {
          add: { type: 'string' }, check: { type: 'string' }, parent: { type: 'string' }, after: { type: 'array', items: { type: 'string' } },
          found: { type: 'boolean' }, global: { type: 'boolean' },
          id: { type: 'string' }, status: { type: 'string', enum: [...STATUSES] }, next: { type: 'string' }, decision: { type: 'string' },
          owner: { type: 'string' }, evidence: { type: 'string' },
          ask: { type: 'string' }, why: { type: 'string' }, list: { type: 'boolean' },
        },
      },
    })
    await $.command.register({ name: 'tm', description: 'tm: the task list' })
    try {
      await refresh($)
      timer?.cancel()
      timer = $.clock.every(5000, () => void refresh($).catch(err => $.ui.log(`tm: refresh failed: ${String(err)}`)))
      await resume($)
    } catch (err) {
      $.ui.log(`tm: could not load the task list: ${String(err)}`)
    }
    return r
  })

  on('tool.call', { tool: TOOL }, async ($, e) => ({ result: await taskTool($, e as unknown as ToolIn) }))

  // The engine's own task tools run as they do; the result then says what to mirror.
  on('tool.call', { tool: 'TaskCreate' }, async ($, e, next) => {
    const r = await next(e)
    const task = (r.result as { task?: { id: string; subject: string } } | undefined)?.task
    if (r.deny !== undefined || r.isError || !task) return r
    await mirrorCreate($, task.id, task.subject, e.description).catch(err => $.ui.log(`tm: could not mirror TaskCreate: ${String(err)}`))
    return r
  })

  on('tool.call', { tool: 'TaskUpdate' }, async ($, e, next) => {
    const r = await next(e)
    if (r.deny !== undefined || r.isError || (r.result as { success?: boolean } | undefined)?.success !== true) return r
    await mirrorUpdate($, e as unknown as TaskUpdateIn).catch(err => $.ui.log(`tm: could not mirror TaskUpdate: ${String(err)}`))
    return r
  })

  // The list goes back in after the summary, and after om's note when om put one there.
  on('session.compact', async ($, e, next) => {
    if (e.trigger === 'precompute' || e.agentId !== undefined) return next(e)
    const done = await next(e)
    if (done.skip !== undefined || !(await isOn($))) return done
    const text = await injection($)
    return text ? { ...done, messages: withNote(done.messages, text) } : done
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey || !(await isOn($))) return next(e)
    const rows = bandRows(groups(await read($, view)), Math.max(2, Math.min(MAX_ROWS, e.props.maxRows)))
    if (!rows.length) return next(e)
    const now = await $.clock.now()
    const { Box, Text, Button } = $.ui.resolve(e)
    return (
      <Box flexDirection="column">
        {rows.map(r => {
          if (r.kind === 'more') return <Button key="more" label={moreLabel(r.hidden)} plain dimColor onPress={() => void openList($)} />
          const { head, tail } = rowParts(r.task, r.kind, now, e.props.bodyColumns)
          const color = r.kind === 'needs' ? C.peach : r.kind === 'doing' ? C.subtext1 : C.overlay0
          return (
            <Box key={`${r.task.id}`} flexDirection="row">
              <Text color={color}>▸ </Text>
              <Button key={ROW + r.task.id} label={head} plain dimColor={r.kind === 'ready'} onPress={() => void openTask($, r.task.id)} />
              <Text color={color} wrap="truncate-end">{tail}</Text>
            </Box>
          )
        })}
        {await next(e)}
      </Box>
    )
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Button } = $.ui.resolve(e)
    const items = await read($, view)
    const now = await $.clock.now()
    const openId = await read($, open)
    const task = openId ? items.find(t => t.id === openId) : undefined
    const off = (await isOn($)) ? null : <Text color={C.peach}>{OFF}</Text>

    if (task) {
      const subtasks = items.filter(t => t.parent === task.id)
      const waits = task.waits_on === 'user' ? ' · waits on you' : task.waits_on ? ` · waits on ${task.waits_on}` : ''
      return (
        <Box flexDirection="column">
          {off}
          <Text bold color={C.mauve}>{`${tagged(task)}  ${task.title}`}</Text>
          <Text dimColor>{`${task.status}${waits} · updated ${age(task.updated, now)} ago${task.found ? ' · found by Claude' : ''}`}</Text>
          {task.check ? <Text color={C.peach}>{`🔒 check: ${task.check}`}</Text> : null}
          {task.evidence ? <Text color={C.green}>{`evidence: ${task.evidence}`}</Text> : null}
          {task.next ? <Text>{`next: ${task.next}`}</Text> : null}
          {task.decisions.length ? <Text dimColor>decisions</Text> : null}
          {task.decisions.map((d, i) => <Text key={`${i}`} color={C.subtext1}>{`  ${d.at.slice(0, 16).replace('T', ' ')}  ${d.text}`}</Text>)}
          {task.after.length ? <Text dimColor>{`after ${task.after.join(', ')}`}</Text> : null}
          {subtasks.length ? <Text dimColor>subtasks</Text> : null}
          {subtasks.map(s => <Button key={ROW + s.id} label={`  ${tagged(s)}  ${clip(oneLine(s.title), 60)}  ${s.status}`} plain onPress={() => void update($, open, () => s.id)} />)}
          <Text dimColor>{[task.owner ? `owner ${task.owner}` : null, task.area ? `area ${task.area}` : null].filter(Boolean).join(' · ')}</Text>
          <Box flexDirection="row" marginTop={1}>
            <Button key="doing" label="Doing" hotkey="1" onPress={() => void setStatus($, task.id, 'doing')} />
            <Text> </Text>
            <Button key="done" label="Done" hotkey="2" onPress={() => void setStatus($, task.id, 'done')} />
            <Text> </Text>
            <Button key="todo" label="Todo" hotkey="3" onPress={() => void setStatus($, task.id, 'todo')} />
            <Text> </Text>
            <Button key="back" label="Back" hotkey="b" onPress={() => void update($, open, () => null)} />
          </Box>
        </Box>
      )
    }

    const g = groups(items)
    const section = (name: string, ts: readonly Item[], first = false) =>
      ts.length ? (
        <Box key={name} flexDirection="column">
          <Text bold color={name === 'Needs you' ? C.peach : C.subtext1}>{`${name} (${ts.length})`}</Text>
          {ts.map((t, i) => (
            <Button key={ROW + t.id} label={`  ${tagged(t)}  ${clip(oneLine(t.title), Math.max(10, e.props.bodyColumns - 14))}`} plain dimColor={name === 'Blocked'} autoFocus={first && i === 0 ? true : undefined} onPress={() => void update($, open, () => t.id)} />
          ))}
        </Box>
      ) : null
    if (!items.length) return <Box flexDirection="column">{off}<Text dimColor>{'No tasks yet. /tm:add <title> files one.'}</Text></Box>
    return (
      <Box flexDirection="column">
        {off}
        {section('Doing', g.doing, true)}
        {section('Ready', g.ready, !g.doing.length)}
        {section('Blocked', g.blocked, !g.doing.length && !g.ready.length)}
        {section('Needs you', g.needsYou, !g.doing.length && !g.ready.length && !g.blocked.length)}
        {g.done.length ? <Text dimColor>{`Done (${g.done.length}): /tm:list all`}</Text> : null}
        <Text dimColor>Tab moves · Enter opens a task · Esc closes</Text>
      </Box>
    )
  })

  on('command.run', { command: 'tm' }, async $ => {
    await refresh($)
    await openList($)
    return { text: (await isOn($)) ? 'Opened the task list.' : `${OFF} Opened the task list.` }
  })

  on('command.run', { command: 'tm:on' }, async $ => ({ text: await cmdSwitch($, true) }))
  on('command.run', { command: 'tm:off' }, async $ => ({ text: await cmdSwitch($, false) }))
  on('command.run', { command: 'tm:add' }, async ($, e) => ({ text: await cmdAdd($, e.args) }))
  on('command.run', { command: 'tm:next' }, async $ => ({ text: await cmdNext($) }))
  on('command.run', { command: 'tm:done' }, async ($, e) => ({ text: await cmdDone($, e.args) }))
  on('command.run', { command: 'tm:block' }, async ($, e) => ({ text: await cmdBlock($, e.args) }))
  on('command.run', { command: 'tm:note' }, async ($, e) => ({ text: await cmdNote($, e.args) }))
  on('command.run', { command: 'tm:list' }, async ($, e) => ({ text: await cmdList($, e.args) }))
  on('command.run', { command: 'tm:import' }, async ($, e) => ({ text: await cmdImport($, e.args) }))
}

// A resumed session (it has messages) is told the list once; a reload does not repeat it.
async function resume($: EngineInterface) {
  const k = `injected:${await $.session.id()}`
  if ((await $.store.get(k)) === true || !(await isOn($)) || !(await $.session.messages()).length) return
  const text = await injection($)
  if (text && (await append($, text))) await $.store.set(k, true)
}
