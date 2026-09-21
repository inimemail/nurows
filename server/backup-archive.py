"""Validate/extract deployment archives without trusting archive paths or links."""
import hashlib
import json
import re
from pathlib import Path, PurePosixPath
import shutil
import sqlite3
import sys
import tarfile

def digest(file):
    h = hashlib.sha256()
    with open(file, 'rb') as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b''):
            h.update(chunk)
    return h.hexdigest()

def validate(root):
    for required in ['.env', 'docker-compose.yml', 'app/package.json', 'app/server/index.js']:
        if not (root / required).is_file():
            raise ValueError('备份缺少文件: ' + required)
    manifest = root / 'backup-manifest.json'
    if manifest.exists():
        data = json.loads(manifest.read_text())
        if data.get('format') != 2:
            raise ValueError('不支持的备份版本')
        actual = {p.relative_to(root).as_posix() for p in root.rglob('*') if p.is_file() and p != manifest}
        if actual != set(data['files']):
            raise ValueError('备份文件清单不匹配')
        for name, checksum in data['files'].items():
            if digest(root / name) != checksum:
                raise ValueError('备份校验失败: ' + name)
    databases = 0
    app_databases = 0
    for file in (root / 'data').rglob('*'):
        if not file.is_file() or file.name.endswith(('-wal', '-shm')):
            continue
        with file.open('rb') as stream:
            header = stream.read(16)
        if header != b'SQLite format 3\0':
            continue
        databases += 1
        # Read/write on the staging copy allows recovery of a legacy WAL archive.
        with sqlite3.connect(str(file)) as db:
            if db.execute('PRAGMA quick_check').fetchall() != [('ok',)]:
                raise ValueError('数据库完整性校验失败: ' + file.name)
            tables = {r[0] for r in db.execute("SELECT name FROM sqlite_master WHERE type='table'")}
            if 'app_kv' in tables:
                app_databases += 1
                values = dict(db.execute("SELECT key,value FROM app_kv"))
                if 'auth' not in values or 'state' not in values:
                    raise ValueError('数据库缺少认证或业务数据')
                for key, value in db.execute("SELECT key,value FROM app_kv WHERE key IN ('auth','state')"):
                    if not isinstance(json.loads(value), dict):
                        raise ValueError('业务数据格式错误: ' + key)
                auth = json.loads(values['auth'])
                if not isinstance(auth.get('configured'), bool):
                    raise ValueError('认证初始化状态无效')
                if auth['configured'] and (not auth.get('username') or not re.fullmatch('[a-fA-F0-9]{32}', auth.get('salt', '')) or not re.fullmatch('[a-fA-F0-9]{128}', auth.get('hash', ''))):
                    raise ValueError('认证账户记录不完整')
    if not app_databases and not (root / 'data/state.json').exists():
        raise ValueError('备份中没有数据库或旧版业务数据')
    for name in ('state.json', 'auth.json'):
        legacy = root / 'data' / name
        if legacy.exists() and not isinstance(json.loads(legacy.read_text()), dict):
            raise ValueError('旧版业务数据格式错误: ' + name)

def extract(archive, root):
    root.mkdir(mode=0o700, parents=True, exist_ok=True)
    if any(root.iterdir()):
        raise ValueError('恢复暂存目录必须为空')
    seen, size = set(), 0
    with tarfile.open(archive, 'r:gz') as tar:
        for index, item in enumerate(tar):
            name = PurePosixPath(item.name)
            # macOS tar may emit harmless AppleDouble metadata beside regular files.
            if any(part.startswith('._') for part in name.parts):
                continue
            if name.is_absolute() or '..' in name.parts or '\\' in item.name or '\x00' in item.name:
                raise ValueError('备份包含不安全路径')
            if not (item.isfile() or item.isdir()):
                raise ValueError('备份包含链接或特殊文件')
            if name.parts and name.parts[0] not in {'app', 'data', '.env', 'docker-compose.yml', 'manage.sh', 'backup-manifest.json', 'MANIFEST'}:
                raise ValueError('备份包含未知顶层路径')
            normalized = name.as_posix()
            if normalized in seen and not item.isdir():
                raise ValueError('备份含重复文件')
            seen.add(normalized)
            size += item.size
            if index > 200000 or size > 50 * 1024**3:
                raise ValueError('备份超过恢复安全上限（50 GB / 20 万文件）')
            target = root.joinpath(*name.parts)
            if item.isdir():
                target.mkdir(parents=True, exist_ok=True, mode=0o700)
            else:
                target.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
                with tar.extractfile(item) as src, target.open('xb') as dst:
                    shutil.copyfileobj(src, dst, 1024 * 1024)
                target.chmod(0o700 if item.mode & 0o111 else 0o600)
    validate(root)

if __name__ == '__main__':
    action, *args = sys.argv[1:]
    if action == 'manifest':
        root = Path(args[0])
        files = {p.relative_to(root).as_posix(): digest(p) for p in root.rglob('*') if p.is_file() and p.name != 'backup-manifest.json'}
        (root / 'backup-manifest.json').write_text(json.dumps({'format': 2, 'files': files}, ensure_ascii=False))
    elif action == 'extract':
        extract(args[0], Path(args[1]))
    elif action == 'validate':
        validate(Path(args[0]))
    else:
        raise ValueError('未知操作')
