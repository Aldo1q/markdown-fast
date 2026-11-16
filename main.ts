// Driver for the markdown-render-speed-02 bounty entry.
// Reads the case set, renders each markdown case alone with parse(),
// and writes the HTML results in order. Runs under Node 22 with
// erasable TypeScript only and Node built-ins only.
//
// Contract: /input/cases.json is a JSON array of {id, markdown} (720
// cases, spec examples then documents). /output/html.json is a JSON
// array of the 720 HTML strings, in the cases' order. Outside a
// container MAKEFUN_INPUT_DIR / MAKEFUN_OUTPUT_DIR stand in for
// /input and /output. parse() is stateless: each case is rendered
// alone, with no state carried between calls.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from './parse.js';

type Case = { id: string; markdown: string };

function main(): void {
  const inputDir = process.env.MAKEFUN_INPUT_DIR ?? '/input';
  const outputDir = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';
  const raw = readFileSync(join(inputDir, 'cases.json'), 'utf8');
  const cases = JSON.parse(raw) as Case[];
  const html: string[] = new Array(cases.length);
  for (let k = 0; k < cases.length; k++) {
    // render each case alone; parse() keeps no state between calls
    html[k] = parse(cases[k].markdown);
  }
  mkdirSync(outputDir, { recursive: true });
  writeFileSync(join(outputDir, 'html.json'), JSON.stringify(html));
}

main();
