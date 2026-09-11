import Database from "better-sqlite3";

export function openDatabase(path: string): Database.Database {
  const db = new Database(path);
  db.pragma("foreign_keys = ON");

  if (path !== ":memory:") {
    db.pragma("journal_mode = WAL");
  }

  return db;
}
