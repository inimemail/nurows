"""Archive stopped Chromium profiles; never follow symlinks or restore unsafe paths."""
import os
from pathlib import Path, PurePosixPath
import sys
import tarfile
import shutil

root = Path('/profile')
# Match the same exact paths as shared/tg-profile-storage.js. Never exclude a
# database subtree just because it happens to be named Cache or Sessions.
cache_paths = {
    'Default/Cache', 'Default/Code Cache', 'Default/GPUCache', 'Default/Media Cache',
    'Default/DawnCache', 'Default/GrShaderCache', 'Default/ShaderCache',
    'GPUCache', 'GrShaderCache', 'ShaderCache', 'Crashpad', 'BrowserMetrics',
}


def excluded(file):
    relative = file.relative_to(root).as_posix()
    return (relative in cache_paths or relative in {'SingletonLock', 'SingletonSocket', 'SingletonCookie'}
            or ('/' not in relative and relative.startswith('.tg-snapshot-') and relative.endswith('.tar.gz')))


def walk_error(error):
    # An unreadable login database must fail the snapshot, never disappear
    # silently from an otherwise apparently successful backup.
    raise error


# Runtime thresholds must never prevent rescuing an existing over-limit
# session. The runner supplies the independent 20 GiB archive safety ceiling.
limit = int(os.environ.get('TG_PROFILE_LIMIT_BYTES', 5 * 1024 ** 3))
if not 1 * 1024 ** 3 <= limit <= 20 * 1024 ** 3:
    raise ValueError('invalid profile storage limit')
if sys.argv[1] == 'pack':
    output = Path(sys.argv[2])
    if output.parent.resolve() != root.resolve() or not output.name.startswith('.tg-snapshot-') or output.suffix != '.gz':
        raise ValueError('unsafe snapshot destination')
    os.umask(0o077)
    size = count = 0
    with output.open('xb') as destination, tarfile.open(fileobj=destination, mode='w:gz', compresslevel=1) as tar:
        for parent, dirs, files in os.walk(root, followlinks=False, onerror=walk_error):
            dirs[:] = [name for name in dirs if not excluded(Path(parent) / name)]
            if any((Path(parent) / name).is_symlink() for name in dirs):
                raise ValueError('unsupported profile symlink')
            for name in files:
                file = Path(parent) / name
                if excluded(file):
                    continue
                member = tar.gettarinfo(str(file), arcname=file.relative_to(root).as_posix())
                if not member.isfile():
                    raise ValueError('unsupported profile file')
                size += member.size
                count += 1
                if size > limit or count > 100000:
                    raise ValueError('profile limit')
                with file.open('rb') as source:
                    tar.addfile(member, source)
                # TarInfo objects can outweigh the actual files for large
                # LevelDB profiles. No hardlink references are emitted above.
                tar.members.clear()
                tar.inodes.clear()
        if not size:
            raise ValueError('empty profile; existing session snapshot must be retained')
elif sys.argv[1] == 'extract':
    archive = sys.argv[2]
    seen = set()
    size = 0
    with tarfile.open(archive, 'r|gz') as tar:
        for member in tar:
            tar.members.clear()
            name = PurePosixPath(member.name)
            if name.is_absolute() or '..' in name.parts or '\\' in member.name or not name.parts or member.name in seen or member.size < 0 or not (member.isfile() or member.isdir()):
                raise ValueError('unsafe profile archive')
            seen.add(member.name)
            size += member.size
            if size > limit or len(seen) > 100000:
                raise ValueError('profile limit')
    if not size:
        raise ValueError('empty profile archive; original snapshot retained')
    # Check the expanded size, not just the small compressed archive, before
    # creating any files. Keep headroom for the panel and SQLite WAL writes.
    disk = os.statvfs(root)
    reserve = min(4 * 1024 ** 3, max(1024 ** 3, disk.f_blocks * disk.f_frsize * .05))
    if disk.f_bavail * disk.f_frsize - reserve < size + len(seen) * 4096:
        raise ValueError('insufficient restore space; encrypted session retained')
    seen.clear()
    if root.is_symlink() or any(root.iterdir()):
        raise ValueError('restore directory must be empty; existing session retained')
    try:
        with tarfile.open(archive, 'r|gz') as tar:
            for member in tar:
                tar.members.clear()
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
