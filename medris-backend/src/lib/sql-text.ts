/**
 * PostgreSQL's trim() / btrim() without a character list remove spaces only - not tabs or line
 * breaks, unlike JavaScript's String.prototype.trim(). Ports of database functions use these so a
 * value counts as blank exactly when the database thought so.
 */
export function sqlTrim(value: string): string {
  return value.replace(/^ +| +$/g, "");
}

/** Null, or empty after sqlTrim(). (When false, the value is a string.) */
export function isSqlBlank(value: string | null | undefined): value is null | undefined | "" {
  return value == null || sqlTrim(value) === "";
}
