import contextlib
import hashlib
import io
import json
import os
from pathlib import Path
import tempfile
import threading
import multiprocessing
import subprocess
import sys
import unittest
from concurrent.futures import ThreadPoolExecutor
from unittest.mock import Mock, patch

import requests
from google.auth.exceptions import RefreshError, TransportError
from googleapiclient.errors import HttpError

import chat


def write_manifest_in_process(path, start):
    for index in range(start, start + 12):
        chat.upsert_message_manifest(path, {'messageName': 'message'}, {'fileName': f'{index}.jpg'})


def refresh_token_in_process(token_path, calls_path):
    def load(path, scopes):
        data = json.loads(Path(path).read_text())
        credentials = FakeCredentials(valid=data['token'] == 'synthetic-refreshed')
        credentials.token = data['token']
        def refresh(request):
            with open(calls_path, 'a', encoding='utf-8') as handle:
                handle.write('refresh\n')
            credentials._refresh(request)
        credentials.refresh.side_effect = refresh
        return credentials
    with patch.dict(os.environ, {'GOOGLE_CHAT_TOKEN_FILE': token_path}), patch('chat.Credentials.from_authorized_user_file', side_effect=load), patch('chat.build'):
        chat.get_chat_service()


class FakeCredentials:
    def __init__(self, valid=True, refresh_token='synthetic-refresh'):
        self.valid = valid
        self.expired = not valid
        self.refresh_token = refresh_token
        self.token = 'synthetic-access'
        self.expiry = None
        self.refresh = Mock(side_effect=self._refresh)

    def _refresh(self, request):
        self.valid = True
        self.expired = False
        self.token = 'synthetic-refreshed'

    def to_json(self):
        return json.dumps({'token': self.token, 'refresh_token': self.refresh_token})


