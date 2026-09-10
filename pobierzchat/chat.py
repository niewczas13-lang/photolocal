import os
import sys
import re
import json
import time
import threading
import argparse
import contextlib
import hashlib
import tempfile
import random
from urllib.parse import urljoin, urlparse
import requests
import httplib2
from google_auth_httplib2 import AuthorizedHttp
from concurrent.futures import ThreadPoolExecutor, as_completed
from google.auth.credentials import Credentials as BaseCredentials
from google.auth.exceptions import RefreshError, TransportError
from google.oauth2.credentials import Credentials
from googleapiclient.discovery import build
from googleapiclient.errors import HttpError
from google.auth.transport.requests import Request
from google_auth_oauthlib.flow import InstalledAppFlow

SCOPES = [
    'https://www.googleapis.com/auth/chat.messages.readonly',
    'https://www.googleapis.com/auth/chat.spaces.readonly',
]

# Folder docelowy na pobrane pliki
DOWNLOAD_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'pobrane_zdjecia')
SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
FILE_LOCK = threading.RLock()
REFRESH_LOCK = threading.RLock()
API_LOCK = threading.RLock()
MAX_ATTEMPTS = 3
MAX_ATTACHMENT_BYTES = 250 * 1024 * 1024
DOWNLOAD_CONTEXT = threading.local()
PATH_LOCKS = {}

# Typy MIME zdjęć do pobrania (None = pobieraj wszystko)
IMAGE_MIME_TYPES = {'image/jpeg', 'image/png', 'image/webp', 'image/gif', 'image/bmp'}

# Limit równoległych pobrań i wykorzystania pamięci.
WORKERS = 4


class AuthRequired(RuntimeError):
    def __init__(self):
        super().__init__('PHOTO_LOCAL_AUTH_REQUIRED')


class ManagedCredentials(BaseCredentials):
    """Route the SDK's implicit token refresh through the same durable transaction."""
    def __init__(self, credentials):
        super().__init__()
        self.credentials = credentials

    def refresh(self, request):
        self.token = refresh_credentials(self.credentials, force=True)

    def before_request(self, request, method, url, headers):
        self.token = refresh_credentials(self.credentials)
        self.apply(headers)


def configured_path(variable, default):
    return os.path.abspath(os.environ.get(variable) or os.path.join(SCRIPT_DIR, default))


@contextlib.contextmanager
def file_lock(path):
    """Lock a stable sidecar, not the file replaced during an atomic write."""
    lock_path = os.fspath(path) + '.lock'
    os.makedirs(os.path.dirname(os.path.abspath(lock_path)), exist_ok=True)
    with FILE_LOCK:
        local_lock = PATH_LOCKS.setdefault(os.path.normcase(os.path.abspath(lock_path)), threading.RLock())
    with local_lock, open(lock_path, 'a+b') as handle:
        if os.name == 'nt':
            import msvcrt
            if os.path.getsize(lock_path) == 0:
                handle.write(b'\0')
                handle.flush()
            deadline = time.monotonic() + 30
            while True:
                try:
                    handle.seek(0)
                    msvcrt.locking(handle.fileno(), msvcrt.LK_NBLCK, 1)
                    break
                except OSError:
                    if time.monotonic() >= deadline:
                        raise TimeoutError('Timed out waiting for file lock') from None
                    time.sleep(0.05)
        else:
            import fcntl
            deadline = time.monotonic() + 30
            while True:
                try:
                    fcntl.flock(handle.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
                    break
                except BlockingIOError:
                    if time.monotonic() >= deadline:
                        raise TimeoutError('Timed out waiting for file lock') from None
                    time.sleep(0.05)
        try:
            yield
        finally:
            if os.name == 'nt':
                handle.seek(0)
                msvcrt.locking(handle.fileno(), msvcrt.LK_UNLCK, 1)
            else:
                fcntl.flock(handle.fileno(), fcntl.LOCK_UN)


def atomic_write(path, content):
    directory = os.path.dirname(os.path.abspath(path))
    os.makedirs(directory, exist_ok=True)
    descriptor, temporary = tempfile.mkstemp(prefix='.' + os.path.basename(path) + '.', suffix='.part', dir=directory)
    try:
        with os.fdopen(descriptor, 'wb') as handle:
            handle.write(content)
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temporary, path)
        if os.name != 'nt':
            directory_fd = os.open(directory, os.O_RDONLY)
            try:
                os.fsync(directory_fd)
            finally:
                os.close(directory_fd)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


