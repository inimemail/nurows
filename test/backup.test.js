import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn, execFileSync } from "node:child_process";
import { once } from "node:events";
import Database from "better-sqlite3";
import { createNotesStore } from "../server/notes-store.js";

const root = path.resolve(import.meta.dirname, "..");
async function dir(t) {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "nurossh-backup-test-"));
  t.after(() => fs.rm(tmp, { recursive: true, force: true }));
  return tmp;
}
async function run(file, args) {
  const p = spawn(file, args, { cwd: root, stdio: ["ignore", "pipe", "pipe"] });
  let output = "";
  p.stderr.on("data", (d) => (output += d));
  const [code] = await once(p, "exit");
  assert.equal(code, 0, output);
}
test("online snapshots recover committed WAL writes, independent notes and attachments", async (t) => {
  const tmp = await dir(t),
    data = path.join(tmp, "data");
  await fs.mkdir(data);
  const db = new Database(path.join(data, "custom.db"));
  db.pragma("journal_mode=WAL");
  db.pragma("wal_autocheckpoint=0");
  db.exec("CREATE TABLE app_kv(key TEXT PRIMARY KEY,value TEXT)");
  db.prepare("INSERT INTO app_kv VALUES(?,?)").run(
    "state",
    JSON.stringify({ servers: [{ name: "keep-me" }] }),
  );
  db.prepare("INSERT INTO app_kv VALUES(?,?)").run(
    "auth",
    JSON.stringify({ configured: false }),
  );
  const notes = new Database(path.join(data, "notes.db"));
  const store = createNotesStore(notes);
  const doc = store.create({
    title: "恢复测试",
    body: "<p>笔记不能丢</p>",
  }).document;
  await fs.mkdir(path.join(data, "note-attachments"));
  await fs.writeFile(
    path.join(data, "note-attachments", "fixture.txt"),
    "attachment",
  );
  const snapshot = path.join(data, ".backup-test");
  await run(process.execPath, [
    "server/storage-backup.js",
    data,
    snapshot,
    path.join(data, "custom.db"),
  ]);
  const saved = new Database(path.join(snapshot, "custom.db"));
  assert.equal(
    JSON.parse(
      saved.prepare("SELECT value FROM app_kv WHERE key='state'").get().value,
    ).servers[0].name,
    "keep-me",
  );
  assert.equal(saved.pragma("quick_check", { simple: true }), "ok");
  saved.close();
  const savedNotes = new Database(path.join(snapshot, "notes.db"));
  assert.equal(
    savedNotes.prepare("SELECT body FROM documents WHERE id=?").get(doc.id)
      .body,
    "<p>笔记不能丢</p>",
  );
  savedNotes.close();
  assert.equal(
    await fs.readFile(
      path.join(snapshot, "note-attachments", "fixture.txt"),
      "utf8",
    ),
    "attachment",
  );
  notes.close();
  db.close();
  const stage = path.join(tmp, "stage");
  await fs.mkdir(path.join(stage, "app/server"), { recursive: true });
  await fs.rename(snapshot, path.join(stage, "data"));
  await fs.writeFile(path.join(stage, "app/package.json"), "{}");
  await fs.writeFile(path.join(stage, "app/server/index.js"), "// fixture");
  await fs.writeFile(
    path.join(stage, ".env"),
    "SQLITE_DB_PATH=/app/data/custom.db\n",
  );
  await fs.writeFile(path.join(stage, "docker-compose.yml"), "services: {}");
  await run("python3", ["server/backup-archive.py", "manifest", stage]);
  const archive = path.join(tmp, "backup.tar.gz");
  execFileSync("tar", ["-czf", archive, "-C", stage, "."]);
  const extracted = path.join(tmp, "extracted");
  await run("python3", [
    "server/backup-archive.py",
    "extract",
    archive,
    extracted,
  ]);
  assert.equal(
    await fs.readFile(
      path.join(extracted, "data/note-attachments/fixture.txt"),
      "utf8",
    ),
    "attachment",
  );
  await fs.writeFile(path.join(stage, "app/package.json"), "tampered");
  execFileSync("tar", ["-czf", archive, "-C", stage, "."]);
  assert.throws(
    () =>
      execFileSync(
        "python3",
        ["server/backup-archive.py", "extract", archive, path.join(tmp, "bad")],
        { cwd: root, stdio: "pipe" },
      ),
    /备份校验失败/,
  );
});
test("restore rejects traversal and symlink archive members before writing outside staging", async (t) => {
  const tmp = await dir(t);
  const script =
    "import tarfile,io,sys\np=sys.argv[1]\nwith tarfile.open(p,'w:gz') as t:\n i=tarfile.TarInfo('../escape');i.size=1;t.addfile(i,io.BytesIO(b'x'))\n";
  execFileSync("python3", ["-c", script, path.join(tmp, "bad.tar.gz")]);
  assert.throws(
    () =>
      execFileSync(
        "python3",
        [
          "server/backup-archive.py",
          "extract",
          path.join(tmp, "bad.tar.gz"),
          path.join(tmp, "out"),
        ],
        { cwd: root, stdio: "pipe" },
      ),
    /不安全路径/,
  );
  await assert.rejects(fs.stat(path.join(tmp, "escape")));
  const links =
    "import tarfile,sys\nwith tarfile.open(sys.argv[1],'w:gz') as t:\n i=tarfile.TarInfo('data/link');i.type=tarfile.SYMTYPE;i.linkname='/etc';t.addfile(i)\n";
  execFileSync("python3", ["-c", links, path.join(tmp, "links.tar.gz")]);
  assert.throws(
    () =>
      execFileSync(
        "python3",
        [
          "server/backup-archive.py",
          "extract",
          path.join(tmp, "links.tar.gz"),
          path.join(tmp, "out2"),
        ],
        { cwd: root, stdio: "pipe" },
      ),
    /链接或特殊文件/,
  );
});
test("backup rotation keeps three completed archives and never removes unrelated files", async (t) => {
  const tmp = await dir(t);
  const names = Array.from({ length: 5 }, (_, i) => `nurossh_backup_2026092${i}_120000${i % 2 ? '_Ab1234' : ''}.tar.gz`);
  for (const [i, name] of names.entries()) {
    await fs.writeFile(path.join(tmp, name), 'completed archive fixture');
    await fs.utimes(path.join(tmp, name), 100 + i, 100 + i);
  }
  const untouched = ['manual.tar.gz', `${names[4]}.partial`, '.backup.lock'];
  for (const name of untouched) await fs.writeFile(path.join(tmp, name), 'keep');
  await fs.mkdir(path.join(tmp, 'nurossh_backup_20000101_000000.tar.gz'));
  await fs.symlink(path.join(tmp, 'manual.tar.gz'), path.join(tmp, 'nurossh_backup_20000102_000000.tar.gz'));
  const missing = 'nurossh_backup_20260925_120000_missing.tar.gz';
  assert.throws(() => execFileSync('python3', ['server/backup-archive.py', 'prune', tmp, missing], { cwd: root, stdio: 'pipe' }));
  for (const name of names) await fs.access(path.join(tmp, name));
  // A clock rollback must not delete the snapshot just created.
  await run('python3', ['server/backup-archive.py', 'prune', tmp, names[0]]);
  for (const name of [names[0], names[3], names[4], ...untouched]) await fs.access(path.join(tmp, name));
  for (const name of [names[1], names[2]]) await assert.rejects(fs.access(path.join(tmp, name)));
  assert.equal((await fs.lstat(path.join(tmp, 'nurossh_backup_20000102_000000.tar.gz'))).isSymbolicLink(), true);
});

