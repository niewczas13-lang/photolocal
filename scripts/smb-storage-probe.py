"""Read one photo, then check storage only in a newly created probe directory.

The CLI accepts an absolute mounted directory and a generated probe ID. Output
is a fixed marker protocol: no paths, contents, credentials or exception text.
"""

from collections import deque
import errno
import os
from pathlib import Path
import re
import stat
import sys


MAX_DIRECTORIES = 500
MAX_ENTRIES = 10000
PHOTO_READ_BYTES = 64 * 1024
PHOTO_EXTENSIONS = {'.jpg', '.jpeg', '.png', '.webp', '.heic'}
PROBE_ID = re.compile(r'photolocal-smb-probe-[a-f0-9]+\Z')
DENIED_ERRORS = {errno.EACCES, errno.EPERM, errno.EROFS}
DESCRIPTOR_PATHS = os.name == 'posix'
PAYLOAD = b'PhotoLocal isolated storage probe\n'


def is_link(metadata):
    return stat.S_ISLNK(metadata.st_mode) or bool(
        getattr(metadata, 'st_file_attributes', 0)
        & getattr(stat, 'FILE_ATTRIBUTE_REPARSE_POINT', 0x400)
    )


def identity(metadata):
    return metadata.st_dev, metadata.st_ino


class Directory:
    """Use no-follow directory descriptors on Linux, including every ancestor.

    The guarded path fallback exists for synthetic Windows tests. Production
    runs in Linux; relative descriptor operations prevent parent symlink swaps
    from redirecting access outside the mounted tree.
    """

    def __init__(self, path, fd=None):
        self.path = Path(path)
        self.fd = fd

    @classmethod
    def root(cls, path):
        path = Path(path)
        if not path.is_absolute() or '..' in path.parts:
            raise ValueError('INVALID_ROOT')
        if not DESCRIPTOR_PATHS:
            for ancestor in [*reversed(path.parents), path]:
                if is_link(os.lstat(ancestor)):
                    raise ValueError('UNSAFE_PATH')
            if not stat.S_ISDIR(os.lstat(path).st_mode):
                raise ValueError('INVALID_ROOT')
            return cls(path)
        current = cls(Path(path.anchor), os.open(path.anchor, os.O_RDONLY | os.O_DIRECTORY))
        try:
            for part in path.parts[1:]:
                child = current.child(part)
                current.close()
                current = child
            return current
        except BaseException:
            current.close()
            raise

    def close(self):
        if self.fd is not None:
            os.close(self.fd)
            self.fd = None

    def child(self, name):
        if DESCRIPTOR_PATHS:
            fd = os.open(name, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=self.fd)
            return Directory(self.path / name, fd)
        return Directory.root(self.path / name)

    def descend(self, parts):
        current = Directory(self.path, os.dup(self.fd)) if DESCRIPTOR_PATHS else Directory.root(self.path)
        try:
            for part in parts:
                child = current.child(part)
                current.close()
                current = child
            return current
        except BaseException:
            current.close()
            raise

    def args(self, name):
        if DESCRIPTOR_PATHS:
            return name, {'dir_fd': self.fd}
        # Re-check ancestors before each path operation on Windows.
        Directory.root(self.path).close()
        return self.path / name, {}

    def metadata(self, name):
        path, kwargs = self.args(name)
        return os.stat(path, follow_symlinks=False, **kwargs)

    def open(self, name, flags):
        path, kwargs = self.args(name)
        if not DESCRIPTOR_PATHS:
            try:
                if is_link(os.lstat(path)):
                    raise ValueError('UNSAFE_PATH')
            except FileNotFoundError:
                pass
        return os.open(path, flags | getattr(os, 'O_NOFOLLOW', 0) | getattr(os, 'O_BINARY', 0), 0o600, **kwargs)

    def remove(self, name, directory=False):
        path, kwargs = self.args(name)
        if directory:
            os.rmdir(path, **kwargs)
        else:
            os.unlink(path, **kwargs)


def read_photo_sample(root):
    pending = deque([()])
    visited = entries_seen = 0
    access_denied = False
    other_error = False
    while pending and visited < MAX_DIRECTORIES and entries_seen < MAX_ENTRIES:
        parts = pending.popleft()
        visited += 1
        directory = None
        try:
            directory = root.descend(parts)
            with os.scandir(directory.fd if DESCRIPTOR_PATHS else directory.path) as entries:
                for entry in entries:
                    if entries_seen >= MAX_ENTRIES:
                        break
                    entries_seen += 1
                    try:
                        metadata = entry.stat(follow_symlinks=False)
                        if is_link(metadata):
                            continue
                        if stat.S_ISDIR(metadata.st_mode):
                            if visited + len(pending) < MAX_DIRECTORIES:
                                pending.append((*parts, entry.name))
                            continue
                        if not stat.S_ISREG(metadata.st_mode) or Path(entry.name).suffix.lower() not in PHOTO_EXTENSIONS:
                            continue
                        fd = directory.open(entry.name, os.O_RDONLY | getattr(os, 'O_NONBLOCK', 0))
                        try:
                            if stat.S_ISREG(os.fstat(fd).st_mode) and os.read(fd, PHOTO_READ_BYTES):
                                return 'PHOTO_READ_OK'
                        finally:
                            os.close(fd)
                    except OSError as error:
                        access_denied |= error.errno in DENIED_ERRORS
                        other_error |= error.errno not in DENIED_ERRORS
        except OSError as error:
            access_denied |= error.errno in DENIED_ERRORS
            other_error |= error.errno not in DENIED_ERRORS
        finally:
            if directory is not None:
                directory.close()
    if access_denied:
        return 'DIRECTORY_ACCESS_DENIED'
    return 'STORAGE_PROBE_ERROR' if other_error else 'PHOTO_SAMPLE_NOT_FOUND'