def atomic_json(path, content):
    atomic_write(path, json.dumps(content, ensure_ascii=False, indent=2).encode('utf-8'))


def terminal_refresh_error(error):
    details = ' '.join(str(argument) for argument in error.args).lower()
    return 'invalid_grant' in details or 'revoked' in details


def retry(operation):
    for attempt in range(MAX_ATTEMPTS):
        try:
            return operation()
        except RefreshError as error:
            if terminal_refresh_error(error):
                raise AuthRequired() from None
            if not error.retryable or attempt == MAX_ATTEMPTS - 1:
                raise
        except (requests.RequestException, TransportError, HttpError, httplib2.HttpLib2Error, ConnectionError, TimeoutError) as error:
            response = getattr(error, 'response', None)
            status = getattr(response, 'status_code', None) or getattr(getattr(error, 'resp', None), 'status', None)
            if status == 401:
                raise AuthRequired() from None
            if status and status != 429 and not 500 <= status <= 599:
                raise
            if attempt == MAX_ATTEMPTS - 1:
                raise
        time.sleep(min(4, 2 ** attempt) + random.uniform(0, 0.2))


def load_credentials(path):
    try:
        return Credentials.from_authorized_user_file(path, SCOPES)
    except (FileNotFoundError, ValueError, KeyError):
        raise AuthRequired() from None


def refresh_credentials(creds, force=False):
    with REFRESH_LOCK:
        if not force and creds.valid:
            return creds.token
        token_path = configured_path('GOOGLE_CHAT_TOKEN_FILE', 'token.json')
        with file_lock(token_path):
            persisted = load_credentials(token_path)
            if persisted.valid and (not force or persisted.token != creds.token):
                creds.token = persisted.token
                creds.expiry = persisted.expiry
                return creds.token
            if not persisted.refresh_token:
                raise AuthRequired()
            previous_refresh_token = persisted.refresh_token
            with requests.Session() as session:
                request = Request(session=session)
                retry(lambda: persisted.refresh(
                    lambda *args, **kwargs: request(*args, **{**kwargs, 'timeout': 30}),
                ))
            data = json.loads(persisted.to_json())
            data['refresh_token'] = data.get('refresh_token') or previous_refresh_token
            atomic_json(token_path, data)
            creds.token = persisted.token
            creds.expiry = persisted.expiry
            return creds.token


def configure_console_output():
    """Nie przerywaj pobierania, gdy konsola Windows nie umie wypisac znaku."""
    for stream in (sys.stdout, sys.stderr):
        if hasattr(stream, 'reconfigure'):
            stream.reconfigure(encoding='utf-8', errors='replace', line_buffering=True)


configure_console_output()


def get_chat_service(allow_login=False):
    token_path = configured_path('GOOGLE_CHAT_TOKEN_FILE', 'token.json')
    if allow_login:
        flow = InstalledAppFlow.from_client_secrets_file(
            configured_path('GOOGLE_CHAT_CREDENTIALS_FILE', 'credentials.json'), SCOPES,
        )
        creds = flow.run_local_server(port=0)
        with file_lock(token_path):
            atomic_json(token_path, json.loads(creds.to_json()))
    else:
        creds = load_credentials(token_path)
        refresh_credentials(creds)
    transport = AuthorizedHttp(ManagedCredentials(creds), http=httplib2.Http(timeout=30), max_refresh_attempts=1)
    return build('chat', 'v1', http=transport, cache_discovery=False), creds


