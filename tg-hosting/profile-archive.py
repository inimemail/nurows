"""Archive stopped Chromium profiles; never follow symlinks or restore unsafe paths."""
import os
from pathlib import Path, PurePosixPath
import sys
import tarfile
import shutil
import gzip
import re

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


def session_data(name):
    # Root-only metadata is retained for monitoring/downgrade protection but
    # must not turn an empty/damaged profile into a replacement login snapshot.
    return not re.fullmatch(r'\.nurossh-(?:login\.json|browser-version|browser-error\.json)(?:\.[a-f0-9]{12}\.partial)?', name)


# Runtime thresholds must never prevent rescuing an existing over-limit
# session. The runner supplies the independent 20 GiB archive safety ceiling.
limit = int(os.environ.get('TG_PROFILE_LIMIT_BYTES', 5 * 1024 ** 3))
if not 1 * 1024 ** 3 <= limit <= 20 * 1024 ** 3:
    raise ValueError('invalid profile storage limit')
class BoundedTarInfo(tarfile.TarInfo):
    def _proc_pax(self, tarfile_obj):
        if self.size > 65536:
            raise ValueError('oversized profile metadata')
        return super()._proc_pax(tarfile_obj)

    def _proc_gnulong(self, tarfile_obj):
        if self.size > 65536:
            raise ValueError('oversized profile metadata')
        return super()._proc_gnulong(tarfile_obj)


class BoundedGzip:
    def __init__(self, source):
        self.source = source
        self.total = 0

    def read(self, size):
        chunk = self.source.read(size)
        self.total += len(chunk)
        if self.total > limit + 512 * 1024 ** 2:
            raise ValueError('expanded archive limit')
        return chunk


def verify(archive):
    seen = set()
    size = login_size = 0
    # tarfile alone may stop at its end marker before checking the gzip CRC.
    # Consume every file and the gzip trailer before accepting any snapshot.
    with gzip.open(archive, 'rb') as source:
        bounded = BoundedGzip(source)
        with tarfile.open(fileobj=bounded, mode='r|', tarinfo=BoundedTarInfo) as tar:
            for member in tar:
                tar.members.clear()
                name = PurePosixPath(member.name)
                normalized = name.as_posix()
                if (name.is_absolute() or '..' in name.parts or '\\' in member.name
                        or not name.parts or normalized in seen or len(member.name.encode('utf-8')) > 4096
                        or member.size < 0 or not (member.isfile() or member.isdir())
                        or member.isdir() and member.size != 0):
                    raise ValueError('unsafe profile archive')
                seen.add(normalized)
                size += member.size
                if session_data(normalized):
                    login_size += member.size
                if size > limit or len(seen) > 100000:
                    raise ValueError('profile limit')
                if member.isfile():
                    with tar.extractfile(member) as content:
                        while content.read(128 * 1024):
                            pass
        while bounded.read(128 * 1024):
            pass
    if not login_size:
        raise ValueError('empty profile archive; original snapshot retained')
    return size, len(seen)


if sys.argv[1] == 'pack':
    output = Path(sys.argv[2])
    if output.parent.resolve() != root.resolve() or not output.name.startswith('.tg-snapshot-') or output.suffix != '.gz':
        raise ValueError('unsafe snapshot destination')
    os.umask(0o077)
    size = count = login_size = 0
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
                if session_data(member.name):
                    login_size += member.size
                count += 1
                if size > limit or count > 100000:
                    raise ValueError('profile limit')
                with file.open('rb') as source:
                    tar.addfile(member, source)
                # TarInfo objects can outweigh the actual files for large
                # LevelDB profiles. No hardlink references are emitted above.
                tar.members.clear()
                tar.inodes.clear()
        if not login_size:
            raise ValueError('empty profile; existing session snapshot must be retained')
    verify(output)
elif sys.argv[1] == 'verify':
    verify(sys.argv[2])
elif sys.argv[1] == 'extract':
    archive = sys.argv[2]
    size, count = verify(archive)
    # Check the expanded size, not just the small compressed archive, before
    # creating any files. Keep headroom for the panel and SQLite WAL writes.
    disk = os.statvfs(root)
    reserve = min(4 * 1024 ** 3, max(1024 ** 3, disk.f_blocks * disk.f_frsize * .05))
    if disk.f_bavail * disk.f_frsize - reserve < size + count * 4096:
        raise ValueError('insufficient restore space; encrypted session retained')
    if root.is_symlink() or any(root.iterdir()):
        raise ValueError('restore directory must be empty; existing session retained')
    try:
        with tarfile.open(archive, 'r|gz', tarinfo=BoundedTarInfo) as tar:
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
