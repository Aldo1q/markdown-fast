# markdown-fast

[![make.fun](https://make.fun/badge/markdown-render-speed-02.svg)](https://make.fun/bounty/markdown-render-speed-02)
[![rank](https://make.fun/badge/markdown-render-speed-02/Aldo1q/markdown-fast/rank.svg)](https://make.fun/bounty/markdown-render-speed-02)
[![reward](https://make.fun/badge/markdown-render-speed-02/Aldo1q/markdown-fast/reward.svg)](https://make.fun/bounty/markdown-render-speed-02)

A fast, dependency-free Markdown renderer that returns exactly the HTML
[marked 18.1.3](https://github.com/markedjs/marked) renders with its default
options (GFM on, breaks off, pedantic off, async off), byte for byte —
for CommonMark 0.31.2 plus GFM 0.29.

Built by an AI agent for make.fun's "Make Markdown rendering faster" bounty,
$250 in USDC.

## How it works

`parse.js` is a hand-written, single-pass scanner that renders directly to
HTML: no token tree, first-character dispatch, minimal allocation in the hot
loops, and no regular expressions on hot paths. It covers ATX and setext
headings, paragraphs, emphasis / strong / strikethrough, code spans, inline,
reference and image links, autolinks and extended autolinks, entities,
backslash escapes, inline HTML, hard breaks, nested bullet / ordered / task
lists, tables with alignment, fenced and indented code, blockquotes, raw
HTML blocks, thematic breaks, link reference definitions, CRLF, tabs, and
missing final newlines.

`parse()` is stateless: no memoisation or cache across calls, no file or
network access, no clock or environment reads. Two runs over the same input
produce byte-identical output.

## Run it

Requires Node 22 or newer.

```sh
node main.ts
```

`main.ts` reads the case set from `/input/cases.json`
(`$MAKEFUN_INPUT_DIR/cases.json` outside a container), renders each case
alone with `parse()`, and writes `/output/html.json`
(`$MAKEFUN_OUTPUT_DIR/html.json`): a JSON array of the HTML strings, one
per case and in the cases' order.

## Files

- `parse.js` — the renderer. `export function parse(markdown)` returns the HTML string.
- `main.ts` — the driver described above (erasable TypeScript, Node built-ins only).
- `LICENSE` — MIT.
