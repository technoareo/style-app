import { runCli } from "./cli";
import { SINGLE_COMMANDS, runSingleCli } from "./single-item/cli";

// Entry point: tsx scripts/vision-evaluation/run.ts <inspect|adapt-qwen|score> ... (crowded harness, build 014)
//              tsx scripts/vision-evaluation/run.ts single-<command> ...             (single-item launch gate, build 024)
const argv = process.argv.slice(2);
process.exitCode = (SINGLE_COMMANDS as readonly string[]).includes(argv[0] ?? "") ? runSingleCli(argv) : runCli(argv);
