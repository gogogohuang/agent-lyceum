import type { Report } from '../types'

/** One project from `GET /snapshot`. `runs` is every open run, keyed by run id. */
export type PaneProject = { name: string; frame: { report?: Report; runs?: Record<string, Report>; error?: string } }

/**
 * The projects the pane shows, taken from the web server's snapshot and kept in that order.
 * An empty name (`''`, the pane infers one project from the session directory) does not use this feed.
 */
export function paneProjects(projects: readonly PaneProject[], names: readonly string[]): PaneProject[] {
  const want = new Set(names.filter(name => name !== ''))
  if (want.size === 0) return []
  return projects.filter(project => want.has(project.name))
}