class ChatTestCase(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.enterContext(contextlib.redirect_stdout(io.StringIO()))
        self.enterContext(contextlib.redirect_stderr(io.StringIO()))
        previous_cwd = os.getcwd()
        os.chdir(self.root)
        self.addCleanup(os.chdir, previous_cwd)
        self.token_path = self.root / 'token.json'
        self.patches = [
            patch.dict(os.environ, {
                'GOOGLE_CHAT_TOKEN_FILE': str(self.token_path),
                'GOOGLE_CHAT_CREDENTIALS_FILE': str(self.root / 'credentials.json'),
                'GOOGLE_CHAT_DOWNLOAD_ROOT': str(self.root / 'downloads'),
            }),
            patch('chat.build', return_value=Mock()),
            patch('chat.time.sleep'),
        ]
        for mocked in self.patches:
            mocked.start()
            self.addCleanup(mocked.stop)

    def fake_token(self, credentials):
        self.token_path.write_text(credentials.to_json(), encoding='utf-8')
        mocked = patch('chat.Credentials.from_authorized_user_file', return_value=credentials)
        mocked.start()
        self.addCleanup(mocked.stop)
        return mocked


class AuthenticationTests(ChatTestCase):
    def test_separate_processes_share_refreshed_token(self):
        self.token_path.write_text(FakeCredentials(valid=False).to_json())
        calls_path = self.root / 'refresh-calls.txt'
        context = multiprocessing.get_context('spawn')
        processes = [context.Process(target=refresh_token_in_process, args=(str(self.token_path), str(calls_path))) for _ in range(3)]
        for process in processes:
            process.start()
        for process in processes:
            process.join(timeout=20)
            if process.is_alive():
                process.terminate()
                process.join()
            self.assertEqual(process.exitcode, 0)
        self.assertEqual(calls_path.read_text().splitlines(), ['refresh'])
        self.assertEqual(json.loads(self.token_path.read_text())['token'], 'synthetic-refreshed')

    def test_missing_token_subprocess_is_exit_three_without_traceback(self):
        result = subprocess.run([sys.executable, chat.__file__, '--list-spaces-json'], capture_output=True, text=True, timeout=10)
        self.assertEqual(result.returncode, 3)
        self.assertEqual(result.stdout, '')
        self.assertEqual(json.loads(result.stderr)['code'], 'PHOTO_LOCAL_AUTH_REQUIRED')
        self.assertFalse(self.token_path.exists())

    def test_sdk_unauthorized_after_refresh_requires_auth(self):
        error = HttpError(type('Response', (), {'status': 401, 'reason': 'Unauthorized'})(), b'{}')
        with patch('chat.get_chat_service', return_value=(Mock(), FakeCredentials())), patch('chat.fetch_spaces', side_effect=lambda *_: chat.retry(lambda: (_ for _ in ()).throw(error))):
            self.assertEqual(chat.main(['--list-spaces-json']), 3)

    def test_cli_missing_auth_is_safe_exit_three(self):
        self.assertTrue(callable(getattr(chat, 'main', None)), 'CLI needs a testable exit-code boundary')
        stdout, stderr = io.StringIO(), io.StringIO()
        with patch('chat.InstalledAppFlow') as flow, contextlib.redirect_stdout(stdout), contextlib.redirect_stderr(stderr):
            code = chat.main(['--list-spaces-json'])
        self.assertEqual(code, 3)
        self.assertEqual(stdout.getvalue(), '')
        self.assertEqual(json.loads(stderr.getvalue())['code'], 'PHOTO_LOCAL_AUTH_REQUIRED')
        flow.from_client_secrets_file.assert_not_called()

    def test_explicit_login_is_the_only_browser_flow(self):
        self.assertTrue(callable(getattr(chat, 'main', None)), 'CLI needs explicit --login support')
        with patch('chat.InstalledAppFlow') as flow:
            flow.from_client_secrets_file.return_value.run_local_server.return_value = FakeCredentials()
            self.assertEqual(chat.main(['--login']), 0)
            flow.from_client_secrets_file.assert_called_once_with(str(self.root / 'credentials.json'), chat.SCOPES)
        self.assertTrue(self.token_path.exists())

    def test_refresh_does_not_discard_previous_refresh_token(self):
        creds = FakeCredentials(valid=False)
        def refresh(request):
            creds._refresh(request)
            creds.refresh_token = None
        creds.refresh.side_effect = refresh
        self.fake_token(creds)
        chat.get_chat_service()
        self.assertEqual(json.loads(self.token_path.read_text())['refresh_token'], 'synthetic-refresh')

    def test_simultaneous_refresh_uses_one_refresh(self):
        creds = FakeCredentials(valid=False)
        self.fake_token(creds)
        with ThreadPoolExecutor(max_workers=8) as pool:
            list(pool.map(lambda _: chat.refresh_credentials(creds), range(20)))
        self.assertEqual(creds.refresh.call_count, 1)

    def test_google_sdk_uses_managed_refresh_credentials(self):
        creds = FakeCredentials()
        self.fake_token(creds)
        with patch('chat.build') as build:
            chat.get_chat_service()
        arguments = build.call_args.kwargs
        self.assertIn('http', arguments, 'SDK needs transport with serialized refreshing')
        managed = arguments['http'].credentials
        with patch('chat.refresh_credentials', return_value='synthetic-new') as refresh:
            headers = {}
            managed.before_request(Mock(), 'GET', 'https://chat.googleapis.com', headers)
        refresh.assert_called_once_with(creds)
        self.assertEqual(headers['authorization'], 'Bearer synthetic-new')

    def test_listing_json_stdout_has_no_diagnostics(self):
        self.assertTrue(callable(getattr(chat, 'main', None)))
        stdout = io.StringIO()
        with patch('chat.get_chat_service', return_value=(Mock(), FakeCredentials())), patch('chat.fetch_spaces', return_value=[{'name': 'spaces/test', 'displayName': 'Test'}]), contextlib.redirect_stdout(stdout):
            self.assertEqual(chat.main(['--list-spaces-json']), 0)
        self.assertEqual(json.loads(stdout.getvalue()), [{'name': 'spaces/test', 'displayName': 'Test', 'spaceType': ''}])

    def test_legacy_interactive_all_file_selection_is_preserved(self):
        with patch('chat.get_chat_service', return_value=(Mock(), FakeCredentials())), patch('chat.list_spaces', return_value=[{'name': 'spaces/test', 'displayName': 'Test'}]), patch('builtins.input', return_value='A 1'), patch('chat.process_space', return_value={'failed': 0}) as process:
            self.assertEqual(chat.main([]), 0)
        self.assertTrue(process.call_args.args[-1])

    def test_legacy_interactive_space_id_is_preserved(self):
        with patch('chat.get_chat_service', return_value=(Mock(), FakeCredentials())), patch('chat.list_spaces', return_value=[{'name': 'spaces/test', 'displayName': 'Test'}]), patch('builtins.input', return_value='spaces/test'), patch('chat.process_space', return_value={'failed': 0}) as process:
            self.assertEqual(chat.main([]), 0)
        self.assertEqual(process.call_args.args[2], 'spaces/test')

    def test_missing_credentials_never_open_browser(self):
        with patch('chat.InstalledAppFlow') as flow:
            flow.from_client_secrets_file.return_value.run_local_server.return_value = FakeCredentials()
            with self.assertRaises(RuntimeError):
                chat.get_chat_service()
            flow.from_client_secrets_file.assert_not_called()

    def test_configured_token_path_is_used(self):
        creds = FakeCredentials()
        self.fake_token(creds)
        with patch('chat.Credentials.from_authorized_user_file', return_value=creds) as read:
            chat.get_chat_service()
        read.assert_called_with(str(self.token_path), chat.SCOPES)

    def test_revoked_refresh_is_classified_as_auth_required(self):
        creds = FakeCredentials(valid=False)
        creds.refresh.side_effect = RefreshError('invalid_grant: synthetic revoked token')
        self.fake_token(creds)
        try:
            chat.get_chat_service()
        except Exception as error:
            self.assertIsInstance(error, RuntimeError)
            self.assertIn('PHOTO_LOCAL_AUTH_REQUIRED', str(error))
        else:
            self.fail('Revoked credentials must require authorization')

    def test_transient_refresh_is_retried_without_browser(self):
        creds = FakeCredentials(valid=False)
        creds.refresh.side_effect = [TransportError('synthetic network outage'), None]
        self.fake_token(creds)
        with patch('chat.InstalledAppFlow') as flow:
            try:
                chat.get_chat_service()
            except TransportError:
                self.fail('Transient refresh failure must be retried')
        self.assertEqual(creds.refresh.call_count, 2)
        flow.from_client_secrets_file.assert_not_called()

    def test_nonterminal_refresh_error_does_not_become_auth_required(self):
        creds = FakeCredentials(valid=False)
        creds.refresh.side_effect = RefreshError('temporarily_unavailable', retryable=True)
        self.fake_token(creds)
        with self.assertRaises(RefreshError):
            chat.get_chat_service()
        self.assertEqual(creds.refresh.call_count, 3)


class AtomicFileTests(ChatTestCase):
    def test_process_manifest_updates_keep_every_attachment(self):
        manifest = self.root / 'manifest.json'
        context = multiprocessing.get_context('spawn')
        processes = [context.Process(target=write_manifest_in_process, args=(str(manifest), start)) for start in (0, 12, 24)]
        for process in processes:
            process.start()
        for process in processes:
            process.join(timeout=20)
            if process.is_alive():
                process.terminate()
                process.join()
            self.assertEqual(process.exitcode, 0)
        self.assertEqual(len(json.loads(manifest.read_text())['files']), 36)

    def test_failed_replace_preserves_previous_file_and_cleans_parts(self):
        destination = self.root / 'photo.jpg'
        destination.write_bytes(b'previous-complete-photo')
        with patch('chat.os.replace', side_effect=OSError('synthetic disk failure')):
            with self.assertRaises(OSError):
                chat.write_downloaded_content(destination, b'new-complete-photo')
        self.assertEqual(destination.read_bytes(), b'previous-complete-photo')
        self.assertEqual(list(self.root.glob('*.part')), [])

    def test_empty_download_is_rejected(self):
        destination = self.root / 'photo.jpg'
        with self.assertRaises(ValueError):
            chat.write_downloaded_content(destination, b'')
        self.assertFalse(destination.exists())

    def test_concurrent_manifest_updates_keep_every_attachment(self):
        manifest = self.root / 'manifest.json'
        base = {'messageName': 'spaces/test/messages/one', 'createTime': '2026-09-10'}
        with ThreadPoolExecutor(max_workers=8) as pool:
            list(pool.map(
                lambda index: chat.upsert_message_manifest(
                    manifest, base, {'fileName': f'{index}.jpg', 'contentHash': str(index)},
                ),
                range(40),
            ))
        data = json.loads(manifest.read_text(encoding='utf-8'))
        self.assertEqual(len(data['files']), 40)


class ResumeTests(ChatTestCase):
    def setUp(self):
        super().setUp()
        self.messages = [{
            'name': 'spaces/test/messages/one',
            'text': 'Photo description',
            'createTime': '2026-09-10T10:00:00Z',
            'attachment': [{
                'name': 'spaces/test/messages/one/attachments/a',
                'contentName': 'photo.jpg',
                'contentType': 'image/jpeg',
                'attachmentDataRef': {'resourceName': 'spaces/test/messages/one/attachments/a'},
            }],
        }]
        self.downloads = []
        def download(service, creds, attachment, save_path):
            self.downloads.append(save_path)
            return True, chat.write_downloaded_content(save_path, b'complete synthetic photo')
        for mocked in [
            patch('chat.get_all_messages', side_effect=lambda *_: self.messages),
            patch('chat.download_attachment', side_effect=download),
            patch('chat.DOWNLOAD_DIR', str(self.root / 'downloads')),
            patch('chat.WORKERS', 1),
        ]:
            mocked.start()
            self.addCleanup(mocked.stop)

    def process(self, display_name='Test room'):
        with contextlib.redirect_stdout(io.StringIO()):
            return chat.process_space(Mock(), FakeCredentials(), 'spaces/test', display_name)

    def test_download_returns_accurate_statistics(self):
        stats = self.process()
        self.assertIsInstance(stats, dict)
        self.assertEqual(stats, {'downloaded': 1, 'skipped': 0, 'failed': 0, 'pending': 0})

    def progress_events(self, output):
        prefix = 'PHOTO_LOCAL_PROGRESS '
        return [json.loads(line[len(prefix):]) for line in output.splitlines() if line.startswith(prefix)]

    def test_progress_events_report_actual_root_and_complete_counters(self):
        output = io.StringIO()
        with contextlib.redirect_stdout(output):
            chat.process_space(Mock(), FakeCredentials(), 'spaces/test', 'Test room')
        events = self.progress_events(output.getvalue())
        self.assertEqual(len(events), 2)
        expected_root = str(self.root / 'downloads' / 'Test room')
        self.assertEqual(events[0], {
            'rootPath': expected_root, 'totalFiles': 1, 'downloadedFiles': 0,
            'skippedFiles': 0, 'failedFiles': 0, 'pendingFiles': 1,
        })
        self.assertEqual(events[-1], {
            'rootPath': expected_root, 'totalFiles': 1, 'downloadedFiles': 1,
            'skippedFiles': 0, 'failedFiles': 0, 'pendingFiles': 0,
        })

    def test_room_rename_progress_uses_original_root_with_importable_manifests(self):
        self.process()
        self.messages[0]['text'] = 'Updated description'
        output = io.StringIO()
        with contextlib.redirect_stdout(output):
            chat.process_space(Mock(), FakeCredentials(), 'spaces/test', 'Renamed room')
        events = self.progress_events(output.getvalue())
        self.assertTrue(events, 'The backend needs the actual stable space root')
        actual_root = Path(events[-1]['rootPath'])
        self.assertEqual(actual_root, self.root / 'downloads' / 'Test room')
        manifests = list(actual_root.rglob('manifest.json'))
        self.assertEqual(len(manifests), 1)
        manifest = json.loads(manifests[0].read_text(encoding='utf-8'))
        self.assertEqual(manifest['spaceDisplayName'], 'Renamed room')
        self.assertEqual(manifest['messageText'], 'Updated description')
        self.assertTrue((manifests[0].parent / manifest['files'][0]['fileName']).is_file())
        self.assertEqual(len(self.downloads), 1)

    def test_auth_pause_progress_includes_pending_files_and_root(self):
        output = io.StringIO()
        with contextlib.redirect_stdout(output), patch('chat.download_attachment', side_effect=chat.AuthRequired()):
            with self.assertRaises(chat.AuthRequired):
                chat.process_space(Mock(), FakeCredentials(), 'spaces/test', 'Test room')
        events = self.progress_events(output.getvalue())
        self.assertTrue(events, 'Auth pause must preserve root and file counts for resume')
        self.assertEqual(events[-1]['pendingFiles'], 1)
        self.assertEqual(events[-1]['downloadedFiles'], 0)
        self.assertEqual(events[-1]['failedFiles'], 0)

    def test_uncertain_existing_file_is_replaced_and_receipted(self):
        folder = self.root / 'downloads' / 'Test room' / '2026-09-10_Photo description'
        folder.mkdir(parents=True)
        (folder / 'photo.jpg').write_bytes(b'partial')
        self.process()
        self.assertEqual(len(self.downloads), 1)
        self.assertEqual((folder / 'photo.jpg').read_bytes(), b'complete synthetic photo')
        self.assertEqual(len(list((self.root / 'downloads' / '.receipts').glob('*.json'))), 1)

    def test_receipt_skips_intact_file_and_repairs_corruption(self):
        self.process()
        self.process()
        self.assertEqual(len(self.downloads), 1)
        Path(self.downloads[0]).write_bytes(b'truncated')
        self.process()
        self.assertEqual(len(self.downloads), 2)

    def test_renamed_room_and_edited_text_do_not_duplicate_receipted_photo(self):
        self.process()
        self.messages[0]['text'] = 'Updated description'
        self.process('Renamed room')
        self.assertEqual(len(self.downloads), 1)
        self.assertEqual(len(list((self.root / 'downloads').rglob('*.jpg'))), 1)

    def test_same_filename_with_distinct_ids_does_not_overwrite(self):
        second = dict(self.messages[0]['attachment'][0])
        second['name'] = 'spaces/test/messages/one/attachments/b'
        self.messages[0]['attachment'].append(second)
        self.process()
        self.assertEqual(len(set(self.downloads)), 2)
        manifest = next((self.root / 'downloads').rglob('manifest.json'))
        self.assertEqual(len(json.loads(manifest.read_text())['files']), 2)

    def test_legacy_matching_manifest_hash_is_adopted_without_duplicate(self):
        folder = self.root / 'downloads' / 'Test room' / '2026-09-10_Photo description'
        folder.mkdir(parents=True)
        content = b'legacy complete photo'
        (folder / 'photo.jpg').write_bytes(content)
        (folder / 'manifest.json').write_text(json.dumps({
            'messageName': self.messages[0]['name'],
            'files': [{'fileName': 'photo.jpg', 'contentHash': hashlib.sha256(content).hexdigest()}],
        }))
        self.process()
        self.assertEqual(len(self.downloads), 0)
        self.assertEqual(len(list((self.root / 'downloads' / '.receipts').glob('*.json'))), 1)

    def test_metadata_filename_attachment_does_not_replace_manifest(self):
        self.messages[0]['attachment'][0]['contentName'] = 'manifest.json'
        self.process()
        manifest = next((self.root / 'downloads').rglob('manifest.json'))
        self.assertNotEqual(json.loads(manifest.read_text())['files'][0]['fileName'], 'manifest.json')

    def test_metadata_lock_filename_is_reserved(self):
        self.messages[0]['attachment'][0]['contentName'] = 'manifest.json.lock'
        self.process()
        self.assertNotEqual(Path(self.downloads[0]).name, 'manifest.json.lock')

    def test_receipts_use_portable_relative_paths(self):
        self.process()
        receipt_path = next((self.root / 'downloads' / '.receipts').glob('*.json'))
        receipt = json.loads(receipt_path.read_text())
        self.assertNotIn('\\', receipt['path'])
        self.assertFalse(Path(receipt['path']).is_absolute())

    def test_space_names_with_case_insensitive_collision_use_distinct_folders(self):
        self.process('Test room')
        with patch('chat.get_all_messages', return_value=[{
            **self.messages[0], 'name': 'spaces/second/messages/one',
        }]):
            chat.process_space(Mock(), FakeCredentials(), 'spaces/second', 'test ROOM')
        folders = {str(Path(path).parent.parent).casefold() for path in self.downloads}
        self.assertEqual(len(folders), 2)

    def test_windows_reserved_names_are_safe(self):
        self.assertEqual(chat.sanitize_filename('CON.jpg'), '_CON.jpg')
        self.assertNotIn('\x00', chat.sanitize_filename('photo\x00.jpg'))

    def test_existing_receipt_remains_authority_when_manifest_is_corrupted(self):
        self.process()
        manifest = next((self.root / 'downloads').rglob('manifest.json'))
        manifest.write_text('{broken')
        self.process()
        self.assertEqual(len(self.downloads), 1)
        self.assertEqual(len(json.loads(manifest.read_text())['files']), 1)

    def test_invalid_manifest_lists_are_rebuilt_from_receipt(self):
        self.process()
        manifest = next((self.root / 'downloads').rglob('manifest.json'))
        manifest.write_text('{"files": null, "messages": null}')
        try:
            stats = self.process()
        except TypeError:
            self.fail('Malformed manifest lists must be rebuilt using the complete receipt')
        self.assertEqual(stats['skipped'], 1)
        self.assertEqual(len(self.downloads), 1)
        self.assertEqual(len(json.loads(manifest.read_text())['files']), 1)

    def test_simultaneous_jobs_for_same_space_do_not_duplicate_downloads(self):
        with ThreadPoolExecutor(max_workers=2) as pool:
            list(pool.map(lambda _: chat.process_space(Mock(), FakeCredentials(), 'spaces/test', 'Test room'), range(2)))
        self.assertEqual(len(self.downloads), 1)

    def test_concurrent_same_room_jobs_with_new_ids_preserve_both_files(self):
        def messages(service, space):
            message = {**self.messages[0], 'name': f'spaces/test/messages/{service}'}
            message['attachment'] = [{**self.messages[0]['attachment'][0], 'name': f'spaces/test/messages/{service}/attachments/a'}]
            return [message]
        def download(service, creds, attachment, path):
            threading.Event().wait(0.05)
            self.downloads.append(path)
            return True, chat.write_downloaded_content(path, b'synthetic complete file')
        with patch('chat.get_all_messages', side_effect=messages), patch('chat.download_attachment', side_effect=download), ThreadPoolExecutor(max_workers=2) as pool:
            list(pool.map(lambda index: chat.process_space(index, FakeCredentials(), 'spaces/test', 'Test room'), range(2)))
        self.assertEqual(len(set(self.downloads)), 2)

    def test_partial_failure_is_exit_two(self):
        self.assertTrue(callable(getattr(chat, 'main', None)))
        with patch('chat.get_chat_service', return_value=(Mock(), FakeCredentials())), patch('chat.download_attachment', return_value=(False, None)):
            self.assertEqual(chat.main(['--space', 'spaces/test']), 2)

    def test_auth_failure_stops_pending_files_and_is_exit_three(self):
        self.assertTrue(callable(getattr(chat, 'main', None)))
        for index in range(1, 8):
            attachment = dict(self.messages[0]['attachment'][0])
            attachment['name'] += str(index)
            attachment['contentName'] = f'{index}.jpg'
            self.messages[0]['attachment'].append(attachment)
        with patch('chat.get_chat_service', return_value=(Mock(), FakeCredentials())), patch('chat.download_attachment', side_effect=chat.AuthRequired()) as download:
            self.assertEqual(chat.main(['--space', 'spaces/test']), 3)
        self.assertEqual(download.call_count, 1)


class HttpTests(ChatTestCase):
    def response(self, status=200, content=b'synthetic-photo', headers=None):
        response = requests.Response()
        response.status_code = status
        response._content = content
        response._content_consumed = True
        response.headers.update(headers or {})
        return response

    def test_media_retries_rate_limit_then_succeeds(self):
        with patch('chat.requests.get', side_effect=[self.response(429), self.response()]) as request:
            result = chat._download_media_http(FakeCredentials(), 'resource')
        self.assertEqual(result, b'synthetic-photo')
        self.assertEqual(request.call_count, 2)

    def test_content_length_mismatch_is_rejected(self):
        with patch('chat.requests.get', return_value=self.response(headers={'Content-Length': '1000'})):
            with self.assertRaises(ValueError):
                chat._download_media_http(FakeCredentials(), 'resource')

    def test_download_uri_never_receives_bearer_on_untrusted_host(self):
        attachment = {'downloadUri': 'https://attacker.example/photo', 'contentName': 'photo.jpg'}
        with patch('chat.requests.get') as request:
            result = chat.download_attachment(Mock(), FakeCredentials(), attachment, self.root / 'photo.jpg')
        self.assertEqual(result, (False, None))
        request.assert_not_called()

    def test_redirect_never_receives_bearer_on_untrusted_host(self):
        response = self.response(302, headers={'Location': 'https://attacker.example/file'})
        with patch('chat.requests.get', return_value=response) as request:
            with self.assertRaises(ValueError):
                chat._download_media_http(FakeCredentials(), 'resource')
        self.assertEqual(request.call_count, 1)

    def test_transient_media_errors_have_bounded_attempts(self):
        with patch('chat.requests.get', return_value=self.response(503)) as request:
            with self.assertRaises(requests.HTTPError):
                chat._download_media_http(FakeCredentials(), 'resource')
        self.assertEqual(request.call_count, 3)

    def test_interrupted_response_never_replaces_existing_file(self):
        destination = self.root / 'photo.jpg'
        destination.write_bytes(b'previous complete photo')
        response = self.response()
        def interrupted_chunks(**kwargs):
            yield b'incomplete new photo'
            raise requests.ConnectionError('synthetic interrupted response')
        response.iter_content = interrupted_chunks
        attachment = {'attachmentDataRef': {'resourceName': 'resource'}}
        with patch('chat.requests.get', return_value=response):
            self.assertEqual(chat.download_attachment(Mock(), FakeCredentials(), attachment, destination), (False, None))
        self.assertEqual(destination.read_bytes(), b'previous complete photo')
        self.assertEqual(list(self.root.glob('*.part')), [])

    def test_unauthorized_media_refreshes_once_then_requires_auth(self):
        with patch('chat.requests.get', return_value=self.response(401)) as request, patch('chat.refresh_credentials', return_value='synthetic-access') as refresh:
            with self.assertRaises(chat.AuthRequired):
                chat._download_media_http(FakeCredentials(), 'resource')
        self.assertEqual(request.call_count, 2)
        self.assertEqual(sum(1 for call in refresh.call_args_list if call.kwargs.get('force')), 1)


if __name__ == '__main__':
    unittest.main()
