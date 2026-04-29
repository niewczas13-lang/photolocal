import os
import sys
import io
import re
import json
import time
import threading
import argparse
import contextlib
import requests
from concurrent.futures import ThreadPoolExecutor, as_completed
from google.oauth2.credentials import Credentials
from googleapiclient.discovery import build
from googleapiclient.http import MediaIoBaseDownload
from google.auth.transport.requests import Request
from google_auth_oauthlib.flow import InstalledAppFlow

SCOPES = [
    'https://www.googleapis.com/auth/chat.messages.readonly',
    'https://www.googleapis.com/auth/chat.spaces.readonly',
]

# Folder docelowy na pobrane pliki
DOWNLOAD_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'pobrane_zdjecia')

# Typy MIME zdjęć do pobrania (None = pobieraj wszystko)
IMAGE_MIME_TYPES = {'image/jpeg', 'image/png', 'image/webp', 'image/gif', 'image/bmp'}

# Liczba równoległych pobrań (10 = ~10x szybciej)
WORKERS = 20


def get_chat_service():
    creds = None
    if os.path.exists('token.json'):
        creds = Credentials.from_authorized_user_file('token.json', SCOPES)
    if not creds or not creds.valid:
        if creds and creds.expired and creds.refresh_token:
            creds.refresh(Request())
        else:
            flow = InstalledAppFlow.from_client_secrets_file('credentials.json', SCOPES)
            creds = flow.run_local_server(port=0)
        with open('token.json', 'w') as token:
            token.write(creds.to_json())
    return build('chat', 'v1', credentials=creds), creds


def ensure_script_cwd():
    os.chdir(os.path.dirname(os.path.abspath(__file__)))


def sanitize_filename(name):
    """Usuwa znaki niedozwolone w nazwach plików/folderów (Windows)."""
    # Zamień znaki nowej linii, tabulatory i inne kontrolne na spacje
    name = re.sub(r'[\r\n\t]+', ' ', name)
    # Zamień znaki niedozwolone w Windows
    name = re.sub(r'[<>:"/\\|?*]', '_', name)
    # Usuń wielokrotne spacje
    name = re.sub(r'\s+', ' ', name)
    name = name.strip('. ')
    return name[:200] if name else 'brak_nazwy'


def _load_manifest(manifest_path):
    if not os.path.exists(manifest_path):
        return None
    try:
        with open(manifest_path, 'r', encoding='utf-8') as f:
            return json.load(f)
    except (OSError, json.JSONDecodeError):
        return None


def upsert_message_manifest(manifest_path, base_data, file_entry):
    """
    Zapisuje manifest paczki Google Chat.
    Funkcja jest idempotentna: wpisy plików są scalane po fileName.
    """
    manifest = _load_manifest(manifest_path) or {**base_data, 'files': []}
    manifest.update(base_data)

    files_by_name = {
        entry.get('fileName'): entry
        for entry in manifest.get('files', [])
        if isinstance(entry, dict) and entry.get('fileName')
    }
    files_by_name[file_entry['fileName']] = file_entry
    manifest['files'] = sorted(files_by_name.values(), key=lambda entry: entry['fileName'])

    with open(manifest_path, 'w', encoding='utf-8') as f:
        json.dump(manifest, f, ensure_ascii=False, indent=2)


def list_spaces(service):
    """Pobiera i wyświetla wszystkie pokoje."""
    print("\n=== LISTA POKOJÓW (SPACES) ===")
    spaces = []
    page_token = None
    while True:
        result = service.spaces().list(pageSize=100, pageToken=page_token).execute()
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
        result = service.spaces().list(pageSize=100, pageToken=page_token).execute()
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
        result = service.spaces().messages().list(
            parent=space_name,
            pageSize=100,
            pageToken=page_token
        ).execute()

        messages = result.get('messages', [])
        all_messages.extend(messages)
        print(f"  Strona {page_num}: +{len(messages)} wiadomości (łącznie: {len(all_messages)})")

        page_token = result.get('nextPageToken')
        if not page_token:
            break

    return all_messages


