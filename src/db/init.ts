import schema from "./schema.sql";
import { SCHEMA_PREFIX } from "./schema.ts";
import { DatabaseError, query } from "./query.ts";
import type { DatabaseBinding } from "../types.ts";

// Split the CREATE definitions without splitting quoted values or comments.
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
  if (quote) throw new Error("Unterminated quote in schema");
  if (current.trim()) result.push(current.trim());
  return result;
}

const definitions = statements(schema.replaceAll("{{prefix}}", SCHEMA_PREFIX));

export async function initOrdo(db: DatabaseBinding): Promise<void> {
  const results = await query(
    db.batch(definitions.map((sql) => db.prepare(sql))),
  );
  const failure = results.find((result) => !result.success);
  if (failure)
    throw new DatabaseError(failure.error || "Schema creation failed");
}
