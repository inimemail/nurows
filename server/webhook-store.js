import { randomUUID } from 'node:crypto';

export const WEBHOOK_ACTIVE = ['queued', 'running', 'waiting_guard'];
export function createWebhookStore(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS webhook_tasks (id TEXT PRIMARY KEY, name TEXT NOT NULL COLLATE NOCASE UNIQUE, body TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS webhook_runs (id TEXT PRIMARY KEY, task_id TEXT NOT NULL, status TEXT NOT NULL, created INTEGER NOT NULL, body TEXT NOT NULL, output TEXT NOT NULL DEFAULT '');
    CREATE UNIQUE INDEX IF NOT EXISTS webhook_active_task ON webhook_runs(task_id) WHERE status IN ('queued','running','waiting_guard');
    CREATE INDEX IF NOT EXISTS webhook_run_history ON webhook_runs(task_id,created DESC);
    CREATE INDEX IF NOT EXISTS webhook_run_retention ON webhook_runs(created);
    CREATE TABLE IF NOT EXISTS webhook_calls (id TEXT PRIMARY KEY, task_id TEXT NOT NULL, run_id TEXT NOT NULL, request_key TEXT, created INTEGER NOT NULL, source TEXT NOT NULL, duplicate INTEGER NOT NULL);
    CREATE UNIQUE INDEX IF NOT EXISTS webhook_request_key ON webhook_calls(task_id,request_key) WHERE request_key IS NOT NULL;
    CREATE INDEX IF NOT EXISTS webhook_call_history ON webhook_calls(task_id,created DESC);
    CREATE INDEX IF NOT EXISTS webhook_call_run ON webhook_calls(run_id);
    CREATE INDEX IF NOT EXISTS webhook_call_retention ON webhook_calls(created);
    CREATE TABLE IF NOT EXISTS webhook_settings (id INTEGER PRIMARY KEY CHECK(id=1), body TEXT NOT NULL);
    INSERT OR IGNORE INTO webhook_settings VALUES(1,'{"concurrency":8,"queueLimit":200}');
  `);
  const statements = new Map();
  let taskSummaries;
  const sql = (query) => { if (!statements.has(query)) statements.set(query, db.prepare(query)); return statements.get(query); };
  const parse = (row) => row ? JSON.parse(row.body) : null;
  const store = {
    task: (id) => parse(sql('SELECT body FROM webhook_tasks WHERE id=?').get(id)),
    tasks: () => sql('SELECT body FROM webhook_tasks ORDER BY rowid DESC').all().map(parse),
    taskSummaries: () => taskSummaries ||= sql("SELECT json_set(json_remove(body,'$.commandEnc','$.tokenEnc','$.tokenHash'),'$.commandConfigured',json(CASE WHEN json_extract(body,'$.commandEnc') IS NOT NULL THEN 'true' ELSE 'false' END)) AS body FROM webhook_tasks ORDER BY rowid DESC").all().map(parse),
    saveTask(item) { sql('INSERT INTO webhook_tasks VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET name=excluded.name,body=excluded.body').run(item.id, item.name, JSON.stringify(item)); taskSummaries = null; },
    deleteTask(id) { sql('DELETE FROM webhook_tasks WHERE id=?').run(id); taskSummaries = null; },
    settings: () => parse(sql('SELECT body FROM webhook_settings WHERE id=1').get()),
    saveSettings: (item) => sql('UPDATE webhook_settings SET body=? WHERE id=1').run(JSON.stringify(item)),
    active: (id) => parse(sql("SELECT body FROM webhook_runs WHERE task_id=? AND status IN ('queued','running','waiting_guard')").get(id)),
    actives: () => sql("SELECT body FROM webhook_runs WHERE status IN ('queued','running','waiting_guard') ORDER BY created").all().map(parse),
    activeSummaries: () => sql("SELECT json_remove(body,'$.snapshot') AS body FROM webhook_runs WHERE status IN ('queued','running','waiting_guard') ORDER BY created").all().map(parse),
    latest: () => sql('SELECT r.body FROM webhook_tasks t JOIN webhook_runs r ON r.id=(SELECT id FROM webhook_runs WHERE task_id=t.id ORDER BY created DESC,rowid DESC LIMIT 1)').all().map(parse),
    latestSummaries: () => sql("SELECT json_remove(r.body,'$.snapshot') AS body FROM webhook_tasks t JOIN webhook_runs r ON r.id=(SELECT id FROM webhook_runs WHERE task_id=t.id ORDER BY created DESC,rowid DESC LIMIT 1)").all().map(parse),
    latestRun: (id) => parse(sql('SELECT body FROM webhook_runs WHERE task_id=? ORDER BY created DESC,rowid DESC LIMIT 1').get(id)),
    run: (id) => parse(sql('SELECT body FROM webhook_runs WHERE id=?').get(id)),
    output: (id) => sql('SELECT output FROM webhook_runs WHERE id=?').get(id)?.output || '',
    writeOutput: (id, output) => sql('UPDATE webhook_runs SET output=? WHERE id=?').run(output, id),
    saveRun(item, output) {
      sql('INSERT INTO webhook_runs(id,task_id,status,created,body) VALUES(?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET status=excluded.status,body=excluded.body')
        .run(item.id, item.taskId, item.status, item.created, JSON.stringify(item));
      if (output !== undefined) sql('UPDATE webhook_runs SET output=? WHERE id=?').run(output, item.id);
    },
    priorRequest: (id, key) => key ? sql('SELECT run_id FROM webhook_calls WHERE task_id=? AND request_key=?').get(id, key)?.run_id : null,
    call(id, runId, key, source, duplicate) {
      sql('INSERT INTO webhook_calls VALUES(?,?,?,?,?,?,?)').run(randomUUID(), id, runId, key || null, Date.now(), source, Number(duplicate));
    },
    history(kind, taskId, page = 1) {
      const table = kind === 'calls' ? 'webhook_calls' : 'webhook_runs';
      const clause = taskId ? ' WHERE task_id=?' : '';
      const args = taskId ? [taskId] : [];
      const total = sql(`SELECT count(*) AS n FROM ${table}${clause}`).get(...args).n;
      const pages = Math.max(1, Math.ceil(total / 50));
      page = Math.max(1, Math.min(pages, Number.isSafeInteger(Number(page)) ? Number(page) : 1));
      const rows = sql(`SELECT ${kind === 'calls' ? '*' : "json_remove(body,'$.snapshot') AS body"} FROM ${table}${clause} ORDER BY created DESC LIMIT 50 OFFSET ?`).all(...args, (page - 1) * 50);
      return { records: kind === 'calls' ? rows : rows.map(parse).map(({ snapshot, ...run }) => run), total, page, pages };
    },
    clear(taskId) {
      db.transaction(() => {
        sql(`DELETE FROM webhook_calls WHERE run_id NOT IN (SELECT id FROM webhook_runs WHERE status IN ('queued','running','waiting_guard'))${taskId ? ' AND task_id=?' : ''}`).run(...(taskId ? [taskId] : []));
        sql(`DELETE FROM webhook_runs WHERE status NOT IN ('queued','running','waiting_guard')${taskId ? ' AND task_id=?' : ''}`).run(...(taskId ? [taskId] : []));
      })();
    },
    prune(now = Date.now()) {
      const cutoff = now - 7 * 86400000;
      // Bounded deletes keep a large imported database from monopolizing the event loop.
      sql("DELETE FROM webhook_calls WHERE id IN (SELECT id FROM webhook_calls WHERE created<? AND run_id NOT IN (SELECT id FROM webhook_runs WHERE status IN ('queued','running','waiting_guard')) LIMIT 500)").run(cutoff);
      sql("DELETE FROM webhook_runs WHERE id IN (SELECT id FROM webhook_runs WHERE created<? AND status NOT IN ('queued','running','waiting_guard') AND NOT EXISTS (SELECT 1 FROM webhook_calls WHERE run_id=webhook_runs.id) LIMIT 500)").run(cutoff);
    }
  };
  return store;
}