def ensure_script_cwd():
    os.chdir(os.path.dirname(os.path.abspath(__file__)))


def sanitize_filename(name):
    """Usuwa znaki niedozwolone w nazwach plików/folderów (Windows)."""
    # Zamień znaki nowej linii, tabulatory i inne kontrolne na spacje
    name = re.sub(r'[\x00-\x1f\x7f]+', ' ', name)
    # Zamień znaki niedozwolone w Windows
    name = re.sub(r'[<>:"/\\|?*]', '_', name)
    # Usuń wielokrotne spacje
    name = re.sub(r'\s+', ' ', name)
    name = name.strip('. ')
    if name.split('.')[0].rstrip(' .').upper() in {
        'CON', 'PRN', 'AUX', 'NUL', *(f'COM{index}' for index in range(1, 10)),
        *(f'LPT{index}' for index in range(1, 10)),
    }:
        name = '_' + name
    if len(name) > 200:
        stem, extension = os.path.splitext(name)
        name = stem[:180] + extension[:20]
    return name if name else 'brak_nazwy'


def _load_manifest(manifest_path):
    if not os.path.exists(manifest_path):
        return None
    try:
        with open(manifest_path, 'r', encoding='utf-8') as f:
            content = json.load(f)
            if not isinstance(content, dict):
                return None
            for key in ('files', 'messages'):
                if key in content and not isinstance(content[key], list):
                    content[key] = []
            return content
    except (OSError, json.JSONDecodeError):
        return None


def upsert_message_manifest(manifest_path, base_data, file_entry):
    with file_lock(manifest_path):
        _upsert_message_manifest(manifest_path, base_data, file_entry)


def _upsert_message_manifest(manifest_path, base_data, file_entry):
    """
    Zapisuje manifest paczki Google Chat.
    Funkcja jest idempotentna: wpisy plików są scalane po fileName.
    """
    manifest = _load_manifest(manifest_path) or {**base_data, 'files': []}
    manifest.update(base_data)

    source_message = {
        'messageName': base_data.get('messageName', ''),
        'messageText': base_data.get('messageText', ''),
        'createTime': base_data.get('createTime', ''),
    }
    messages_by_name = {
        entry.get('messageName'): entry
        for entry in manifest.get('messages', [])
        if isinstance(entry, dict) and entry.get('messageName')
    }
    if source_message['messageName']:
        messages_by_name[source_message['messageName']] = source_message
    manifest['messages'] = sorted(
        messages_by_name.values(),
        key=lambda entry: (entry.get('createTime', ''), entry.get('messageName', '')),
    )

    files_by_name = {
        entry.get('fileName'): entry
        for entry in manifest.get('files', [])
        if isinstance(entry, dict) and entry.get('fileName')
    }
    existing_file = files_by_name.get(file_entry['fileName'], {})
    if 'contentHash' not in file_entry and existing_file.get('contentHash'):
        file_entry = {**file_entry, 'contentHash': existing_file['contentHash']}
    files_by_name[file_entry['fileName']] = file_entry
    manifest['files'] = sorted(files_by_name.values(), key=lambda entry: entry['fileName'])

    atomic_json(manifest_path, manifest)


def list_spaces(service):
    """Pobiera i wyświetla wszystkie pokoje."""
    print("\n=== LISTA POKOJÓW (SPACES) ===")
    spaces = []
    page_token = None
    while True:
        result = retry(lambda: service.spaces().list(pageSize=100, pageToken=page_token).execute())
        batch = result.get('spaces', [])
        spaces.extend(batch)
        page_token = result.get('nextPageToken')
        if not page_token:
            break

    if not spaces:
        print("  Brak pokojów!")
        return spaces

    for i, sp in enumerate(spaces):
        sp_type = sp.get('spaceType', sp.get('type', '?'))
        display = sp.get('displayName', '(brak nazwy)')
        print(f"  {i+1}. {sp['name']}  |  typ: {sp_type}  |  nazwa: {display}")

    return spaces


