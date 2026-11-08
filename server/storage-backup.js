// Also executable through stdin in an older deployment's container.
import fs from "node:fs/promises";
import path from "node:path";
import Database from "better-sqlite3";

const [source, destination, configuredDatabase] = process.argv.slice(2);
if (!source || !destination || !configuredDatabase)
  throw new Error("Missing snapshot paths");
const root = path.resolve(source),
  target = path.resolve(destination),
  main = path.resolve(configuredDatabase);
let notesStorage, appKey;
async function encryptedNotesSnapshot(src, dest) {
  // Old deployments without encrypted notes never import the new native module.
  notesStorage ||= await import(path.join(process.cwd(), 'server/notes-storage.js'));
  if (!appKey) {
    const db = new Database(main, { readonly: true, fileMustExist: true });
    let stored;
    try { stored = db.prepare("SELECT value FROM app_kv WHERE key='secret'").get()?.value; } finally { db.close(); }
    const { loadStorageKey } = await import(path.join(process.cwd(), 'server/storage-key.js'));
    const file = process.env.MASTER_KEY_FILE || path.join(process.cwd(), 'secrets', 'master.key');
    appKey = Buffer.from(loadStorageKey(stored, file).key, 'hex');
  }
  const db = notesStorage.openEncryptedNotes(src, appKey, { fileMustExist: true });
  try { db.prepare('VACUUM INTO ?').run(dest); } finally { db.close(); }
  const check = notesStorage.openEncryptedNotes(dest, appKey, { readonly: true }); check.close();
}
if (
  !target.startsWith(root + path.sep + ".backup-") ||
  !main.startsWith(root + path.sep)
)
  throw new Error(
    "Database and snapshot must be in the mounted data directory",
  );
await fs.mkdir(target, { recursive: false, mode: 0o700 });
async function copyDirectory(from, to) {
  await fs.mkdir(to, { recursive: true, mode: 0o700 });
  // Snapshot metadata before copying immutable attachment files created by it.
  const entries = await fs.readdir(from, { withFileTypes: true });
  entries.sort((a, b) => Number(a.isDirectory()) - Number(b.isDirectory()));
  for (const entry of entries) {
    if (entry.name.startsWith(".backup-") || /-(wal|shm)$/.test(entry.name) || /\.encrypting(?:-(?:wal|shm|journal))?$/.test(entry.name))
      continue;
    const src = path.join(from, entry.name),
      dest = path.join(to, entry.name);
    if (entry.isSymbolicLink())
      throw new Error("Data directory contains a symbolic link: " + entry.name);
    if (entry.isDirectory()) {
      await copyDirectory(src, dest);
      continue;
    }
    if (!entry.isFile())
      throw new Error("Unsupported data file: " + entry.name);
    const fd = await fs.open(src, "r");
    const header = Buffer.alloc(16);
    await fd.read(header, 0, 16, 0);
    await fd.close();
    if (header.toString() === "SQLite format 3\0") {
      const db = new Database(src, { readonly: true, fileMustExist: true });
      try {
        await db.backup(dest, { progress: () => 100 });
      } finally {
        db.close();
      }
      const check = new Database(dest, { readonly: true });
      try {
        if (check.pragma("quick_check", { simple: true }) !== "ok")
          throw new Error("Database snapshot failed integrity check");
      } finally {
        check.close();
      }
    } else if (src === path.join(root, 'notes.db')) {
      await encryptedNotesSnapshot(src, dest);
    } else {
      if (src === main)
        throw new Error("Configured database is not a SQLite database");
      await fs.copyFile(src, dest);
    }
  }
}
await copyDirectory(root, target);
// A missing configured DB must not silently produce an empty-data backup.
try {
  await fs.access(main);
} catch {
  if (!(await fs.readdir(root)).includes("state.json"))
    throw new Error("Configured database is missing");
}
