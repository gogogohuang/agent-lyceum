#!/usr/bin/env node
// Reports what it was started with, as Claude's JSON result: its argv, its whole environment, and the file given to --settings.
// For enrolled-agent tests: no environment key is read, so the environment under test is not polluted.
import fs from "node:fs";

const args = process.argv.slice(2);
fs.readFileSync(0, "utf8");
const i = args.indexOf("--settings");
const report = { args, env: process.env, settings: i >= 0 ? fs.readFileSync(args[i + 1], "utf8") : null };
process.stdout.write(JSON.stringify({ result: JSON.stringify(report), session_id: "s", usage: { output_tokens: 1 } }));