def fetch_spaces(service):
    spaces = []
    page_token = None
    while True:
        result = retry(lambda: service.spaces().list(pageSize=100, pageToken=page_token).execute())
        spaces.extend(result.get('spaces', []))
        page_token = result.get('nextPageToken')
        if not page_token:
            break
    return spaces


def space_to_json(space):
    return {
        'name': space.get('name', ''),
        'displayName': space.get('displayName', space.get('name', '')),
        'spaceType': space.get('spaceType', space.get('type', '')),
    }


def get_all_messages(service, space_name):
    """Pobiera WSZYSTKIE wiadomości z pokoju (z paginacją)."""
    all_messages = []
    page_token = None
    page_num = 0

    while True:
        page_num += 1
        result = retry(lambda: service.spaces().messages().list(
            parent=space_name,
            pageSize=100,
            pageToken=page_token
        ).execute())

        messages = result.get('messages', [])
        all_messages.extend(messages)
        print(f"  Strona {page_num}: +{len(messages)} wiadomości (łącznie: {len(all_messages)})")

        page_token = result.get('nextPageToken')
        if not page_token:
            break

    return all_messages


def checked_download_url(url):
    parsed = urlparse(url)
    host = (parsed.hostname or '').lower()
    if (parsed.scheme != 'https' or parsed.username or parsed.password
            or parsed.port not in (None, 443)
            or not (host in {'chat.googleapis.com', 'chat.google.com'}
                    or host == 'googleusercontent.com' or host.endswith('.googleusercontent.com'))):
        raise ValueError('Unsupported attachment URL')
    return url


def check_download_abort():
    event = getattr(DOWNLOAD_CONTEXT, 'abort_event', None)
    if event is not None and event.is_set():
        raise AuthRequired()


def _download_http(creds, url):
    checked_download_url(url)

    def attempt():
        check_download_abort()
        token = refresh_credentials(creds)
        current_url = url
        refreshed = False
        redirects = 0
        while True:
            check_download_abort()
            checked_download_url(current_url)
            response = requests.get(
                current_url, headers={'Authorization': f'Bearer {token}'},
                stream=True, allow_redirects=False, timeout=(15, 60),
            )
            try:
                if response.status_code == 401:
                    if refreshed:
                        raise AuthRequired()
                    token = refresh_credentials(creds, force=True)
                    refreshed = True
                    continue
                if response.status_code in (301, 302, 303, 307, 308):
                    redirects += 1
                    if redirects > 3:
                        raise ValueError('Too many attachment redirects')
                    current_url = urljoin(current_url, response.headers.get('Location', ''))
                    continue
                response.raise_for_status()
                if response.status_code != 200:
                    raise ValueError('Unexpected attachment response')
                content_type = response.headers.get('Content-Type', '').split(';')[0].strip()
                if content_type in {'text/html', 'application/json'}:
                    raise ValueError('Attachment response is not file content')
                chunks = []
                size = 0
                for chunk in response.iter_content(chunk_size=1024 * 1024):
                    check_download_abort()
                    size += len(chunk)
                    if size > MAX_ATTACHMENT_BYTES:
                        raise ValueError('Attachment exceeds download size limit')
                    chunks.append(chunk)
                content = b''.join(chunks)
                expected_size = response.headers.get('Content-Length')
                if not content or (expected_size and not response.headers.get('Content-Encoding')
                                   and int(expected_size) != len(content)):
                    raise ValueError('Incomplete attachment content')
                return content
            finally:
                response.close()

    return retry(attempt)


def _download_media_http(creds, resource_name):
    return _download_http(creds, f'https://chat.googleapis.com/v1/media/{resource_name}?alt=media')


