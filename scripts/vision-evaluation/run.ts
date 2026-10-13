import { runCli } from "./cli";

// Entry point: tsx scripts/vision-evaluation/run.ts <inspect|adapt-qwen|score> ...
process.exitCode = runCli(process.argv.slice(2));
