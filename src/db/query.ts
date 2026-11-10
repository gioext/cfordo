/** Storage failures must not be persisted as exceptions from business handlers. */
export class DatabaseError extends Error {
  constructor(cause: unknown) {
    super(cause instanceof Error ? cause.message : String(cause), { cause });
    this.name = "DatabaseError";
  }
}

export async function query<T>(operation: Promise<T>): Promise<T> {
  try {
    return await operation;
  } catch (cause) {
    throw new DatabaseError(cause);
  }
}
