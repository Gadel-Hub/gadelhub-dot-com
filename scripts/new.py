#!/usr/bin/env python3
"""Interactively add or edit homepage content without hand-editing JSON."""
import argparse
from copy import deepcopy
import json
import os
from pathlib import Path
import re
import stat
import sys
import tempfile

from build import ROOT, validate

DEFAULT_CONTENT = ROOT / 'content' / 'home.json'


def ask(label, current=None):
    suffix = f' [{current}]' if current is not None else ''
    value = input(f'{label}{suffix}: ').strip()
    answer = value or current
    if not answer:
        raise ValueError(f'{label}: required')
    return answer


def translated(label, current=None):
    return {lang: ask(f'{label} [{lang.upper()}]', current[lang] if current else None)
            for lang in ('tr', 'en')}


def all_ids(data):
    records = [data['featured'], *data['projects'], data['week'],
               *data['week']['resources'], data['events'],
               *data['events']['items'], data['teams']]
    return {record['id'] for record in records}


def collect(kind, data, existing=None):
    if kind in ('featured', 'team'):
        key = 'featured' if kind == 'featured' else 'teams'
        record = deepcopy(data[key])
        if kind == 'featured':
            record['badge'] = translated('Badge', record['badge'])
            record['title'] = translated('Title', record['title'])
            record['description'] = translated('Description', record['description'])
            current = 'yes' if record['placeholder'] else 'no'
            answer = ask('Placeholder (yes/no)', current).lower()
            if answer not in ('yes', 'no'):
                raise ValueError('Placeholder: enter yes or no')
            record['placeholder'] = answer == 'yes'
        else:
            record['description'] = translated('Description', record['description'])
            record['url'] = ask('URL', record['url'])
            record['link_label'] = translated('Link label', record['link_label'])
        return key, record

    record = deepcopy(existing) if existing else {'id': ask('ID')}
    if existing is None and record['id'] in all_ids(data):
        raise ValueError(f"ID already exists: {record['id']}")
    if kind == 'project':
        record['symbol'] = ask('Symbol', record.get('symbol'))
        record['title'] = translated('Title', record.get('title'))
        record['description'] = translated('Description', record.get('description'))
        return 'projects', record
    if kind == 'event':
        record['date'] = ask('Date (ISO 8601 with timezone)', record.get('date'))
        record['location'] = ask('Location', record.get('location'))
        record['title'] = translated('Title', record.get('title'))
        record['description'] = translated('Description', record.get('description'))
        return 'events.items', record
    record['url'] = ask('URL (https://...)', record.get('url'))
    record['title'] = translated('Title', record.get('title'))
    record['description'] = translated('Description', record.get('description'))
    return 'week.resources', record


def json_location(text, path):
    """Return source offsets for an existing top-level object or nested list."""
    decoder = json.JSONDecoder()
    keys = path.split('.')
    start = 0
    end = len(text)
    for key in keys:
        match = re.search(r'"' + key + r'"\s*:', text[start:end])
        if not match:
            raise ValueError(f'Cannot locate {path} in JSON source')
        value_start = start + match.end()
        while text[value_start].isspace():
            value_start += 1
        _, length = decoder.raw_decode(text[value_start:])
        start, end = value_start, value_start + length
    return start, end


def item_location(text, destination, identifier):
    start, end = json_location(text, destination)
    decoder = json.JSONDecoder()
    position = start + 1
    while position < end - 1:
        while text[position].isspace() or text[position] == ',':
            position += 1
        if position >= end - 1:
            break
        item, length = decoder.raw_decode(text[position:])
        if item['id'] == identifier:
            return position, position + length
        position += length
    raise ValueError(f'Cannot locate {identifier} in {destination}')


def splice(text, destination, record, editing=False):
    if editing and destination not in ('featured', 'teams'):
        start, end = item_location(text, destination, record['id'])
        replacement = json.dumps(record, ensure_ascii=False, indent=2).replace('\n', '\n    ')
        return text[:start] + replacement + text[end:]
    start, end = json_location(text, destination)
    if destination in ('featured', 'teams'):
        replacement = json.dumps(record, ensure_ascii=False, indent=2).replace('\n', '\n  ')
    else:
        original = text[start:end]
        content = original[1:-1].rstrip()
        item = json.dumps(record, ensure_ascii=False, indent=2).replace('\n', '\n    ')
        replacement = '[' + content + (',' if content else '') + '\n    ' + item + '\n  ]'
    return text[:start] + replacement + text[end:]


def atomic_write(path, text):
    temporary = None
    try:
        with tempfile.NamedTemporaryFile('w', encoding='utf-8', dir=path.parent,
                                         prefix='.home-', suffix='.tmp', delete=False) as file:
            temporary = Path(file.name)
            file.write(text)
            file.flush()
            os.fsync(file.fileno())
        os.chmod(temporary, stat.S_IMODE(path.stat().st_mode))
        os.replace(temporary, path)
    finally:
        if temporary is not None:
            temporary.unlink(missing_ok=True)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('type', choices=('project', 'event', 'resource', 'featured', 'team'))
    parser.add_argument('--edit', metavar='ID', help='edit an existing project, event, or resource')
    parser.add_argument('--content', type=Path, default=DEFAULT_CONTENT,
                        help='JSON file to edit (default: content/home.json)')
    args = parser.parse_args()
    if args.edit and args.type in ('featured', 'team'):
        parser.error('--edit is only for project, event, or resource records')
    path = args.content
    try:
        original = path.read_text(encoding='utf-8')
        data = json.loads(original)
        validate(data)
        lists = {'project': data['projects'], 'event': data['events']['items'],
                 'resource': data['week']['resources']}
        existing = next((item for item in lists[args.type] if item['id'] == args.edit), None) if args.edit else None
        if args.edit and existing is None:
            raise ValueError(f'No {args.type} with ID {args.edit}')
        destination, record = collect(args.type, data, existing)
        candidate = deepcopy(data)
        if destination == 'featured' or destination == 'teams':
            candidate[destination] = record
        else:
            items = {'projects': candidate['projects'],
                     'events.items': candidate['events']['items'],
                     'week.resources': candidate['week']['resources']}[destination]
            if args.edit:
                items[next(index for index, item in enumerate(items) if item['id'] == args.edit)] = record
            else:
                items.append(record)
        validate(candidate)
        updated = splice(original, destination, record, editing=bool(args.edit))
        if json.loads(updated) != candidate:
            raise ValueError('JSON source could not be updated safely')
        if updated == original:
            print('No change made.')
            return
        print(f'{"Edit" if args.edit or args.type in ("featured", "team") else "Add"} {args.type}: {record["id"]}')
        if input('Save change? [y/N]: ').strip().lower() != 'y':
            print('Cancelled; no file changed.')
            return
        if path.read_text(encoding='utf-8') != original:
            raise ValueError('Content changed while editing; no file written')
        atomic_write(path, updated)
        print(f'Saved {record["id"]} to {path}. Run python3 scripts/build.py to regenerate pages.')
    except (KeyboardInterrupt, EOFError):
        print('\nCancelled; no file changed.', file=sys.stderr)
        return 1
    except (OSError, ValueError, json.JSONDecodeError) as error:
        print(f'Error: {error}; no file changed.', file=sys.stderr)
        return 1
    return 0


if __name__ == '__main__':
    sys.exit(main())