def write_downloaded_content(save_path, content):
    if not content:
        raise ValueError('Empty attachment')
    atomic_write(save_path, content)
    return hashlib.sha256(content).hexdigest()


def hash_existing_file(path):
    try:
        digest = hashlib.sha256()
        with open(path, 'rb') as f:
            for chunk in iter(lambda: f.read(1024 * 1024), b''):
                digest.update(chunk)
        return digest.hexdigest()
    except OSError:
        return None


def download_attachment(service, creds, attachment, save_path):
    resource_name = attachment.get('attachmentDataRef', {}).get('resourceName')
    download_uri = attachment.get('downloadUri')
    attachment_name = attachment.get('name')
    methods = []
    if resource_name:
        methods.append(lambda: _download_media_http(creds, resource_name))
    if download_uri:
        methods.append(lambda: _download_http(creds, download_uri))
    if attachment_name:
        def metadata_download():
            with API_LOCK:
                metadata = retry(lambda: service.spaces().messages().attachments().get(name=attachment_name).execute())
            reference = metadata.get('attachmentDataRef', {}).get('resourceName')
            if not reference:
                raise ValueError('Attachment has no media reference')
            return _download_media_http(creds, reference)
        methods.append(metadata_download)
    for method in methods:
        try:
            check_download_abort()
            content = method()
            expected_size = attachment.get('sizeBytes') or attachment.get('size')
            if expected_size is not None and int(expected_size) != len(content):
                raise ValueError('Attachment metadata size mismatch')
            digest = write_downloaded_content(save_path, content)
            print(f'    [OK] Pobrano plik: {sanitize_filename(attachment.get("contentName", "unknown"))} ({len(content)} bajtow)')
            return True, digest
        except AuthRequired:
            raise
        except RefreshError as error:
            if terminal_refresh_error(error):
                raise AuthRequired() from None
            return False, None
        except (requests.RequestException, TransportError, HttpError, httplib2.HttpLib2Error, OSError, ValueError):
            # Raw exceptions can contain signed URLs or credentials. Keep diagnostics safe.
            continue
    print('    [!!] Nie udalo sie pobrac zalacznika.')
    return False, None


def attachment_key(space_name, message, attachment):
    identity = attachment.get('name') or attachment.get('attachmentDataRef', {}).get('resourceName')
    if not identity or not message.get('name'):
        raise ValueError('Attachment is missing a stable Google identifier')
    return hashlib.sha256(json.dumps([space_name, message['name'], identity]).encode('utf-8')).hexdigest()


def receipt_file(root, key):
    return os.path.join(root, '.receipts', key + '.json')


def receipt_destination(root, receipt, key):
    if not receipt or receipt.get('attachmentKey') != key or not isinstance(receipt.get('path'), str):
        return None
    candidate = os.path.realpath(os.path.join(root, receipt['path'].replace('\\', '/')))
    if os.path.commonpath([os.path.realpath(root), candidate]) != os.path.realpath(root):
        return None
    return candidate


def receipt_is_complete(receipt, path):
    try:
        return (bool(receipt.get('contentHash')) and receipt.get('size', 0) > 0
                and os.path.getsize(path) == receipt['size']
                and hash_existing_file(path) == receipt['contentHash'])
    except (OSError, TypeError):
        return False


def legacy_file_is_complete(path, manifest, base, key):
    if not manifest:
        return False
    for entry in manifest.get('files', []):
        if not isinstance(entry, dict) or entry.get('fileName') != os.path.basename(path):
            continue
        has_identity = entry.get('attachmentKey') == key or (
            not entry.get('attachmentKey') and manifest.get('messageName') == base['messageName']
            and len(manifest.get('messages', [])) <= 1)
        digest = entry.get('contentHash')
        if has_identity and digest and hash_existing_file(path) == digest:
            return os.path.getsize(path) > 0 and (
                not entry.get('size') or os.path.getsize(path) == entry['size'])
    return False


