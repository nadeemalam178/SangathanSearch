#!/usr/bin/env python3
import csv
import re
import sys
import unicodedata
from pathlib import Path

csv_path = Path(__file__).with_name('data.csv')

DEVANAGARI_MAP = {
    'अ': 'a', 'आ': 'aa', 'इ': 'i', 'ई': 'ee', 'उ': 'u', 'ऊ': 'oo',
    'ए': 'e', 'ऐ': 'ai', 'ओ': 'o', 'औ': 'au',
    'क': 'k', 'ख': 'kh', 'ग': 'g', 'घ': 'gh', 'ङ': 'ng',
    'च': 'ch', 'छ': 'chh', 'ज': 'j', 'झ': 'jh', 'ञ': 'ny',
    'ट': 't', 'ठ': 'th', 'ड': 'd', 'ढ': 'dh', 'ण': 'n',
    'त': 't', 'थ': 'th', 'द': 'd', 'ध': 'dh', 'न': 'n',
    'प': 'p', 'फ': 'ph', 'ब': 'b', 'भ': 'bh', 'म': 'm',
    'य': 'y', 'र': 'r', 'ल': 'l', 'व': 'v', 'श': 'sh',
    'ष': 'sh', 'स': 's', 'ह': 'h', 'क्ष': 'ksh', 'त्र': 'tr', 'ज्ञ': 'gy',
    '़': '', 'ा': 'a', 'ि': 'i', 'ी': 'i', 'ु': 'u', 'ू': 'u',
    'े': 'e', 'ै': 'ai', 'ो': 'o', 'ौ': 'au', 'ं': 'n', 'ँ': 'n',
    'ः': 'h', '्': '', 'ृ': 'ri', '़': '', 'ं': 'n', 'ँ': 'n',
    'ड़': 'd', 'ढ़': 'dh', 'फ़': 'f', 'ज़': 'z'
}


def transliterate_to_english(value):
    if value is None:
        return ''
    text = str(value).strip()
    if not text:
        return ''

    result = []
    for ch in text:
        code = ord(ch)
        if 0x0900 <= code <= 0x097F:
            result.append(DEVANAGARI_MAP.get(ch, ''))
        else:
            result.append(ch)

    text = ''.join(result)
    text = unicodedata.normalize('NFKD', text)
    text = text.encode('ascii', 'ignore').decode('ascii')
    text = re.sub(r'\s+', ' ', text).strip()
    return text


def clean_value(key, value):
    if value is None:
        return ''
    text = str(value).strip()
    if not text:
        return ''

    text = text.replace('\u00a0', ' ')
    text = re.sub(r'\s+', ' ', text)

    if key in {'Name', "Father/Husband's Name", 'District', 'Block', 'Panchayat', 'Caste'}:
        text = transliterate_to_english(text)
    elif key == 'Contact No.':
        digits = re.sub(r'\D', '', text)
        text = digits
    else:
        text = text
    return text.strip()


try:
    print(f'Reading CSV: {csv_path}', file=sys.stderr)
    with csv_path.open('r', encoding='utf-8-sig', newline='') as f:
        reader = csv.DictReader(f)
        if not reader.fieldnames:
            raise ValueError('No header found in CSV.')
        fieldnames = [name.strip() for name in reader.fieldnames if name and name.strip()]
        rows = list(reader)

    original_count = len(rows)
    print(f'Original rows: {original_count}', file=sys.stderr)

    cleaned_rows = []
    seen = set()
    for i, row in enumerate(rows):
        clean_row = {}
        for key, value in row.items():
            if key is None or not str(key).strip():
                continue
            clean_row[str(key).strip()] = clean_value(str(key).strip(), value)

        ordered = {key: clean_row.get(key, '') for key in fieldnames}
        key_tuple = tuple((key, ordered.get(key, '')) for key in fieldnames)

        if key_tuple not in seen:
            seen.add(key_tuple)
            cleaned_rows.append(ordered)

        if (i + 1) % 1000 == 0:
            print(f'Processed {i + 1} rows...', file=sys.stderr)

    duplicate_count = original_count - len(cleaned_rows)

    print('Writing cleaned file...', file=sys.stderr)
    with csv_path.open('w', encoding='utf-8', newline='') as f:
        writer = csv.DictWriter(f, fieldnames=fieldnames)
        writer.writeheader()
        writer.writerows(cleaned_rows)

    print('\n✅ Cleaning Complete!', file=sys.stderr)
    print(f'Original rows: {original_count}', file=sys.stderr)
    print(f'Duplicate rows removed: {duplicate_count}', file=sys.stderr)
    print(f'Final rows: {len(cleaned_rows)}', file=sys.stderr)
    print(f'Saved to: {csv_path}', file=sys.stderr)

    sample_names = [row.get('Name', '') for row in cleaned_rows[:5] if row.get('Name')]
    if sample_names:
        print('Sample English names:', ', '.join(sample_names), file=sys.stderr)

except Exception as exc:
    print(f'❌ Error: {exc}', file=sys.stderr)
    sys.exit(1)
