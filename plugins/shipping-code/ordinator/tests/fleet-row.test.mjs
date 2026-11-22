import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import test from 'node:test'
import assert from 'node:assert/strict'

const launcher = readFileSync(new URL('../bin/ordinator-launch-impl', import.meta.url), 'utf8')
// Source only these definitions so the tests cannot launch sessions or change project settings.
const functions = ['fleet_line_no', 'set_fleet_state', 'delete_fleet_row'].map(name => {
  const definition = launcher.match(new RegExp(`^${name}\\(\\) \\{(?:[^\\n]*\\}|[\\s\\S]*?^\\})`, 'm'))
  assert.ok(definition, `${name} definition missing`)
  return definition[0]
}).join('\n')

const before = '# Fleet\n\n| session | ticket | worktree | branch | base | date | state | PR | status | claude id |\n| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |\n| other.impl--ONE | ONE | /tmp/one | one | main | 2026-10-28 | launched | - | live | - |\n'
const oldRow = '| example.impl--TWO | TWO | /tmp/two | two | main | 2026-10-28 | launching | - | live | - |\n'
const after = '| other.impl--THREE | THREE | /tmp/three | three | main | 2026-10-28 | launched | - | live | - |\n\nUnrelated text with #, &, \\n and trailing spaces.  \n'

function run(t, command, facts = {}, contents = before + oldRow + after) {
  const dir = mkdtempSync(path.join(tmpdir(), 'ordinator-fleet-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const fleet = path.join(dir, 'fleet.md')
  writeFileSync(fleet, contents)
  const result = spawnSync('/bin/bash', ['-euo', 'pipefail', '-c', `${functions}\n${command}`], {
    encoding: 'utf8',
    env: {
      ...process.env, PATH: '/usr/bin:/bin', FLEET_MD: fleet,
      NAME: 'example.impl--TWO', KEY: 'TWO', WT: '/tmp/two', BRANCH: 'two',
      BASE: 'main', TODAY: '2026-10-28', ...facts,
    },
  })
  assert.equal(result.status, 0, result.stderr)
  assert.equal(result.stderr, '')
  return readFileSync(fleet)
}

test('set_fleet_state replaces only the selected fleet row', t => {
  const actual = run(t, 'set_fleet_state launched example-session')
  const row = '| example.impl--TWO | TWO | /tmp/two | two | main | 2026-10-28 | launched | - | live | example-session |\n'
  assert.deepEqual(actual, Buffer.from(before + row + after))
})

test('set_fleet_state preserves #, & and backslashes literally', t => {
  const actual = run(t, 'set_fleet_state launched example-session', {
    WT: String.raw`/tmp/worktree#&\new\ticket`, BRANCH: String.raw`feature#&\new\ticket`,
  })
  const row = String.raw`| example.impl--TWO | TWO | /tmp/worktree#&\new\ticket | feature#&\new\ticket | main | 2026-10-28 | launched | - | live | example-session |` + '\n'
  assert.deepEqual(actual, Buffer.from(before + row + after))
})

test('delete_fleet_row removes only the selected row after a literal update', t => {
  const actual = run(t, 'set_fleet_state launched example-session\ndelete_fleet_row', {
    WT: String.raw`/tmp/worktree#&\new\ticket`, BRANCH: String.raw`feature#&\new\ticket`,
  })
  assert.deepEqual(actual, Buffer.from(before + after))
})

test('delete_fleet_row removes only the selected fleet row', t => {
  assert.deepEqual(run(t, 'delete_fleet_row'), Buffer.from(before + after))
})

test('set_fleet_state leaves an unrelated final line unterminated', t => {
  const actual = run(t, 'set_fleet_state launched example-session', {}, before + oldRow + after.trimEnd())
  const row = '| example.impl--TWO | TWO | /tmp/two | two | main | 2026-10-28 | launched | - | live | example-session |\n'
  assert.deepEqual(actual, Buffer.from(before + row + after.trimEnd()))
})

test('delete_fleet_row leaves an unrelated final line unterminated', t => {
  const actual = run(t, 'delete_fleet_row', {}, before + oldRow + after.trimEnd())
  assert.deepEqual(actual, Buffer.from(before + after.trimEnd()))
})

test('deleting an unterminated final row keeps the preceding newline', t => {
  const actual = run(t, 'delete_fleet_row', {}, before + oldRow.trimEnd())
  assert.deepEqual(actual, Buffer.from(before))
})
