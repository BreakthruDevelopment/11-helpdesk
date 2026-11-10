import { demoSeedConfig } from "../src/lib/demo-seed-config";

// Local only: DEMO_SEED=yes APP_URL=http://localhost:3000 DEMO_PASSWORD=<10+ chars> pnpm tsx --conditions=react-server scripts/seed-demo.mts
// Creates demo.breakthru.test accounts (3 customers, 2 agents, 1 admin) with that password and 12 tickets.
try {
  // Refuse production hosts and databases before importing any database or auth code.
  demoSeedConfig();
  const { loadDemoWorkspace } = await import("../src/lib/demo-workspace");
  // A trusted local CLI capability, never accepted from an HTTP request.
  const result = await loadDemoWorkspace({ id: "demo-seed-cli", role: "admin" }, { mode: "cli" });
  console.log(`Loaded ${result.users} demo users, ${result.tickets} tickets, ${result.messages} messages and ${result.notifications} notifications.`);
} catch (err) {
  console.error(err instanceof Error ? err.message : "Demo seed failed.");
  process.exitCode = 1;
} finally {
  const connection = globalThis as unknown as { sql?: { end(): Promise<void> } };
  await connection.sql?.end();
}
