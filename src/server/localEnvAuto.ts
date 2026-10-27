import { loadLocalEnvFiles } from "./localEnv";

// Imported FIRST by the standalone analysis worker (ES imports run in order),
// so every later module sees the same environment the Next.js web process gets
// from .env.local / .env. See loadLocalEnvFiles for the rules.
loadLocalEnvFiles();
