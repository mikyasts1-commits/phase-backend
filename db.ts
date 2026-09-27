/**
 * Minimal Postgres pool wrapper for the Phase backend.
 *
 * Reads DATABASE_URL (e.g. postgresql://phase:<pw>@127.0.0.1:5432/phase).
 * Falls back to a tiny .env loader for standalone scripts that forgot to
 * load it themselves — only fills variables that are not already set.
 * Never logs the connection string.
 */
import { readFileSync, existsSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { Pool, type QueryResultRow } from "pg";

const here = dirname(fileURLToPath(import.meta.url));

function loadEnvFallback(): void {
  if ((process.env.DATABASE_URL ?? "").trim()) return;
  const p = join(here, ".env");
  if (!existsSync(p)) return;
  for (const line of readFileSync(p, "utf8").split("\n")) {
    const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim();
  }
}

let pool: Pool | null = null;

/** Lazily-created shared pool. Throws if DATABASE_URL is missing. */
export function getPool(): Pool {
  if (!pool) {
    loadEnvFallback();
    const cs = (process.env.DATABASE_URL ?? "").trim();
    if (!cs) {
      throw new Error(
        "DATABASE_URL is not set. Add postgresql://phase:<pw>@127.0.0.1:5432/phase to phase-backend/.env"
      );
    }
    pool = new Pool({ connectionString: cs, max: 5 });
  }
  return pool;
}

/** Run a query; returns the rows (typed by the caller). */
export async function dbQuery<T extends QueryResultRow = QueryResultRow>(
  text: string,
  params: unknown[] = []
): Promise<T[]> {
  const res = await getPool().query(text, params as unknown[]);
  return res.rows as T[];
}

/** Run a query expected to return zero or one row. */
export async function dbQueryOne<T extends QueryResultRow = QueryResultRow>(
  text: string,
  params: unknown[] = []
): Promise<T | null> {
  const rows = await dbQuery<T>(text, params);
  return rows[0] ?? null;
}

/**
 * Apply db/migrations/*.sql idempotently. Each migration file uses
 * IF NOT EXISTS throughout; the schema_migrations row records that the
 * version has been applied. Migrations run in filename order.
 */
const MIGRATION_VERSIONS = ["001", "002", "003", "004", "005", "006"];

export async function migrate(): Promise<void> {
  const dir = join(here, "db", "migrations");
  for (const version of MIGRATION_VERSIONS) {
    const match = readdirSync(dir).find(
      (f) => f.startsWith(version + "_") && f.endsWith(".sql")
    );
    if (!match) throw new Error(`migration ${version} not found in db/migrations/`);
    const sql = readFileSync(join(dir, match), "utf8");
    await getPool().query(sql);
    await getPool().query(
      "INSERT INTO schema_migrations(version) VALUES ($1) ON CONFLICT DO NOTHING",
      [version]
    );
  }
}

/** Close the pool. Tests call this so the process can exit cleanly. */
export async function closeDb(): Promise<void> {
  if (pool) {
    await pool.end();
    pool = null;
  }
}
