"""Synthetic filesystem checks for the isolated SMB storage probe."""

import contextlib
import errno
import importlib.util
import io
import os
import pathlib
import subprocess
import sys
import tempfile
import unittest
from unittest import mock


SCRIPT = pathlib.Path(__file__).with_name('smb-storage-probe.py')
PROBE_ID = 'photolocal-smb-probe-a123'


def load_probe():
    spec = importlib.util.spec_from_file_location('smb_storage_probe', SCRIPT)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


class StorageProbeTests(unittest.TestCase):
    def setUp(self):
        self.probe = load_probe()
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.root = pathlib.Path(self.temporary.name)
        self.photo = self.root / 'project' / 'photo.jpg'
        self.photo.parent.mkdir()
        self.photo.write_bytes(b'\xff\xd8synthetic photo\xff\xd9')
        self.folder = self.root / ('.' + PROBE_ID)

    def run_probe(self, root=None, probe_id=PROBE_ID):
        output = io.StringIO()
        with contextlib.redirect_stdout(output):
            result = self.probe.main([str(root or self.root), probe_id])
        return result, output.getvalue().splitlines()

    def assert_failure(self, marker, root=None, probe_id=PROBE_ID):
        result, lines = self.run_probe(root, probe_id)
        self.assertNotEqual(result, 0)
        self.assertEqual(lines[-1], marker)
        self.assertNotIn('STORAGE_READ_WRITE_OK', lines)
        return lines

    def test_existing_probe_folder_and_contents_are_untouched(self):
        self.folder.mkdir()
        existing = self.folder / 'sample.bin'
        existing.write_bytes(b'existing user data')
        self.assert_failure('STORAGE_PROBE_ERROR')
        self.assertEqual(existing.read_bytes(), b'existing user data')
        self.assertEqual(list(self.folder.iterdir()), [existing])

    def test_invalid_probe_id_cannot_escape_root(self):
        self.assert_failure('STORAGE_PROBE_ERROR', probe_id='../outside')
        self.assertEqual(list(self.root.iterdir()), [self.photo.parent])

    def test_missing_root_has_fixed_error_without_paths(self):
        self.assert_failure('STORAGE_PROBE_ERROR', root=self.root / 'secret-missing-folder')

    def test_no_photo_does_not_create_probe_folder(self):
        self.photo.unlink()
        self.assert_failure('PHOTO_SAMPLE_NOT_FOUND')
        self.assertFalse(self.folder.exists())

    def test_empty_photo_is_not_a_read_sample(self):
        self.photo.write_bytes(b'')
        self.assert_failure('PHOTO_SAMPLE_NOT_FOUND')
        self.assertFalse(self.folder.exists())

    def test_scan_limit_stops_before_photo_in_child_directory(self):
        with mock.patch.object(self.probe, 'MAX_DIRECTORIES', 1):
            self.assert_failure('PHOTO_SAMPLE_NOT_FOUND')
        self.assertFalse(self.folder.exists())

    def test_entry_limit_is_global(self):
        with mock.patch.object(self.probe, 'MAX_ENTRIES', 1):
            self.assert_failure('PHOTO_SAMPLE_NOT_FOUND')
        self.assertFalse(self.folder.exists())

    def test_denied_scan_has_read_error_and_does_not_start_write(self):
        with mock.patch.object(self.probe.os, 'scandir', side_effect=PermissionError(errno.EACCES, 'private path')):
            self.assert_failure('DIRECTORY_ACCESS_DENIED')
        self.assertFalse(self.folder.exists())

    def test_non_permission_scan_error_is_not_an_auth_failure(self):
        with mock.patch.object(self.probe.os, 'scandir', side_effect=OSError(errno.EIO, 'private path')):
            self.assert_failure('STORAGE_PROBE_ERROR')

    def test_denied_photo_read_does_not_start_write(self):
        with mock.patch.object(self.probe.os, 'read', side_effect=PermissionError(errno.EACCES, 'private path')):
            self.assert_failure('DIRECTORY_ACCESS_DENIED')
        self.assertFalse(self.folder.exists())

    def test_readback_mismatch_cleans_owned_files(self):
        original_read = os.read

        def corrupt_test_readback(fd, size):
            data = original_read(fd, size)
            return data if size == 64 * 1024 else b'wrong data'

        with mock.patch.object(self.probe.os, 'read', side_effect=corrupt_test_readback):
            lines = self.assert_failure('STORAGE_PROBE_ERROR')
        self.assertIn('PHOTO_READ_OK', lines)
        self.assertFalse(self.folder.exists())

    def test_short_writes_are_completed_before_readback(self):
        original_write = os.write

        def short_write(fd, data):
            return original_write(fd, data[:3])

        with mock.patch.object(self.probe.os, 'write', side_effect=short_write):
            result, lines = self.run_probe()
        self.assertEqual(result, 0)
        self.assertEqual(lines[-1], 'STORAGE_READ_WRITE_OK')
        self.assertFalse(self.folder.exists())

    def test_photo_read_is_bounded(self):
        self.photo.write_bytes(b'p' * (128 * 1024))
        original_read = os.read
        sizes = []

        def observe_read(fd, size):
            sizes.append(size)
            return original_read(fd, size)

        with mock.patch.object(self.probe.os, 'read', side_effect=observe_read):
            result, lines = self.run_probe()
        self.assertEqual(result, 0)
        self.assertEqual(sizes[0], 64 * 1024)
        self.assertEqual(lines[-1], 'STORAGE_READ_WRITE_OK')

    def test_write_denied_after_photo_read_is_reported_as_write_failure(self):
        with mock.patch.object(self.probe.os, 'mkdir', side_effect=PermissionError(errno.EACCES, 'private path')):
            lines = self.assert_failure('STORAGE_WRITE_DENIED')
        self.assertIn('PHOTO_READ_OK', lines)
        self.assertFalse(self.folder.exists())

    def test_readonly_filesystem_is_reported_as_write_failure(self):
        with mock.patch.object(self.probe.os, 'mkdir', side_effect=OSError(errno.EROFS, 'private path')):
            self.assert_failure('STORAGE_WRITE_DENIED')

    def test_rename_denied_cleans_created_files_and_directory(self):
        with mock.patch.object(self.probe.os, 'rename', side_effect=PermissionError(errno.EACCES, 'private path')):
            self.assert_failure('STORAGE_WRITE_DENIED')
        self.assertFalse(self.folder.exists())

    def test_cleanup_error_takes_precedence_over_success(self):
        with mock.patch.object(self.probe.os, 'rmdir', side_effect=PermissionError(errno.EACCES, 'private path')):
            self.assert_failure('TEST_FOLDER_CLEANUP_REQUIRED')
        self.assertTrue(self.folder.exists())
        self.assertEqual(list(self.folder.iterdir()), [])

    def test_foreign_file_in_probe_directory_is_never_deleted(self):
        original_rename = os.rename

        def create_foreign_file(*args, **kwargs):
            result = original_rename(*args, **kwargs)
            (self.folder / 'foreign.txt').write_bytes(b'keep me')
            return result

        with mock.patch.object(self.probe.os, 'rename', side_effect=create_foreign_file):
            self.assert_failure('TEST_FOLDER_CLEANUP_REQUIRED')
        self.assertEqual((self.folder / 'foreign.txt').read_bytes(), b'keep me')
        self.assertEqual([p.name for p in self.folder.iterdir()], ['foreign.txt'])

    def create_symlink(self, source, target, directory=False):
        try:
            source.symlink_to(target, target_is_directory=directory)
        except (OSError, NotImplementedError):
            self.skipTest('Creating symlinks is unavailable for this Windows account')

    def test_symlink_photo_is_not_read(self):
        self.photo.unlink()
        with tempfile.TemporaryDirectory() as outside:
            sample = pathlib.Path(outside) / 'outside.jpg'
            sample.write_bytes(b'outside file')
            self.create_symlink(self.photo, sample)
            self.assert_failure('PHOTO_SAMPLE_NOT_FOUND')
            self.assertEqual(sample.read_bytes(), b'outside file')

    def test_symlink_directory_is_not_traversed(self):
        self.photo.unlink()
        self.photo.parent.rmdir()
        with tempfile.TemporaryDirectory() as outside:
            sample = pathlib.Path(outside) / 'outside.jpg'
            sample.write_bytes(b'outside file')
            self.create_symlink(self.photo.parent, pathlib.Path(outside), directory=True)
            self.assert_failure('PHOTO_SAMPLE_NOT_FOUND')

    def test_symlink_root_is_rejected(self):
        linked = self.root / 'linked'
        self.create_symlink(linked, self.photo.parent, directory=True)
        self.assert_failure('STORAGE_PROBE_ERROR', root=linked)

    def test_symlink_existing_probe_folder_is_preserved(self):
        with tempfile.TemporaryDirectory() as outside:
            self.create_symlink(self.folder, pathlib.Path(outside), directory=True)
            self.assert_failure('STORAGE_PROBE_ERROR')
            self.assertTrue(self.folder.is_symlink())

    @unittest.skipUnless(os.name == 'posix', 'POSIX descriptor and FIFO safety')
    def test_fifo_with_photo_extension_is_not_opened(self):
        self.photo.unlink()
        os.mkfifo(self.photo)
        self.assert_failure('PHOTO_SAMPLE_NOT_FOUND')


