import { runCli } from "./cli";
import { INTAKE_COMMANDS, runIntakeCli } from "./single-item/cli-intake";
import { SINGLE_COMMANDS, runSingleCli, runSingleRunCli } from "./single-item/cli";

// Entry point: tsx scripts/vision-evaluation/run.ts <inspect|adapt-qwen|score> ... (crowded harness, build 014)
//              tsx scripts/vision-evaluation/run.ts single-<command> ...             (single-item launch gate, build 024)
const argv = process.argv.slice(2);
async function main(): Promise<number> {
  if (argv[0] === "single-run-qwen") return runSingleRunCli(argv);
  if ((INTAKE_COMMANDS as readonly string[]).includes(argv[0] ?? "")) return runIntakeCli(argv);
  return (SINGLE_COMMANDS as readonly string[]).includes(argv[0] ?? "") ? runSingleCli(argv) : runCli(argv);
}
main().then((code) => {
  process.exitCode = code;
});
