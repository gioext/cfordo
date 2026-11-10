// Increment for structural changes to schema.sql. A new version starts with empty tables.
export const SCHEMA_VERSION = 4;
export const SCHEMA_PREFIX = `cfordo_v${SCHEMA_VERSION}_`;

export const tables = {
  goals: `${SCHEMA_PREFIX}goals`,
  attempts: `${SCHEMA_PREFIX}attempts`,
} as const;
