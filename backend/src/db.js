import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Pool } from "pg";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const migrationsDir = join(__dirname, "..", "migrations");

export async function createDb(logger) {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    throw new Error("DATABASE_URL is required for the backend");
  }
  const max = Number.parseInt(process.env.DB_POOL_MAX || "10", 10);
  const pool = new Pool({ connectionString, max: Number.isFinite(max) ? max : 10 });
  pool.on("error", (err) => {
    logger?.error({ err }, "Unexpected Postgres client error");
  });
  await runMigrations(pool, logger);
  return pool;
}

async function runMigrations(pool, logger) {
  await pool.query(`
    create table if not exists migrations (
      name text primary key,
      applied_at timestamptz not null default now()
    )
  `);

  const files = readdirSync(migrationsDir)
    .filter((file) => file.endsWith(".sql"))
    .sort();
  const applied = new Set(
    (await pool.query("select name from migrations order by name asc")).rows.map((row) => row.name),
  );

  for (const file of files) {
    if (applied.has(file)) {
      continue;
    }
    const sql = readFileSync(join(migrationsDir, file), "utf8");
    const client = await pool.connect();
    try {
      await client.query("begin");
      await client.query(sql);
      await client.query("insert into migrations(name) values ($1)", [file]);
      await client.query("commit");
      logger?.info({ migration: file }, "Applied migration");
    } catch (err) {
      await client.query("rollback");
      throw err;
    } finally {
      client.release();
    }
  }
}
