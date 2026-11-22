export type TaskStatus = 'todo' | 'doing' | 'blocked' | 'done'

export type Decision = { at: string; text: string }

// One line of a tasks.jsonl. Times are ISO strings.
export type Task = {
  // 4 hex characters, unique among the project's and the global list together.
  id: string
  title: string
  status: TaskStatus
  // The done check. Once set, only the person's /tm commands change it.
  check: string | null
  // The next step, for whoever picks the task up.
  next: string | null
  decisions: Decision[]
  // Subtask of; depends on.
  parent: string | null
  after: string[]
  // 'user' puts the task in Needs you; any other text says what it waits on.
  waits_on: string | null
  // The session or agent id working on it.
  owner: string | null
  // Filed by the model mid-task.
  found: boolean
  // The built-in task id this mirrors (unique within the owner's session only), and the TODO.jsonl category/tag.
  harness_id: string | null
  area: string | null
  // What the model or person gave when closing it.
  evidence: string | null
  created: string
  updated: string
  closed: string | null
}

// A task as drawn: `global` says which of the two lists keeps it.
export type Item = Task & { global: boolean }

declare module 'claude-code' {
  interface PluginState {
    'tm': {
      // Both lists merged, for the band and the pane.
      view: Item[]
      // The task the pane shows in full; null for the list.
      open: string | null
    }
  }
}
