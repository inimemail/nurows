import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import {once} from 'node:events';
import {spawn,execFileSync} from 'node:child_process';
import Database from 'better-sqlite3';
const repo=path.resolve(import.meta.dirname,'..');
async function temporary(t){const root=await fs.mkdtemp(path.join(os.tmpdir(),'nurossh-tg-backup-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));return root;}
async function execute(args,env={}){const child=spawn(process.execPath,args,{cwd:repo,env:{...process.env,...env},stdio:['ignore','pipe','pipe']});let error='';child.stderr.on('data',d=>error+=d);const [code]=await once(child,'exit');return {code,error};}
test('backups freeze hosted profiles before copying and always release the worker on copy failure',async t=>{
 const root=await temporary(t),data=path.join(root,'data'),key=path.join(root,'master.key'),socket=path.join(root,'worker.sock');await fs.mkdir(data);await fs.writeFile(key,'a'.repeat(64),{mode:0o600});
 const db=new Database(path.join(data,'app.db'));db.exec('CREATE TABLE app_kv(key TEXT PRIMARY KEY,value TEXT); CREATE TABLE tg_hosting_accounts(id TEXT PRIMARY KEY,name TEXT,value TEXT); CREATE TABLE tg_hosting_settings(id INTEGER PRIMARY KEY,value TEXT);');
 db.prepare('INSERT INTO app_kv VALUES(?,?)').run('secret','b'.repeat(64));db.prepare('INSERT INTO tg_hosting_accounts VALUES(?,?,?)').run('11111111-1111-4111-8111-111111111111','fixture',JSON.stringify({id:'11111111-1111-4111-8111-111111111111',desired:true}));db.close();
 const calls=[];const worker=http.createServer(async(req,res)=>{let text='';for await(const chunk of req)text+=chunk;const body=JSON.parse(text||'{}');calls.push(req.url);if(req.url==='/configure'){assert.match(body.key,/^[a-f0-9]{64}$/);assert.equal(body.accounts.length,1);}if(req.url==='/backup/start')await fs.writeFile(path.join(data,'snapshot.enc'),'encrypted fixture');res.setHeader('Content-Type','application/json');res.end(JSON.stringify(req.url==='/backup/start'?{token:'lease'}:{ok:true}));});worker.listen(socket);await once(worker,'listening');t.after(()=>new Promise(r=>worker.close(r)));
 const env={MASTER_KEY_FILE:key,TG_HOSTING_SOCKET:socket};
 let result=await execute(['server/storage-backup.js',data,path.join(data,'.backup-ok'),path.join(data,'app.db')],env);assert.equal(result.code,0,result.error);assert.deepEqual(calls,['/configure','/backup/start','/backup/end']);assert.equal(await fs.readFile(path.join(data,'.backup-ok','snapshot.enc'),'utf8'),'encrypted fixture');
 calls.length=0;await fs.symlink('/not-a-file',path.join(data,'unsafe-link'));
 result=await execute(['server/storage-backup.js',data,path.join(data,'.backup-failed'),path.join(data,'app.db')],env);assert.notEqual(result.code,0);assert.match(result.error,/symbolic link/);assert.deepEqual(calls,['/configure','/backup/start','/backup/end']);
});
test('profile archive preserves binary data, excludes temporary archives and rejects traversal and links',async t=>{
 const root=await temporary(t),profile=path.join(root,'profile');await fs.mkdir(profile);const script=path.join(root,'archive.py');let source=await fs.readFile(path.join(repo,'tg-hosting/profile-archive.py'),'utf8');source=source.replace("root = Path('/profile')",`root = Path(${JSON.stringify(profile)})`);await fs.writeFile(script,source);
 const original=Buffer.from(Array.from({length:65536},(_,i)=>i%256));await fs.writeFile(path.join(profile,'session'),original);await fs.writeFile(path.join(profile,'.tg-snapshot-stale.tar.gz'),'stale');await fs.symlink('/etc/passwd',path.join(profile,'SingletonLock'));
 const archive=path.join(profile,'.tg-snapshot-test.tar.gz');execFileSync('python3',[script,'pack',archive]);const copy=path.join(root,'copy.tar.gz');await fs.copyFile(archive,copy);await fs.rm(profile,{recursive:true});await fs.mkdir(profile);execFileSync('python3',[script,'extract',copy]);assert.deepEqual(await fs.readFile(path.join(profile,'session')),original);assert.deepEqual(await fs.readdir(profile),['session']);
 for(const kind of ['traversal','symlink']){
  const unsafe=path.join(root,kind+'.tar.gz');execFileSync('python3',['-c',`import tarfile,io,sys\nt=tarfile.open(sys.argv[1],'w:gz')\ni=tarfile.TarInfo('../escaped' if sys.argv[2]=='traversal' else 'linked')\ni.type=tarfile.SYMTYPE if sys.argv[2]=='symlink' else tarfile.REGTYPE\ni.linkname='/etc/passwd'\nt.addfile(i)\nt.close()`,unsafe,kind]);
  assert.throws(()=>execFileSync('python3',[script,'extract',unsafe],{stdio:'pipe'}));assert.deepEqual(await fs.readFile(path.join(profile,'session')),original);
 }
});
test('optional deployment preserves Compose overrides and isolates the Docker socket from the panel',async t=>{
 try { execFileSync('docker',['compose','version'],{stdio:'pipe'}); } catch { t.skip('Docker Compose is not installed'); return; }
 const root=await temporary(t);await fs.mkdir(path.join(root,'app'));await fs.copyFile(path.join(repo,'docker-compose.tg.yml'),path.join(root,'app/docker-compose.tg.yml'));await fs.writeFile(path.join(root,'.env'),'TG_HOSTING_ENABLED=1\n');await fs.writeFile(path.join(root,'docker-compose.yml'),'services:\n  nurossh:\n    image: fixture\n');await fs.writeFile(path.join(root,'docker-compose.override.yml'),'services:\n  nurossh:\n    environment:\n      FIXTURE: kept\n');
 execFileSync('bash',['-c','source "$1/install.sh"; chown(){ :; }; ensure_storage_mount "$2"','_',repo,root]);
 const config=JSON.parse(execFileSync('docker',['compose','-f','docker-compose.yml','-f','docker-compose.override.yml','-f','docker-compose.storage.yml','-f','docker-compose.tg.yml','config','--format','json'],{cwd:root,encoding:'utf8'}));
 assert.equal(config.services.nurossh.environment.FIXTURE,'kept');assert.ok(config.services['tg-runner'].volumes.some(v=>v.target==='/var/run/docker.sock'));assert.ok(!config.services.nurossh.volumes.some(v=>v.target==='/var/run/docker.sock'));assert.equal(config.services['tg-runner'].build.context,await fs.realpath(path.join(root,'app')));assert.equal(config.services['tg-runner'].ports,undefined);
 const merged=JSON.parse(execFileSync('bash',['-c','source "$1/install.sh"; compose_cmd config --format json','_',repo],{cwd:root,encoding:'utf8'}));assert.equal(merged.services.nurossh.environment.FIXTURE,'kept');assert.ok(merged.services['tg-runner']);
});
test('component readiness waits for the panel socket and fails instead of claiming success when disconnected',()=>{
 const command='source "$1/install.sh"; attempts=0; fixture_min=$2; sleep(){ :; }; compose_cmd(){ attempts=$((attempts+1)); [[ "$*" == *TG_HOSTING_SOCKET* ]] || exit 9; (( attempts >= fixture_min )); }; wait_tg_hosting_ready; result=$?; printf "%s %s" "$result" "$attempts"';
 const success=execFileSync('bash',['-c',command,'_',repo,'3'],{encoding:'utf8'});assert.equal(success,'0 3');
 const failure=execFileSync('bash',['-c',command.replace('wait_tg_hosting_ready; result=$?','set +e; wait_tg_hosting_ready; result=$?'),'_',repo,'99'],{encoding:'utf8'});assert.equal(failure,'1 30');
});
test('restoring hosted sessions writes a fresh private takeover marker, including repeated restores',async t=>{
 const root=await temporary(t),data=path.join(root,'data');await fs.mkdir(data);await fs.writeFile(path.join(root,'.env'),'SQLITE_DB_PATH=/app/data/app.db\nTG_HOSTING_ENABLED=1\n');
 const db=new Database(path.join(data,'app.db'));db.exec('CREATE TABLE tg_hosting_accounts(id TEXT PRIMARY KEY,name TEXT,value TEXT)');
 const mark=()=>execFileSync('bash',['-c','source "$1/install.sh"; mark_tg_hosting_restore "$2"','_',repo,root]);
 mark();await assert.rejects(fs.stat(path.join(data,'.tg-hosting-restored.json')),error=>error.code==='ENOENT');
 db.prepare('INSERT INTO tg_hosting_accounts VALUES(?,?,?)').run('11111111-1111-4111-8111-111111111111','fixture','{}');db.close();
 mark();const first=JSON.parse(await fs.readFile(path.join(data,'.tg-hosting-restored.json'),'utf8'));assert.match(first.id,/^[a-f0-9-]{36}$/);assert.equal((await fs.stat(path.join(data,'.tg-hosting-restored.json'))).mode&0o777,0o600);
 mark();const second=JSON.parse(await fs.readFile(path.join(data,'.tg-hosting-restored.json'),'utf8'));assert.notEqual(first.id,second.id);
});
test('backing up a restored inactive machine never activates its saved desired sessions',async t=>{
 const root=await temporary(t),data=path.join(root,'data'),key=path.join(root,'master.key'),socket=path.join(root,'worker.sock');await fs.mkdir(data);await fs.writeFile(key,'a'.repeat(64),{mode:0o600});
 const marker={id:'22222222-2222-4222-8222-222222222222'};await fs.writeFile(path.join(data,'.tg-hosting-restored.json'),JSON.stringify(marker));
 const db=new Database(path.join(data,'app.db'));db.exec('CREATE TABLE app_kv(key TEXT PRIMARY KEY,value TEXT);CREATE TABLE tg_hosting_accounts(id TEXT PRIMARY KEY,name TEXT,value TEXT);CREATE TABLE tg_hosting_settings(id INTEGER PRIMARY KEY,value TEXT);');db.prepare('INSERT INTO app_kv VALUES(?,?)').run('secret','b'.repeat(64));db.prepare('INSERT INTO tg_hosting_accounts VALUES(?,?,?)').run('11111111-1111-4111-8111-111111111111','fixture',JSON.stringify({id:'11111111-1111-4111-8111-111111111111',desired:true}));db.close();
 let configured;const worker=http.createServer(async(req,res)=>{let text='';for await(const chunk of req)text+=chunk;if(req.url==='/configure')configured=JSON.parse(text);res.setHeader('Content-Type','application/json');res.end(JSON.stringify(req.url==='/backup/start'?{token:'lease'}:{ok:true}));});worker.listen(socket);await once(worker,'listening');t.after(()=>new Promise(r=>worker.close(r)));
 const result=await execute(['server/storage-backup.js',data,path.join(data,'.backup-held'),path.join(data,'app.db')],{MASTER_KEY_FILE:key,TG_HOSTING_SOCKET:socket});assert.equal(result.code,0,result.error);assert.equal(configured.migrationHold,true);assert.equal(configured.accounts[0].desired,false);
});

test('restoring an expanded profile refuses low disk before touching any existing files',async t=>{
 const root=await temporary(t),profile=path.join(root,'profile');await fs.mkdir(profile);const session=Buffer.from('the-only-session');await fs.writeFile(path.join(profile,'session'),session);
 let source=await fs.readFile(path.join(repo,'tg-hosting/profile-archive.py'),'utf8');source=source.replace("root = Path('/profile')",`root = Path(${JSON.stringify(profile)})`);
 const script=path.join(root,'archive.py');await fs.writeFile(script,source);const packed=path.join(profile,'.tg-snapshot-test.tar.gz');execFileSync('python3',[script,'pack',packed]);const saved=await fs.readFile(packed);
 source=source.replace('disk = os.statvfs(root)','disk = type("Disk", (), {"f_blocks": 1024**3, "f_frsize": 1, "f_bavail": 0})()');await fs.writeFile(script,source);
 assert.throws(()=>execFileSync('python3',[script,'extract',packed],{stdio:'pipe'}),error=>error.stderr.toString().includes('insufficient restore space'));
 assert.deepEqual(await fs.readFile(path.join(profile,'session')),session);assert.deepEqual(await fs.readFile(packed),saved);
});