def resolve_attachment_path(root, key, proposed, base, reserved):
    receipt = _load_manifest(receipt_file(root, key))
    previous_path = receipt_destination(root, receipt, key)
    if previous_path:
        reserved[os.path.normcase(previous_path).casefold()] = key
        return previous_path
    candidate = proposed
    manifest = _load_manifest(os.path.join(os.path.dirname(candidate), 'manifest.json')) or {}
    existing = next((entry for entry in manifest.get('files', [])
                     if isinstance(entry, dict)
                     and str(entry.get('fileName', '')).casefold() == os.path.basename(candidate).casefold()), None)
    owner = reserved.get(os.path.normcase(candidate).casefold())
    collision = owner is not None and owner != key
    if existing:
        collision = collision or (existing.get('attachmentKey') not in (None, key))
        collision = collision or (not existing.get('attachmentKey')
                                  and manifest.get('messageName') != base['messageName'])
    if os.path.basename(candidate).casefold() in {
        'manifest.json', 'manifest.json.lock', '.space.json', '.space.json.lock',
    }:
        collision = True
    if collision:
        stem, extension = os.path.splitext(os.path.basename(proposed))
        candidate = os.path.join(os.path.dirname(proposed), f'{stem[:160]}_{key[:16]}{extension[:20]}')
    reserved[os.path.normcase(candidate).casefold()] = key
    return candidate


def save_receipt(root, key, path, content_hash):
    atomic_json(receipt_file(root, key), {
        'version': 1, 'attachmentKey': key,
        'path': os.path.relpath(path, root).replace(os.sep, '/'), 'size': os.path.getsize(path),
        'contentHash': content_hash,
    })


def space_directory(root, space_name, display_name):
    registry_path = os.path.join(root, '.spaces.json')
    with file_lock(registry_path):
        registry = _load_manifest(registry_path) or {}
        previous = registry.get(space_name)
        if isinstance(previous, str) and previous == sanitize_filename(previous):
            return os.path.join(root, previous)
        folder = sanitize_filename(display_name)
        claimed = {value.casefold() for value in registry.values() if isinstance(value, str)}
        marker = _load_manifest(os.path.join(root, folder, '.space.json')) or {}
        if folder.casefold() in claimed or marker.get('spaceName') not in (None, space_name):
            suffix = hashlib.sha256(space_name.encode('utf-8')).hexdigest()[:12]
            folder = folder[:180] + '_' + suffix
        os.makedirs(os.path.join(root, folder), exist_ok=True)
        atomic_json(os.path.join(root, folder, '.space.json'), {'spaceName': space_name})
        registry[space_name] = folder
        atomic_json(registry_path, registry)
        return os.path.join(root, folder)


def process_space(service, creds, space_name, space_display_name, download_all=False):
    root = configured_path('GOOGLE_CHAT_DOWNLOAD_ROOT', DOWNLOAD_DIR)
    key = hashlib.sha256(space_name.encode('utf-8')).hexdigest()
    with file_lock(os.path.join(root, '.jobs', key)):
        return _process_space(service, creds, space_name, space_display_name, download_all)


def emit_progress(root_path, total, stats):
    completed = stats['downloaded'] + stats['skipped'] + stats['failed']
    print('PHOTO_LOCAL_PROGRESS ' + json.dumps({
        'rootPath': root_path,
        'totalFiles': total,
        'downloadedFiles': stats['downloaded'],
        'skippedFiles': stats['skipped'],
        'failedFiles': stats['failed'],
        'pendingFiles': max(0, total - completed),
    }, ensure_ascii=False))


