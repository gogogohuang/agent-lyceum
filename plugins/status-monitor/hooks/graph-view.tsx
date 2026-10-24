import type { Report } from '../types'
import { blocks, treeLines, type Tone } from './graph'

// The resolved `Box` / `Text` of `$.ui.resolve(e)`. Typed loosely here: the pure model in graph.ts carries the logic.
type Ui = { Box: any; Text: any }

const toneProps = (t?: Tone) =>
  t === 'bold' ? { bold: true } : t === 'dim' ? { dimColor: true } : t === 'ok' ? { color: 'green' } : t === 'warn' ? { color: 'yellow' } : t === 'bad' ? { color: 'red' } : {}

/**
 * The agents as a tree, one line per fact: the lead on top, a branch to each member (see `treeLines`).
 * Collapsed, a mail shows its point only; `expanded` shows all of it. A line wraps beside its branch rather than being cut.
 */
export function graphView({ Box, Text }: Ui, report: Report, now: number, expanded: boolean) {
  return (
    <Box flexDirection="column">
      {treeLines(blocks(report, now), expanded).map(l => (
        <Box>
          {l.lead && <Text {...toneProps(l.leadTone)}>{l.lead}</Text>}
          <Text wrap="wrap" {...toneProps(l.tone)}>
            {l.text}
          </Text>
        </Box>
      ))}
    </Box>
  )
}