def check_storage(root, probe_id):
    name = '.' + probe_id
    directory = None
    created = False
    folder_identity = None
    owned = {}
    status = 'STORAGE_PROBE_ERROR'
    cleanup_failed = False
    try:
        path, kwargs = root.args(name)
        os.mkdir(path, 0o700, **kwargs)  # A collision must never grant ownership.
        created = True
        folder_identity = identity(root.metadata(name))
        directory = root.child(name)
        filenames = ['sample.bin', 'renamed.bin'] if DESCRIPTOR_PATHS else ['sample.bin']
        for filename in filenames:
            fd = directory.open(filename, os.O_RDWR | os.O_CREAT | os.O_EXCL)
            try:
                owned[filename] = identity(os.fstat(fd))
                if filename == 'sample.bin':
                    written = 0
                    while written < len(PAYLOAD):
                        count = os.write(fd, PAYLOAD[written:])
                        if count <= 0:
                            raise OSError(errno.EIO, 'WRITE_FAILED')
                        written += count
                    os.fsync(fd)
                    os.lseek(fd, 0, os.SEEK_SET)
                    if os.read(fd, len(PAYLOAD) + 1) != PAYLOAD:
                        raise OSError(errno.EIO, 'READBACK_FAILED')
            finally:
                os.close(fd)
        # Linux rename replaces a reserved owned target. Windows rename itself
        # refuses an existing target, so it needs no reservation.
        for filename, expected in owned.items():
            if identity(directory.metadata(filename)) != expected:
                raise ValueError('FILE_REPLACED')
        source, source_kwargs = directory.args('sample.bin')
        destination, destination_kwargs = directory.args('renamed.bin')
        rename_kwargs = ({'src_dir_fd': source_kwargs['dir_fd'], 'dst_dir_fd': destination_kwargs['dir_fd']}
                         if DESCRIPTOR_PATHS else {})
        os.rename(source, destination, **rename_kwargs)
        owned['renamed.bin'] = owned.pop('sample.bin')
        fd = directory.open('renamed.bin', os.O_RDONLY)
        try:
            if os.read(fd, len(PAYLOAD) + 1) != PAYLOAD:
                raise OSError(errno.EIO, 'READBACK_FAILED')
        finally:
            os.close(fd)
        status = 'STORAGE_READ_WRITE_OK'
    except OSError as error:
        status = 'STORAGE_WRITE_DENIED' if error.errno in DENIED_ERRORS else 'STORAGE_PROBE_ERROR'
    except (ValueError, RuntimeError):
        status = 'STORAGE_PROBE_ERROR'
    finally:
        if created:
            try:
                if folder_identity is None or identity(root.metadata(name)) != folder_identity:
                    raise ValueError('DIRECTORY_REPLACED')
                if directory is not None:
                    for filename, expected in owned.items():
                        try:
                            metadata = directory.metadata(filename)
                        except FileNotFoundError:
                            continue
                        if is_link(metadata) or identity(metadata) != expected:
                            cleanup_failed = True
                            continue
                        try:
                            directory.remove(filename)
                        except OSError:
                            cleanup_failed = True
                    directory.close()
                    directory = None
                root.remove(name, directory=True)  # Never recursively remove anything.
            except (OSError, ValueError):
                cleanup_failed = True
        if directory is not None:
            directory.close()
    return 'TEST_FOLDER_CLEANUP_REQUIRED' if cleanup_failed else status


def main(argv):
    print('PROBE_STARTED', flush=True)
    root = None
    try:
        if len(argv) != 2 or not PROBE_ID.fullmatch(argv[1]):
            raise ValueError('INVALID_INPUT')
        root = Directory.root(argv[0])
        status = read_photo_sample(root)
        if status == 'PHOTO_READ_OK':
            print(status, flush=True)
            status = check_storage(root, argv[1])
    except OSError as error:
        status = 'DIRECTORY_ACCESS_DENIED' if error.errno in DENIED_ERRORS else 'STORAGE_PROBE_ERROR'
    except (ValueError, RuntimeError):
        status = 'STORAGE_PROBE_ERROR'
    finally:
        if root is not None:
            root.close()
    print(status, flush=True)
    return 0 if status == 'STORAGE_READ_WRITE_OK' else 1


if __name__ == '__main__':
    sys.exit(main(sys.argv[1:]))