def _process_space(service, creds, space_name, space_display_name, download_all=False):
    print(f'\n  Przetwarzanie pokoju: {space_display_name}')
    messages = get_all_messages(service, space_name)
    root = configured_path('GOOGLE_CHAT_DOWNLOAD_ROOT', DOWNLOAD_DIR)
    space_dir = space_directory(root, space_name, space_display_name)
    os.makedirs(space_dir, exist_ok=True)
    stats = {'downloaded': 0, 'skipped': 0, 'failed': 0, 'pending': 0}
    tasks = []
    reserved = {}
    keys = set()
    for message in sorted(messages, key=lambda item: (item.get('createTime', ''), item.get('name', ''))):
        text = message.get('text', '').strip()
        date = message.get('createTime', '')[:10]
        folder_name = f'{date}_{sanitize_filename(text[:60]) if text else "brak_opisu"}'
        folder = os.path.join(space_dir, folder_name)
        base = {
            'source': 'google-chat', 'spaceName': space_name,
            'spaceDisplayName': space_display_name, 'messageName': message.get('name', ''),
            'messageText': text, 'createTime': message.get('createTime', ''), 'folderName': folder_name,
        }
        for attachment in message.get('attachment', message.get('attachments', [])):
            mime_type = attachment.get('contentType', attachment.get('mimeType', ''))
            if not download_all and mime_type not in IMAGE_MIME_TYPES:
                continue
            try:
                key = attachment_key(space_name, message, attachment)
            except ValueError:
                stats['failed'] += 1
                continue
            if key in keys:
                continue
            keys.add(key)
            filename = sanitize_filename(attachment.get('contentName', 'unknown'))
            path = resolve_attachment_path(root, key, os.path.join(folder, filename), base, reserved)
            tasks.append((attachment, key, path, base))
    total = len(tasks) + stats['failed']
    print(f'  Laczna liczba plikow do pobrania: {total}')
    emit_progress(space_dir, total, stats)
    abort_event = threading.Event()

    def download_one(task):
        attachment, key, path, original_base = task
        DOWNLOAD_CONTEXT.abort_event = abort_event
        try:
            if abort_event.is_set():
                return 'pending'
            with file_lock(receipt_file(root, key)):
                if abort_event.is_set():
                    return 'pending'
                os.makedirs(os.path.dirname(path), exist_ok=True)
                manifest_path = os.path.join(os.path.dirname(path), 'manifest.json')
                base = {**original_base, 'folderName': os.path.basename(os.path.dirname(path))}
                receipt = _load_manifest(receipt_file(root, key))
                manifest = _load_manifest(manifest_path)
                complete = (
                    receipt_destination(root, receipt, key) == os.path.realpath(path)
                    and receipt_is_complete(receipt or {}, path)
                ) or legacy_file_is_complete(path, manifest, base, key)
                if complete:
                    content_hash = hash_existing_file(path)
                    result = 'skipped'
                else:
                    # Only remove this attachment's abandoned temporary writes while holding its lock.
                    prefix = '.' + os.path.basename(path) + '.'
                    for entry in os.scandir(os.path.dirname(path)):
                        if entry.is_file() and entry.name.startswith(prefix) and entry.name.endswith('.part'):
                            os.unlink(entry.path)
                    success, content_hash = download_attachment(service, creds, attachment, path)
                    if not success:
                        return 'failed'
                    result = 'downloaded'
                file_entry = {
                    'fileName': os.path.basename(path), 'contentName': attachment.get('contentName', 'unknown'),
                    'contentType': attachment.get('contentType', attachment.get('mimeType', '')),
                    'contentHash': content_hash, 'size': os.path.getsize(path), 'attachmentKey': key,
                    'attachmentName': attachment.get('name', ''), 'messageName': base['messageName'],
                }
                upsert_message_manifest(manifest_path, base, file_entry)
                save_receipt(root, key, path, content_hash)
                return result
        except AuthRequired:
            abort_event.set()
            return 'pending'
        except (OSError, ValueError, requests.RequestException, TransportError, HttpError, httplib2.HttpLib2Error, RefreshError):
            return 'failed'
        finally:
            DOWNLOAD_CONTEXT.abort_event = None

    with ThreadPoolExecutor(max_workers=WORKERS) as pool:
        for future in as_completed([pool.submit(download_one, task) for task in tasks]):
            stats[future.result()] += 1
            if sum(stats.values()) % 20 == 0:
                emit_progress(space_dir, total, stats)
                print(f'  Pobrano:    {stats["downloaded"]}')
                print(f'  Pominięto:  {stats["skipped"]}')
                print(f'  Błędów:     {stats["failed"]}')
    print(f'  Pobrano:    {stats["downloaded"]}')
    print(f'  Pominięto:  {stats["skipped"]}')
    print(f'  Błędów:     {stats["failed"]}')
    print(f'  Oczekuje:   {stats["pending"]}')
    print(f'  Zapisano w: {space_dir}')
    emit_progress(space_dir, total, stats)
    if abort_event.is_set():
        raise AuthRequired()
    return stats


