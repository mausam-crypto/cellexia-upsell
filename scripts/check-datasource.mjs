/**
 * Boot guard: DATABASE_URL set but ignored.
 *
 * This deployment uses a dual-schema setup: prisma/schema.prisma is the
 * SQLite dev schema (hardcoded "file:dev.sqlite" on purpose — never meant
 * to read DATABASE_URL) and prisma/schema.production.prisma is the Postgres
 * twin `setup:production` actually generates/pushes from. This check
 * inspects THAT file, not schema.prisma, so it can never false-positive
 * against the intentional dev hardcoding while still catching the real risk:
 * schema.production.prisma ever getting hand-patched to a literal URL, which
 * would silently write data to whatever that literal pointed at instead of
 * the real production database.
 *
 * Runs as part of `npm run setup:production` (and therefore
 * `npm run docker-start`) and turns that silent-data-loss shape into a loud,
 * actionable boot failure.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SCHEMA = path.join(ROOT, "prisma", "schema.production.prisma");

const databaseUrl = (process.env.DATABASE_URL ?? "").trim();
if (!databaseUrl) process.exit(0); // nothing set — production always sets this; nothing to check yet

let schema = "";
try {
  schema = fs.readFileSync(SCHEMA, "utf8");
} catch {
  process.exit(0); // no schema to inspect; prisma itself will complain
}

const datasource = /datasource\s+db\s*\{([\s\S]*?)\}/.exec(schema)?.[1] ?? "";
const readsEnv = /url\s*=\s*env\(\s*["']DATABASE_URL["']\s*\)/.test(datasource);
if (readsEnv) process.exit(0); // correctly wired

const hardcoded = /url\s*=\s*"([^"]+)"/.exec(datasource)?.[1] ?? "(unknown)";
console.error(`
────────────────────────────────────────────────────────────────────────────
 DATABASE_URL is set but prisma/schema.production.prisma is IGNORING it.

   DATABASE_URL                 = ${databaseUrl}
   schema.production.prisma url = "${hardcoded}"   <-- hardcoded, wins

 The app would start normally and write to "${hardcoded}" instead of the
 real production database — silently.

 Fix, in prisma/schema.production.prisma:

   datasource db {
     provider = "postgresql"
     url      = env("DATABASE_URL")
   }

 Then redeploy.
────────────────────────────────────────────────────────────────────────────
`);
process.exit(1);