def _download_media_http(creds, resource_name):
    """
    Pobiera plik przez bezposredni HTTP GET z alt=media.
    Obchodzi bug w google-api-python-client ktory wysyla alt=json.
    """
    # Ensure token is fresh
    if creds.expired:
        creds.refresh(Request())
    url = f'https://chat.googleapis.com/v1/media/{resource_name}?alt=media'
    headers = {'Authorization': f'Bearer {creds.token}'}
    resp = requests.get(url, headers=headers, stream=True, timeout=60)
    resp.raise_for_status()
    return resp.content


def download_attachment(service, creds, attachment, save_path):
    """
    Pobiera pojedynczy zalacznik.
    Probuje 3 metody w kolejnosci:
      1. HTTP GET z alt=media (attachmentDataRef.resourceName)
      2. Bezposredni HTTP GET na downloadUri z tokenem OAuth
      3. spaces.messages.attachments.get -> pobranie resourceName -> HTTP GET
    """
    filename = attachment.get('contentName', 'unknown')

    # -- Metoda 1: HTTP GET z attachmentDataRef.resourceName --
    data_ref = attachment.get('attachmentDataRef', {})
    resource_name = data_ref.get('resourceName', '')

    if resource_name:
        try:
            content = _download_media_http(creds, resource_name)
            with open(save_path, 'wb') as f:
                f.write(content)
            size_kb = len(content) / 1024
            print(f"    [OK] Pobrano (media HTTP): {filename} ({size_kb:.1f} KB)")
            return True
        except Exception as e:
            print(f"    [!!] media HTTP error: {e}")

    # -- Metoda 2: Bezposredni HTTP GET na downloadUri --
    download_uri = attachment.get('downloadUri', '')
    if download_uri:
        try:
            if creds.expired:
                creds.refresh(Request())
            headers = {'Authorization': f'Bearer {creds.token}'}
            resp = requests.get(download_uri, headers=headers, allow_redirects=True, timeout=30)
            if resp.status_code == 200 and len(resp.content) > 100:
                with open(save_path, 'wb') as f:
                    f.write(resp.content)
                size_kb = len(resp.content) / 1024
                print(f"    [OK] Pobrano (downloadUri): {filename} ({size_kb:.1f} KB)")
                return True
            else:
                print(f"    [!!] downloadUri: HTTP {resp.status_code}, {len(resp.content)} bajtow")
        except Exception as e:
            print(f"    [!!] downloadUri error: {e}")

    # -- Metoda 3: attachment.get -> resourceName -> HTTP GET --
    att_name = attachment.get('name', '')
    if att_name:
        try:
            att_meta = service.spaces().messages().attachments().get(name=att_name).execute()
            ref2 = att_meta.get('attachmentDataRef', {})
            rn2 = ref2.get('resourceName', '')
            if rn2:
                content = _download_media_http(creds, rn2)
                with open(save_path, 'wb') as f:
                    f.write(content)
                size_kb = len(content) / 1024
                print(f"    [OK] Pobrano (att.get->media): {filename} ({size_kb:.1f} KB)")
                return True
        except Exception as e:
            print(f"    [!!] att.get->media error: {e}")

    print(f"    [!!] Nie udalo sie pobrac: {filename}")
    return False


