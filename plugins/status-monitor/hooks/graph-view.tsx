import type { Report } from '../types'
import { blocks, treeGroups, type Dot, type Tone } from './graph'

// The resolved `Box` / `Text` of `$.ui.resolve(e)`. Typed loosely here: the pure model in graph.ts carries the logic.
type Ui = { Box: any; Text: any }

const toneProps = (t?: Tone) =>
  t === 'bold' ? { bold: true } : t === 'dim' ? { dimColor: true } : t === 'ok' ? { color: 'green' } : t === 'warn' ? { color: 'yellow' } : t === 'bad' ? { color: 'red' } : {}

/** The frame takes the colour of the agent's state; an idle agent gets a dim one. */
const frameProps = (d: Dot) => (d === 'active' ? { borderColor: 'green' } : d === 'failed' ? { borderColor: 'red' } : d === 'queued' ? { borderColor: 'yellow' } : { borderColor: 'gray', borderDimColor: true })

/**
 * The agents as a tree: the lead on top, a branch to each member (see `treeGroups`). Each agent sits in its own frame, coloured by its state;
 * the branch stays outside, beside the frame's top edge, and a bar runs down the left of a frame that has a sibling below it.
 * Collapsed, a mail shows its point only; `expanded` shows all of it. A line wraps inside its frame rather than being cut.
 */
export function graphView({ Box, Text }: Ui, report: Report, now: number, expanded: boolean) {
  return (
    <Box flexDirection="column">
      {treeGroups(blocks(report, now), expanded).map(g => {
        const lines = g.lines.map(l => (
          <Text wrap="wrap" {...toneProps(l.tone)}>
            {l.text}
          </Text>
        ))
        return (
          <Box>
            {g.branch !== undefined && (
              <Box flexDirection="column" width={4} flexShrink={0}>
                <Text {...toneProps(g.branchTone)}>{g.branch}</Text>
                {!g.last && <Box flexGrow={1} borderStyle="single" borderTop={false} borderRight={false} borderBottom={false} borderDimColor />}
              </Box>
            )}
            {g.dot ? (
              <Box flexDirection="column" flexGrow={1} borderStyle="round" paddingX={1} {...frameProps(g.dot)}>
                {lines}
              </Box>
            ) : (
              <Box flexDirection="column">{lines}</Box>
            )}
          </Box>
        )
      })}
    </Box>
  )
}
