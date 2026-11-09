"""Archive stopped Chromium profiles; never follow symlinks or restore unsafe paths."""
import os
from pathlib import Path, PurePosixPath
import sys
import tarfile
import shutil

root = Path('/profile')
skip = {'SingletonLock', 'SingletonSocket', 'SingletonCookie', 'Cache', 'Code Cache', 'GPUCache', 'GrShaderCache', 'ShaderCache', 'Crashpad', 'BrowserMetrics'}
limit = 2 * 1024 ** 3
if sys.argv[1] == 'pack':
    output = Path(sys.argv[2])
    if output.parent.resolve() != root.resolve() or not output.name.startswith('.tg-snapshot-') or output.suffix != '.gz':
        raise ValueError('unsafe snapshot destination')
    os.umask(0o077)
    size = count = 0
    with output.open('xb') as destination, tarfile.open(fileobj=destination, mode='w:gz', compresslevel=1) as tar:
        for parent, dirs, files in os.walk(root, followlinks=False):
            dirs[:] = [name for name in dirs if name not in skip and not (Path(parent) / name).is_symlink()]
            for name in files:
                file = Path(parent) / name
                if name in skip or name.startswith('.tg-snapshot-') or file.is_symlink() or not file.is_file():
                    continue
                size += file.stat().st_size
                count += 1
                if size > limit or count > 100000:
                    raise ValueError('profile limit')
                tar.add(file, arcname=file.relative_to(root).as_posix(), recursive=False)
elif sys.argv[1] == 'extract':
    archive = sys.argv[2]
    seen = set()
    size = 0
    with tarfile.open(archive, 'r:gz') as tar:
        for member in tar:
            name = PurePosixPath(member.name)
            if name.is_absolute() or '..' in name.parts or '\\' in member.name or not name.parts or member.name in seen or not (member.isfile() or member.isdir()):
                raise ValueError('unsafe profile archive')
            seen.add(member.name)
            size += member.size
            if size > limit or len(seen) > 100000:
                raise ValueError('profile limit')
    # Check the expanded size, not just the small compressed archive, before
    # creating any files. Keep headroom for the panel and SQLite WAL writes.
    disk = os.statvfs(root)
    reserve = min(4 * 1024 ** 3, max(1024 ** 3, disk.f_blocks * disk.f_frsize * .05))
    if disk.f_bavail * disk.f_frsize - reserve < size + len(seen) * 4096:
        raise ValueError('insufficient restore space; encrypted session retained')
    try:
        with tarfile.open(archive, 'r:gz') as tar:
            for member in tar:
                destination = root.joinpath(*PurePosixPath(member.name).parts)
                if member.isdir():
                    destination.mkdir(mode=0o700, parents=True, exist_ok=True)
                else:
                    destination.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
                    with tar.extractfile(member) as source, destination.open('xb') as target:
                        shutil.copyfileobj(source, target)
                    destination.chmod(0o600)
    except Exception:
        for item in root.iterdir():
            shutil.rmtree(item) if item.is_dir() else item.unlink()
        raise
else:
    raise ValueError('unsupported archive action')
