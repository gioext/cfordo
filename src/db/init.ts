import initial from "./migrations/0001_init.sql";
import cronIterations from "./migrations/0002_cron_iterations.sql";
import type { DatabaseBinding } from "../types.ts";

const migrations = [
  { id: 1, sql: initial },
  { id: 2, sql: cronIterations },
];

// Split our migration statements without splitting quoted values or comments.
function statements(sql: string): string[] {
  const result: string[] = [];
  let current = "";
  let quote = "";
  for (let i = 0; i < sql.length; i++) {
    const ch = sql[i];
    const next = sql[i + 1];
    if (quote) {
      current += ch;
      if (ch === quote) {
        if (next === quote) current += sql[++i];
        else quote = "";
      }
    } else if (ch === "-" && next === "-") {
      while (i < sql.length && sql[i] !== "\n") i++;
      current += "\n";
    } else if (ch === "/" && next === "*") {
      i += 2;
      while (i < sql.length && !(sql[i] === "*" && sql[i + 1] === "/")) i++;
      i++;
      current += " ";
    } else if (ch === "'" || ch === '"' || ch === "`") {
      quote = ch;
      current += ch;
    } else if (ch === "[") {
      quote = "]";
      current += ch;
    } else if (ch === ";") {
      if (current.trim()) result.push(current.trim());
      current = "";
    } else {
      current += ch;
    }
  }
  if (quote) throw new Error("Unterminated quote in migration");
  if (current.trim()) result.push(current.trim());
  return result;
}

async function appliedVersions(db: DatabaseBinding): Promise<number[]> {
  const table = await db
    .prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'cfordo_schema_versions'",
    )
    .first();
  if (!table) return [];
  const result = await db
    .prepare("SELECT id FROM cfordo_schema_versions ORDER BY id")
    .all<{ id: number }>();
  if (!result.success)
    throw new Error(result.error || "Cannot read migration versions");
  return (result.results ?? []).map((row) => row.id);
}

export async function initOrdo(db: DatabaseBinding): Promise<void> {
  const applied = await appliedVersions(db);
  if (applied.some((id, index) => migrations[index]?.id !== id)) {
    throw new Error(
      "The database has a migration version unsupported by this cfordo package",
    );
  }
  for (const migration of migrations) {
    if (applied.includes(migration.id)) continue;
    try {
      const results = await db.batch([
        ...statements(migration.sql).map((sql) => db.prepare(sql)),
        db
          .prepare(
            "INSERT INTO cfordo_schema_versions (id, applied_at) VALUES (?, ?)",
          )
          .bind(migration.id, Date.now()),
      ]);
      const failure = results.find((result) => !result.success);
      if (failure) throw new Error(failure.error || "Migration failed");
    } catch (error) {
      // A concurrent initializer may have committed the same atomic migration.
      if (!(await appliedVersions(db)).includes(migration.id)) throw error;
    }
  }
}