class StorageProbeCliTests(unittest.TestCase):
    def test_embedded_python_c_invocation_has_same_marker_protocol(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = pathlib.Path(temporary)
            (root / 'photo.heic').write_bytes(b'synthetic photo')
            result = subprocess.run(
                [sys.executable, '-c', SCRIPT.read_text(encoding='utf-8'), str(root), PROBE_ID],
                capture_output=True,
                text=True,
                check=False,
            )
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertEqual(result.stdout.splitlines(), [
                'PROBE_STARTED', 'PHOTO_READ_OK', 'STORAGE_READ_WRITE_OK',
            ])
            self.assertEqual(result.stderr, '')
            self.assertFalse((root / ('.' + PROBE_ID)).exists())

    def test_reads_photo_checks_write_rename_and_removes_only_its_folder(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = pathlib.Path(temporary)
            source = root / 'project' / 'source.JPG'
            source.parent.mkdir()
            original = b'\xff\xd8synthetic photograph\xff\xd9'
            source.write_bytes(original)
            result = subprocess.run(
                [sys.executable, str(SCRIPT), str(root), PROBE_ID],
                capture_output=True,
                text=True,
                check=False,
            )
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertEqual(result.stdout.splitlines(), [
                'PROBE_STARTED', 'PHOTO_READ_OK', 'STORAGE_READ_WRITE_OK',
            ])
            self.assertEqual(result.stderr, '')
            self.assertEqual(source.read_bytes(), original)
            self.assertEqual(list(root.iterdir()), [source.parent])


if __name__ == '__main__':
    unittest.main()