def run_noninteractive(args):
    if args.login:
        get_chat_service(allow_login=True)
        print('[OK] Polaczono Google Chat.')
        return 0
    if args.list_spaces_json:
        with contextlib.redirect_stdout(sys.stderr):
            service, _creds = get_chat_service()
            spaces = fetch_spaces(service)
        print(json.dumps([space_to_json(space) for space in spaces], ensure_ascii=False))
        return 0
    if args.space or args.all:
        service, creds = get_chat_service()
        spaces = fetch_spaces(service) if args.all else [{
            'name': args.space, 'displayName': args.space_display_name or args.space,
        }]
        failed = False
        for space in spaces:
            if args.all and space.get('spaceType', space.get('type')) != 'SPACE':
                continue
            stats = process_space(service, creds, space['name'], space.get('displayName', space['name']), args.download_all_types)
            failed = failed or stats['failed'] > 0
        return 2 if failed else 0
    return None


def main(argv=None):
    parser = argparse.ArgumentParser(add_help=True)
    mode = parser.add_mutually_exclusive_group()
    mode.add_argument('--list-spaces-json', action='store_true')
    mode.add_argument('--space')
    mode.add_argument('--all', action='store_true')
    mode.add_argument('--login', action='store_true', help='Explicit desktop OAuth login (opens browser)')
    parser.add_argument('--space-display-name')
    parser.add_argument('--download-all-types', action='store_true')
    args = parser.parse_args(argv)
    try:
        result = run_noninteractive(args)
        if result is not None:
            return result
        # Legacy interactive room picker, with login still requiring explicit --login.
        service, creds = get_chat_service()
        spaces = list_spaces(service)
        if not spaces:
            return 0
        choice = input('Wybor pokoju (numer, ID lub all; A numer = wszystkie pliki): ').strip()
        download_all = args.download_all_types
        if choice.upper().startswith('A '):
            download_all = True
            choice = choice[2:].strip()
        if choice.lower() == 'all':
            selected = [space for space in spaces if space.get('spaceType', space.get('type')) == 'SPACE']
        elif choice.isdigit() and 0 < int(choice) <= len(spaces):
            selected = [spaces[int(choice) - 1]]
        elif choice.isdigit() or not choice:
            raise ValueError('Invalid space selection')
        else:
            selected = [{
                'name': choice if choice.startswith('spaces/') else f'spaces/{choice}',
                'displayName': choice,
            }]
        failed = False
        for space in selected:
            stats = process_space(service, creds, space['name'], space.get('displayName', space['name']), download_all)
            failed = failed or stats['failed'] > 0
        return 2 if failed else 0
    except AuthRequired:
        print(json.dumps({'code': 'PHOTO_LOCAL_AUTH_REQUIRED', 'message': 'Google Chat connection requires authorization.'}), file=sys.stderr)
        return 3
    except Exception:
        print(json.dumps({'code': 'PHOTO_LOCAL_DOWNLOAD_FAILED', 'message': 'Google Chat operation failed; retry is available.'}), file=sys.stderr)
        return 2


if __name__ == '__main__':
    sys.exit(main())
