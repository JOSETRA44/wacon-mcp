import { runDaemon } from "./server.js";

runDaemon().catch((err) => {
  console.error("[wacon] daemon crashed:", err);
  process.exit(1);
});
