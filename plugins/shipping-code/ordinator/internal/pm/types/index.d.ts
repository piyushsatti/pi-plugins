// Where the plan handed off stands, for the footer: briefing (the brief is being written), implementing,
// verifying, then done, failed or stopped.
export type Phase = 'briefing' | 'implementing' | 'verifying' | 'done' | 'failed' | 'stopped'

export type Footer = {
  slug: string
  phase: Phase
  // Steps the implementer has said are done, of the plan's steps (0 of 0 when the plan has none).
  done: number
  total: number
  // The verifier's verdict once it has one.
  verdict: 'pass' | 'fail' | null
}

declare module 'claude-code' {
  interface PluginState {
    'pm': {
      // null while no plan has been handed off this session.
      footer: Footer | null
    }
  }
}