def process_space(service, creds, space_name, space_display_name, download_all=False):
    """
    Główna logika: pobiera wiadomości z pokoju i zapisuje załączniki.
    
    Struktura folderów:
      pobrane_zdjecia/
        <nazwa_pokoju>/
          <tekst_wiadomości>_<data>/
            <plik1.jpg>
            <plik2.jpg>
    """
    print(f"\n{'='*60}")
    print(f"  Przetwarzanie pokoju: {space_display_name}")
    print(f"{'='*60}")

    # Pobierz wszystkie wiadomości
    messages = get_all_messages(service, space_name)
    print(f"\n  Łącznie wiadomości: {len(messages)}")

    # Filtruj wiadomości z załącznikami
    msgs_with_attachments = []
    for msg in messages:
        attachments = msg.get('attachment', msg.get('attachments', []))
        if attachments:
            # Filtruj tylko zdjęcia (chyba że download_all=True)
            if download_all:
                image_attachments = attachments
            else:
                image_attachments = [
                    a for a in attachments
                    if a.get('contentType', a.get('mimeType', '')) in IMAGE_MIME_TYPES
                ]
            if image_attachments:
                msgs_with_attachments.append((msg, image_attachments))

    total_attachments = sum(len(atts) for _, atts in msgs_with_attachments)
    print(f"  Wiadomości ze zdjęciami: {len(msgs_with_attachments)}")
    print(f"  Łączna liczba plików do pobrania: {total_attachments}")

    if total_attachments == 0:
        print("  Brak zdjęć do pobrania.")
        return

    # Przygotuj folder główny
    space_dir = os.path.join(DOWNLOAD_DIR, sanitize_filename(space_display_name))
    os.makedirs(space_dir, exist_ok=True)

    # Przygotuj listę zadań do pobrania
    download_tasks = []  # (att, save_path, content_name, label, manifest_path, manifest_base, manifest_file)
    skipped = 0

    for msg_idx, (msg, attachments) in enumerate(msgs_with_attachments):
        text = msg.get('text', '').strip()
        create_time = msg.get('createTime', '')[:10]  # YYYY-MM-DD

        if text:
            folder_label = sanitize_filename(text[:60])
        else:
            folder_label = 'brak_opisu'

        folder_name = f"{create_time}_{folder_label}"
        msg_dir = os.path.join(space_dir, folder_name)
        os.makedirs(msg_dir, exist_ok=True)
        manifest_path = os.path.join(msg_dir, 'manifest.json')
        manifest_base = {
            'source': 'google-chat',
            'spaceName': space_name,
            'spaceDisplayName': space_display_name,
            'messageName': msg.get('name', ''),
            'messageText': text,
            'createTime': msg.get('createTime', ''),
            'folderName': folder_name,
        }

        for att in attachments:
            content_name = att.get('contentName', 'unknown')
            safe_content_name = sanitize_filename(content_name)
            save_path = os.path.join(msg_dir, safe_content_name)
            manifest_file = {
                'fileName': safe_content_name,
                'contentName': content_name,
                'contentType': att.get('contentType', att.get('mimeType', '')),
            }

            if os.path.exists(save_path):
                upsert_message_manifest(manifest_path, manifest_base, manifest_file)
                skipped += 1
                continue

            label = f"{create_time} | {text[:40] or 'BRAK'}"
            download_tasks.append((
                att,
                save_path,
                content_name,
                label,
                manifest_path,
                manifest_base,
                manifest_file,
            ))

    print(f"\n  Pominieto (juz istnieja): {skipped}")
    print(f"  Do pobrania: {len(download_tasks)}")
    print(f"  Watki robocze: {WORKERS}")

    if not download_tasks:
        print("  Wszystko juz pobrane!")

    downloaded = 0
    failed = 0

    if download_tasks:
        lock = threading.Lock()
        t_start = time.time()

        def _do_download(task):
            att, save_path, content_name, label, manifest_path, manifest_base, manifest_file = task
            success = download_attachment(service, creds, att, save_path)
            if success:
                upsert_message_manifest(manifest_path, manifest_base, manifest_file)
            return success, content_name

        with ThreadPoolExecutor(max_workers=WORKERS) as pool:
            futures = {pool.submit(_do_download, t): t for t in download_tasks}
            for i, future in enumerate(as_completed(futures), 1):
                success, name = future.result()
                with lock:
                    if success:
                        downloaded += 1
                    else:
                        failed += 1
                    if i % 20 == 0 or i == len(download_tasks):
                        elapsed = time.time() - t_start
                        speed = i / elapsed if elapsed > 0 else 0
                        print(f"  ... postep: {i}/{len(download_tasks)} "
                              f"({elapsed:.0f}s, {speed:.1f} plik/s)")

    print(f"\n{'='*60}")
    print(f"  PODSUMOWANIE: {space_display_name}")
    print(f"{'='*60}")
    print(f"  Pobrano:    {downloaded}")
    print(f"  Pominięto:  {skipped} (już istniały)")
    print(f"  Błędów:     {failed}")
    print(f"  Zapisano w: {space_dir}")


