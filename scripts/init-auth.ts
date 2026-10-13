import { getReadyAuth } from "../src/server/auth";
import { closeDatabases } from "../src/server/database";

async function main() {
  await getReadyAuth();
  console.log("Auth schema and application tables are ready.");
}

main()
  .then(() => {
    closeDatabases();
    process.exit(0);
  })
  .catch((error) => {
    console.error(
      "Auth initialization failed:",
      error instanceof Error ? error.message : "unknown error",
    );
    process.exit(1);
  });
