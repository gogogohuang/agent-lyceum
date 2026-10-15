import type { Report } from '../types'
import { blockLines, blocks, layout, leadLink, padCenter, type Block, type Tone } from './graph'

// The resolved `Box` / `Text` of `$.ui.resolve(e)`. Typed loosely here: the pure model in graph.ts carries the logic.
type Ui = { Box: any; Text: any }

const toneProps = (t?: Tone) =>
  t === 'bold' ? { bold: true } : t === 'dim' ? { dimColor: true } : t === 'ok' ? { color: 'green' } : t === 'warn' ? { color: 'yellow' } : t === 'bad' ? { color: 'red' } : {}

/**
 * One bordered block per agent; between the lead and each member a glyph shows who may write to whom (yellow = the latest hand-off).
 * A block whose agent is working wraps its text instead of cutting it, and a working member has a full-width row.
 */
export function graphView({ Box, Text }: Ui, report: Report, now: number, width: number) {
  const bs = blocks(report, now)
  const lay = layout(bs, width)
  const card = (b: Block, w: number) => (
    <Box flexDirection="column" borderStyle="round" borderColor={b.dot === 'active' ? 'green' : b.dot === 'failed' ? 'red' : undefined} width={w} paddingX={1}>
      {blockLines(b).map(l => (
        <Text wrap={b.dot === 'active' ? 'wrap' : 'truncate-end'} {...toneProps(l.tone)}>
          {l.text}
        </Text>
      ))}
    </Box>
  )
  return (
    <Box flexDirection="column">
      {lay.rows.map((row, i) => (
        <Box flexDirection="column">
          {!row[0]?.lead && !lay.narrow && (
            <Box>
              {row.map(b => {
                const k = leadLink(bs, b)
                return (
                  <Box width={lay.widths[i]}>
                    <Text {...(k?.hot ? { color: 'yellow', bold: true } : { dimColor: true })}>{k ? padCenter(k.glyph, lay.widths[i]!) : ' '}</Text>
                  </Box>
                )
              })}
            </Box>
          )}
          <Box>{row.map(b => card(b, lay.widths[i]!))}</Box>
        </Box>
      ))}
    </Box>
  )
}
