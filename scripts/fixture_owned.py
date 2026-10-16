"""No-follow, exclusively created, uniquely owned disposable fixture files."""
from contextlib import contextmanager
import ctypes
import os
from pathlib import Path
import secrets
import stat
import sys


@contextmanager
def directory_fd(path, private=False):
    path = Path(path)
    if not path.is_absolute() or '..' in path.parts or path != path.resolve():
        raise ValueError('Canonical absolute fixture directory required')
    fd = os.open('/', os.O_RDONLY | os.O_DIRECTORY)
    try:
        for part in path.parts[1:]:
            child = os.open(part, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=fd)
            os.close(fd)
            fd = child
            info = os.fstat(fd)
            shared_tmp = info.st_uid in (0, os.getuid()) and bool(info.st_mode & stat.S_ISVTX)
            if info.st_uid not in (0, os.getuid()) or (info.st_mode & 0o022 and not shared_tmp):
                raise ValueError('Unsafe fixture ancestor')
        info = os.fstat(fd)
        if info.st_uid != os.getuid() or (private and stat.S_IMODE(info.st_mode) != 0o700):
            raise ValueError('Fixture directory must be owned and private')
        yield fd
    finally:
        os.close(fd)


def write_new(path, content, mode=0o600):
    """Publish complete content exclusively; never follow or truncate a target."""
    path = Path(path)
    with directory_fd(path.parent, private=True) as parent:
        temporary = '.seed-' + secrets.token_hex(12)
        fd = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW,
                     0o600, dir_fd=parent)
        try:
            with os.fdopen(fd, 'w', encoding='utf8') as stream:
                stream.write(content)
                stream.flush()
                os.fchmod(stream.fileno(), mode)
                os.fsync(stream.fileno())
            os.link(temporary, path.name, src_dir_fd=parent, dst_dir_fd=parent, follow_symlinks=False)
        finally:
            os.unlink(temporary, dir_fd=parent)


def _same_inode(left, right):
    return (left.st_dev, left.st_ino, stat.S_IFMT(left.st_mode)) == (
        right.st_dev, right.st_ino, stat.S_IFMT(right.st_mode))


def _rename_noreplace(source, name, destination, target):
    """Linux atomic claim/restore; no overwrite and no check-then-rename fallback."""
    if sys.platform != 'linux':
        raise ValueError('Atomic fixture cleanup unavailable on this platform')
    libc = ctypes.CDLL(None, use_errno=True)
    try:
        rename = libc.renameat2
    except AttributeError as exc:
        raise ValueError('Atomic fixture cleanup unavailable') from exc
    rename.argtypes = [ctypes.c_int, ctypes.c_char_p, ctypes.c_int, ctypes.c_char_p, ctypes.c_uint]
    rename.restype = ctypes.c_int
    if rename(source, os.fsencode(name), destination, os.fsencode(target), 1) != 0:
        error = ctypes.get_errno()
        raise OSError(error, os.strerror(error), name)


def _claim(parent, name, arena, identity):
    """Move once, then verify against the held identity before touching contents."""
    target = 'c-' + secrets.token_hex(16)
    _rename_noreplace(parent, name, arena, target)
    current = os.stat(target, dir_fd=arena, follow_symlinks=False)
    if not _same_inode(current, identity):
        try:
            _rename_noreplace(arena, target, parent, name)
        except OSError as exc:
            raise ValueError('Fixture ownership changed; replacement retained in cleanup quarantine') from exc
        raise ValueError('Fixture ownership changed; refusing cleanup')
    return target


def _clear_owned(fd, arena):
    """Never reopen an exported directory name to recurse; claim every child."""
    # A fresh descriptor-relative '.' also avoids stale directory-stream offsets
    # after rename on overlay filesystems, without resolving an exported name.
    scan = os.open('.', os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=fd)
    try:
        names = os.listdir(scan)
    finally:
        os.close(scan)
    for name in names:
        identity = os.stat(name, dir_fd=fd, follow_symlinks=False)
        if stat.S_ISDIR(identity.st_mode):
            child = os.open(name, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=fd)
            try:
                if not _same_inode(os.fstat(child), identity):
                    raise ValueError('Fixture ownership changed; refusing cleanup')
                target = _claim(fd, name, arena, identity)
                _clear_owned(child, arena)
                os.rmdir(target, dir_fd=arena)
            finally:
                os.close(child)
        else:
            target = _claim(fd, name, arena, identity)
            os.unlink(target, dir_fd=arena)


def _require_absent(parent, name):
    try:
        os.stat(name, dir_fd=parent, follow_symlinks=False)
    except FileNotFoundError:
        return
    raise ValueError('Fixture ownership changed; exported name recreated; refusing cleanup')


def _cleanup_owned(parent, name, fd, identity):
    """Delete only privately claimed entries, not mutable exported names.

    Linux has no inode-conditional rmdir. The fresh 0700 cleanup arena is never
    exported to the fixture and MUST remain exclusive to this cleanup operation.
    Same-owner replacements of exported names are rejected, but this is not a
    security boundary against hostile same-UID inspection/mutation of the arena.
    On uncertainty leave quarantine in place; never sweep it by a mutable path.
    """
    arena_name = '.cleanup-' + secrets.token_hex(16)
    os.mkdir(arena_name, 0o700, dir_fd=parent)
    arena = os.open(arena_name, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=parent)
    try:
        target = _claim(parent, name, arena, identity)
        _clear_owned(fd, arena)
        os.rmdir(target, dir_fd=arena)
        _require_absent(parent, name)
        os.rmdir(arena_name, dir_fd=parent)
        _require_absent(parent, name)
    finally:
        os.close(arena)


@contextmanager
def owned_home(root):
    """Allocate once, never reuse a home; refuse cleanup if its identity changed."""
    root = Path(root)
    with directory_fd(root, private=True) as parent:
        name = 'f-' + secrets.token_hex(8)
        os.mkdir(name, 0o700, dir_fd=parent)
        fd = os.open(name, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=parent)
        identity = os.fstat(fd)
        home = root / name
        token = secrets.token_hex(24)
        try:
            write_new(home / '.fixture-owner', token)
            yield home
        finally:
            try:
                current = os.stat(name, dir_fd=parent, follow_symlinks=False)
                marker = os.open('.fixture-owner', os.O_RDONLY | os.O_NOFOLLOW, dir_fd=fd)
                try:
                    marker_info = os.fstat(marker)
                    valid_marker = (stat.S_ISREG(marker_info.st_mode) and marker_info.st_nlink == 1
                                    and marker_info.st_uid == os.getuid()
                                    and os.read(marker, 256).decode('utf8') == token)
                finally:
                    os.close(marker)
                if ((current.st_dev, current.st_ino) != (identity.st_dev, identity.st_ino)
                        or not stat.S_ISDIR(current.st_mode) or not valid_marker):
                    raise ValueError('Fixture ownership changed; refusing cleanup')
                _cleanup_owned(parent, name, fd, identity)
            finally:
                os.close(fd)