def run_noninteractive(args):
    ensure_script_cwd()

    if args.list_spaces_json:
        with contextlib.redirect_stdout(sys.stderr):
            service, _creds = get_chat_service()
            spaces = fetch_spaces(service)
        print(json.dumps([space_to_json(space) for space in spaces], ensure_ascii=False))
        return True

    if args.space or args.all:
        service, creds = get_chat_service()
        if args.all:
            spaces = fetch_spaces(service)
            for sp in spaces:
                if sp.get('spaceType', sp.get('type', '')) == 'SPACE':
                    process_space(
                        service,
                        creds,
                        sp['name'],
                        sp.get('displayName', sp['name']),
                        download_all=args.download_all_types,
                    )
        else:
            process_space(
                service,
                creds,
                args.space,
                args.space_display_name or args.space,
                download_all=args.download_all_types,
            )
        print("\n[OK] Zakonczono.")
        return True

    return False


if __name__ == '__main__':
    parser = argparse.ArgumentParser(add_help=True)
    parser.add_argument('--list-spaces-json', action='store_true')
    parser.add_argument('--space')
    parser.add_argument('--space-display-name')
    parser.add_argument('--all', action='store_true')
    parser.add_argument('--download-all-types', action='store_true')
    cli_args = parser.parse_args()

    if run_noninteractive(cli_args):
        exit(0)

    ensure_script_cwd()
    print("=" * 60)
    print("  Google Chat – Pobieranie zdjęć z pokojów")
    print("=" * 60)

    service, creds = get_chat_service()

    # Lista pokojów
    spaces = list_spaces(service)
    if not spaces:
        print("\nBrak pokojów. Zakończono.")
        exit(1)

    # Wybór pokoju
    print("\n" + "-" * 60)
    print("Opcje:")
    print("  [numer]  – pobierz zdjęcia z jednego pokoju")
    print("  [all]    – pobierz zdjęcia ze WSZYSTKICH pokojów")
    print("  [A numer] – pobierz WSZYSTKIE pliki (nie tylko zdjęcia)")
    choice = input("\nWybór: ").strip()

    download_all_types = False
    if choice.upper().startswith('A '):
        download_all_types = True
        choice = choice[2:].strip()

    if choice.lower() == 'all':
        for sp in spaces:
            if sp.get('spaceType', sp.get('type', '')) == 'SPACE':
                process_space(
                    service, creds,
                    sp['name'],
                    sp.get('displayName', sp['name']),
                    download_all=download_all_types
                )
    else:
        # Wybór po numerze lub ID
        if choice.isdigit():
            idx = int(choice) - 1
            if 0 <= idx < len(spaces):
                sp = spaces[idx]
            else:
                print(f"Nieprawidłowy numer (1-{len(spaces)})")
                exit(1)
        elif choice.startswith('spaces/'):
            sp = {'name': choice, 'displayName': choice}
        else:
            sp = {'name': f'spaces/{choice}', 'displayName': choice}

        process_space(
            service, creds,
            sp['name'],
            sp.get('displayName', sp['name']),
            download_all=download_all_types
        )

    print("\n[OK] Zakonczono.")