test("upgrade environment completion preserves custom settings, quoted values and missing final newline", async (t) => {
  const tmp = await dir(t);
  await fs.writeFile(
    path.join(tmp, ".env"),
    'PORT=45678\nSQLITE_DB_PATH=/app/data/custom.db\nALLOWED_ORIGINS="https://example.test"',
  );
  execFileSync(
    "bash",
    [
      "-c",
      'source "$1"; ensure_runtime_env_file "$2"',
      "test",
      path.join(root, "install.sh"),
      tmp,
    ],
    { cwd: root, stdio: "pipe" },
  );
  const env = await fs.readFile(path.join(tmp, ".env"), "utf8");
  assert.match(env, /PORT=45678/);
  assert.match(env, /SQLITE_DB_PATH=\/app\/data\/custom.db/);
  assert.match(env, /ALLOWED_ORIGINS="https:\/\/example.test"\n/);
  assert.match(env, /HOST=0.0.0.0/);
  assert.match(env, /NODE_ENV=production/);
});

test('management script creates a restorable archive and rolls back a failed restore without losing current data',async t=>{
  const tmp=await dir(t),deployment=path.join(tmp,'deployment'),target=path.join(tmp,'restored');
  await fs.mkdir(path.join(deployment,'app/server'),{recursive:true});await fs.mkdir(path.join(deployment,'data'));
  const db=new Database(path.join(deployment,'data/custom.db'));db.exec('CREATE TABLE app_kv(key TEXT PRIMARY KEY,value TEXT)');db.prepare('INSERT INTO app_kv VALUES(?,?)').run('auth','{"configured":false}');db.prepare('INSERT INTO app_kv VALUES(?,?)').run('state','{"servers":[{"name":"old-server"}]}');db.close();
  await fs.writeFile(path.join(deployment,'.env'),'PORT=12345\nSQLITE_DB_PATH=/app/data/custom.db\nCUSTOM=preserve\n');await fs.writeFile(path.join(deployment,'docker-compose.yml'),'services: {}');await fs.writeFile(path.join(deployment,'manage.sh'),'#!/bin/bash\n');await fs.writeFile(path.join(deployment,'app/package.json'),'{}');await fs.writeFile(path.join(deployment,'app/server/index.js'),'// fixture');
  const backupScript=`source "$1/install.sh"
    ensure_host_dependencies(){ :; }; require_docker(){ :; }; require_compose(){ :; }; require_cmd(){ command -v "$1" >/dev/null || [[ "$1" == flock ]]; }; flock(){ :; }
    get_workdir(){ printf '%s' "$fixture"; }
    compose_cmd(){ if [[ "$1" == ps ]]; then printf 'fixture'; else local dest; dest="$(basename "$8")"; (cd "$repo" && node --input-type=module - "$fixture/data" "$fixture/data/$dest" "$fixture/data/custom.db"); fi; }
    repo="$1"; fixture="$2"; backup_service "$repo"`;
  execFileSync('bash',['-c',backupScript,'test',root,deployment],{cwd:root,stdio:'pipe'});
  const archive=path.join(deployment,'backups',(await fs.readdir(path.join(deployment,'backups'))).find(n=>n.endsWith('.tar.gz')));assert.ok(archive);
  await fs.mkdir(path.join(target,'data'),{recursive:true});await fs.writeFile(path.join(target,'docker-compose.yml'),'services: {}');await fs.writeFile(path.join(target,'data/do-not-lose'),'current-data');await fs.writeFile(path.join(target,'data/custom.db-wal'),'stale-wal');
  const restoreScript=`source "$1/install.sh"; ensure_host_dependencies(){ :; }; require_docker(){ :; }; require_compose(){ :; }; ensure_data_permissions(){ :; }; compose_cmd(){ [[ "$1" != up || "$FAIL_RESTORE" != 1 ]]; }; wait_service_ready(){ :; }; print_access_info(){ :; }; STATE_FILE="$2/state"; restore_service`;
  assert.throws(()=>execFileSync('bash',['-c',restoreScript,'test',root,tmp],{cwd:root,input:`${archive}\n${target}\ny\n`,env:{...process.env,FAIL_RESTORE:'1'},stdio:['pipe','pipe','pipe']}),/恢复失败/);
  assert.equal(await fs.readFile(path.join(target,'data/do-not-lose'),'utf8'),'current-data');
  execFileSync('bash',['-c',restoreScript,'test',root,tmp],{cwd:root,input:`${archive}\n${target}\ny\n`,env:{...process.env,FAIL_RESTORE:'0'},stdio:['pipe','pipe','pipe']});
  assert.match(await fs.readFile(path.join(target,'.env'),'utf8'),/CUSTOM=preserve/);await assert.rejects(fs.stat(path.join(target,'data/custom.db-wal')));
  const restored=new Database(path.join(target,'data/custom.db'),{readonly:true});assert.match(restored.prepare("SELECT value FROM app_kv WHERE key='state'").get().value,/old-server/);restored.close();
  const previous=(await fs.readdir(tmp)).find(n=>n.startsWith('restored.before-restore'));assert.equal(await fs.readFile(path.join(tmp,previous,'data/do-not-lose'),'utf8'),'current-data');
});
