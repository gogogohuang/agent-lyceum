import { expect, test } from 'claude-code/testing'
import { paneProjects } from './pane-feed'

const frame = (name: string) => ({ schema_version: 1 as const, report: { project: { name, lead: 'lead' }, agents: [] } })

test('the pane keeps only the projects it was configured to show, in the snapshot order', () => {
  const projects = [
    { name: 'beta', frame: frame('beta') },
    { name: 'alpha', frame: frame('alpha') },
    { name: 'other', frame: frame('other') },
  ]
  expect(paneProjects(projects, ['alpha', 'beta'])).toEqual([
    { name: 'beta', frame: frame('beta') },
    { name: 'alpha', frame: frame('alpha') },
  ])
})

test('an empty project list does not take the web snapshot (the pane infers one project itself)', () => {
  expect(paneProjects([{ name: 'alpha', frame: frame('alpha') }], [''])).toEqual([])
  expect(paneProjects([{ name: 'alpha', frame: frame('alpha') }], [])).toEqual([])
})
