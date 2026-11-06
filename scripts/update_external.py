#!/usr/bin/env python3
"""Fetch external candidates for human review; never publish to home.json."""
import argparse
from datetime import datetime, timedelta, timezone
import json
import os
from pathlib import Path
import re
import sys
import tempfile
from urllib.error import HTTPError, URLError
from urllib.parse import parse_qsl, urlencode, urlsplit, urlunsplit
from urllib.request import Request, urlopen

ROOT = Path(__file__).resolve().parents[1]
OUTPUT = ROOT / 'content' / 'proposals' / 'weekly.json'
GAMES_URL = 'https://www.gamerpower.com/api/giveaways?type=game'
JAMS_URL = 'https://gamejam.gg/calendar.ics'
SOURCES = {'games': 'GamerPower', 'jams': 'gamejam.gg'}
TRACKING = {'fbclid', 'gclid', 'mc_cid', 'mc_eid'}
JAM_LOOKAHEAD_DAYS = 7
JAM_ACTIVE_AGE_DAYS = 3


class SourceError(ValueError):
    """A source response cannot safely be used."""


def clean_url(value):
    if not isinstance(value, str):
        raise ValueError('URL missing')
    parts = urlsplit(value.strip())
    if parts.scheme != 'https' or not parts.netloc or any(c.isspace() for c in value):
        raise ValueError('Expected an absolute HTTPS URL')
    query = urlencode([(key, val) for key, val in parse_qsl(parts.query, keep_blank_values=True)
                       if not key.lower().startswith('utm_') and key.lower() not in TRACKING])
    return urlunsplit((parts.scheme, parts.netloc.lower(), parts.path, query, ''))


def iso(value):
    if not isinstance(value, str):
        raise ValueError('Invalid ISO date')
    parsed = datetime.fromisoformat(value)
    return parsed.isoformat(timespec='seconds')


def date_or_none(value):
    if value in (None, '', 'N/A'):
        return None
    if not isinstance(value, str):
        raise ValueError('Invalid date')
    return iso(value.replace(' ', 'T', 1))


def fetch(url):
    request = Request(url, headers={'User-Agent': 'GADELHub-ProposalUpdater/1.0 (human review only)',
                                    'Accept': 'application/json, text/calendar'})
    try:
        with urlopen(request, timeout=12) as response:
            if response.status not in (200, 201):
                raise SourceError(f'HTTP {response.status}')
            if response.status == 201 and url == GAMES_URL:
                return b'[]'
            body = response.read(5_000_001)
            if len(body) > 5_000_000:
                raise SourceError('Response exceeds 5 MB')
            return body
    except (HTTPError, URLError, TimeoutError, OSError) as error:
        raise SourceError(str(error)) from error


def normalize_games(payload, now):
    if not isinstance(payload, list):
        raise SourceError('GamerPower response is not a list')
    candidates = []
    malformed = 0
    active_games = 0
    for item in payload:
        try:
            if not isinstance(item, dict) or str(item.get('type', '')).lower() != 'game':
                continue
            if str(item.get('status', '')).lower() != 'active':
                continue
            active_games += 1
            platforms = [part.strip() for part in item['platforms'].split(',')]
            allowed = {'pc', 'steam', 'epic games store', 'gog', 'itch.io', 'drm-free'}
            if not any(part.lower() in allowed for part in platforms):
                continue
            end_at = date_or_none(item.get('end_date'))
            if end_at:
                end = datetime.fromisoformat(end_at)
                if end.replace(tzinfo=end.tzinfo or timezone.utc) <= now:
                    continue
            source_id = str(item['id'])
            if not source_id.isdigit():
                raise ValueError('Invalid source ID')
            title = item['title'].strip()
            if not title:
                raise ValueError('Missing title')
            url = clean_url(item['gamerpower_url'])
            if urlsplit(url).hostname not in ('gamerpower.com', 'www.gamerpower.com'):
                raise ValueError('Unexpected source host')
            description = item.get('description') or ''
            if not isinstance(description, str):
                raise ValueError('Invalid description')
            candidates.append({
                'id': f'gamerpower:{source_id}', 'source_id': source_id,
                'source_name': 'GamerPower', 'source_url': url,
                'source_feed_url': GAMES_URL, 'title': title, 'category': 'free-game',
                'description': ' '.join(description.split()), 'start_at': None,
                'end_at': end_at, 'platforms': platforms,
                'attribution': {'label': 'GamerPower', 'url': 'https://www.gamerpower.com/',
                                'active_link_required': True},
            })
        except (KeyError, TypeError, ValueError):
            malformed += 1
            continue
    if active_games and malformed and not candidates:
        # A format change must not erase a previously valid proposal.
        raise SourceError('No active game records could be normalized')
    return candidates


def unfold_ics(text):
    lines = []
    for line in text.replace('\r\n', '\n').replace('\r', '\n').split('\n'):
        if line.startswith((' ', '\t')) and lines:
            lines[-1] += line[1:]
        else:
            lines.append(line)
    return lines


def ics_date(value):
    if not value.endswith('Z'):
        raise ValueError('Expected UTC ICS date')
    return datetime.strptime(value, '%Y%m%dT%H%M%SZ').replace(tzinfo=timezone.utc)


def ics_text(value):
    return value.replace('\\n', ' ').replace('\\N', ' ').replace('\\,', ',').replace('\\;', ';').replace('\\\\', '\\').strip()


def normalize_jams(text, now):
    if not isinstance(text, str) or 'BEGIN:VCALENDAR' not in text or 'END:VCALENDAR' not in text:
        raise SourceError('Invalid gamejam.gg calendar')
    events = []
    current = None
    for line in unfold_ics(text):
        if line == 'BEGIN:VEVENT':
            current = {}
        elif line == 'END:VEVENT' and current is not None:
            events.append(current)
            current = None
        elif current is not None and ':' in line:
            key, value = line.split(':', 1)
            current[key.split(';', 1)[0]] = value
    candidates = []
    dated = 0
    eligible = 0
    malformed = 0
    for item in events:
        try:
            start, end = ics_date(item['DTSTART']), ics_date(item['DTEND'])
            dated += 1
            if end <= start:
                raise ValueError('Jam ends before it starts')
            if (end <= now or start > now + timedelta(days=JAM_LOOKAHEAD_DAYS)
                    or start < now - timedelta(days=JAM_ACTIVE_AGE_DAYS)):
                continue
            eligible += 1
            uid = item['UID'].strip()
            if not re.fullmatch(r'jam-[0-9]+@gamejam\.gg', uid):
                raise ValueError('Invalid UID')
            title = ics_text(item['SUMMARY'])
            if not title:
                raise ValueError('Missing title')
            url = clean_url(item['URL'])
            if urlsplit(url).hostname != 'gamejam.gg':
                raise ValueError('Unexpected source host')
            candidates.append({
                'id': f'gamejam:{uid}', 'source_id': uid,
                'source_name': 'gamejam.gg', 'source_url': url,
                'source_feed_url': JAMS_URL, 'title': title, 'category': 'game-jam',
                'description': '', 'start_at': start.isoformat(timespec='seconds'),
                'end_at': end.isoformat(timespec='seconds'), 'platforms': [],
                'attribution': {'label': 'gamejam.gg', 'url': 'https://gamejam.gg/',
                                'active_link_required': False},
            })
        except (KeyError, TypeError, ValueError):
            malformed += 1
            continue
    if events and (dated == 0 or (eligible and not candidates) or (malformed and not candidates)):
        raise SourceError('No calendar records could be normalized')
    return candidates


def validate_proposal(data):
    if not isinstance(data, dict) or data.get('schema_version') != 1 or data.get('review_status') != 'candidates_only':
        raise ValueError('Invalid proposal header')
    if not isinstance(data.get('candidates'), list):
        raise ValueError('Expected candidates list')
    seen = set()
    for item in data['candidates']:
        if not isinstance(item, dict):
            raise ValueError('Malformed candidate')
        source = item.get('source_name')
        if source not in SOURCES.values() or item.get('category') != ('free-game' if source == 'GamerPower' else 'game-jam'):
            raise ValueError('Unrecognized source or category')
        identifier = item.get('id')
        if not isinstance(identifier, str) or not identifier or identifier in seen:
            raise ValueError('Missing or duplicate candidate ID')
        seen.add(identifier)
        if not isinstance(item.get('source_id'), str) or not item['source_id']:
            raise ValueError('Missing source ID')
        if not isinstance(item.get('title'), str) or not item['title'].strip():
            raise ValueError('Missing title')
        for field in ('source_url', 'source_feed_url'):
            clean_url(item.get(field))
        for field in ('start_at', 'end_at'):
            if item.get(field) is not None:
                iso(item[field])
        if source == 'gamejam.gg' and (not item.get('start_at') or not item.get('end_at')):
            raise ValueError('Jam dates required')
        if item.get('start_at') and item.get('end_at'):
            start = datetime.fromisoformat(item['start_at'])
            end = datetime.fromisoformat(item['end_at'])
            if start.tzinfo is None or end.tzinfo is None or start >= end:
                raise ValueError('Invalid date range')
        if not isinstance(item.get('description'), str) or not isinstance(item.get('platforms'), list):
            raise ValueError('Invalid description or platforms')
        attribution = item.get('attribution')
        if not isinstance(attribution, dict) or not isinstance(attribution.get('label'), str):
            raise ValueError('Attribution required')
        clean_url(attribution.get('url'))
        if attribution.get('active_link_required') is not (source == 'GamerPower'):
            raise ValueError('Incorrect attribution requirement')
        iso(item.get('fetched_at'))
        review = item.get('review', {'status': 'pending'})
        if not isinstance(review, dict) or review.get('status') not in {'pending', 'dismissed', 'promoted'}:
            raise ValueError('Invalid review state')
        if review['status'] == 'promoted':
            published_id = review.get('published_id')
            if not isinstance(published_id, str) or not re.fullmatch(r'[a-z0-9]+(?:-[a-z0-9]+)*', published_id):
                raise ValueError('Promoted candidate requires published ID')


def write_atomic(path, text):
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = None
    try:
        with tempfile.NamedTemporaryFile('w', encoding='utf-8', dir=path.parent,
                                         prefix='.weekly-', suffix='.tmp', delete=False) as file:
            temporary = Path(file.name)
            file.write(text)
            file.flush()
            os.fsync(file.fileno())
        os.replace(temporary, path)
    finally:
        if temporary is not None:
            temporary.unlink(missing_ok=True)


def update(source='all', dry_run=False, output=OUTPUT, fetcher=fetch, now=None, report=print):
    now = now or datetime.now(timezone.utc)
    existing = None
    if output.exists():
        existing = json.loads(output.read_text(encoding='utf-8'))
        validate_proposal(existing)
    prior = {item['id']: item for item in existing['candidates']} if existing else {}
    selected = tuple(SOURCES) if source == 'all' else (source,)
    replacements = {}
    successes = 0
    for name in selected:
        try:
            raw = fetcher(GAMES_URL if name == 'games' else JAMS_URL)
            normalized = normalize_games(json.loads(raw), now) if name == 'games' else normalize_jams(raw.decode('utf-8-sig'), now)
            replacements[name] = normalized
            successes += 1
            report(f'{"Game giveaways" if name == "games" else "Upcoming jams"}: {len(normalized)} candidates')
        except (SourceError, ValueError, UnicodeError, json.JSONDecodeError) as error:
            report(f'{"Game giveaways" if name == "games" else "Upcoming jams"}: failed ({error}); previous candidates retained')
    if successes == 0:
        report('Proposal file: unchanged (no source succeeded)')
        return 1
    candidates = [item for item in prior.values() if ('games' if item['source_name'] == 'GamerPower' else 'jams') not in replacements]
    timestamp = now.isoformat(timespec='seconds')
    for records in replacements.values():
        for item in records:
            old = prior.get(item['id'])
            if old and 'review' in old:
                item['review'] = old['review']
            old_content = {key: value for key, value in old.items()
                           if key not in {'fetched_at', 'review'}} if old else None
            new_content = {key: value for key, value in item.items() if key != 'review'}
            item['fetched_at'] = old['fetched_at'] if old_content == new_content else timestamp
            candidates.append(item)
    # Dedupe repeated source records by stable ID. First occurrence wins.
    unique = {}
    for item in candidates:
        unique.setdefault(item['id'], item)
    candidates = sorted(unique.values(), key=lambda item: (item['category'], item['start_at'] or '', item['title'].casefold(), item['id']))
    proposal = {'schema_version': 1, 'review_status': 'candidates_only', 'candidates': candidates}
    validate_proposal(proposal)
    if existing and existing == proposal:
        report('Proposal file: unchanged')
        return 0
    if dry_run:
        report('Proposal file: would update (dry run; no files written)')
        return 0
    write_atomic(output, json.dumps(proposal, ensure_ascii=False, indent=2) + '\n')
    report(f'Proposal file: updated {output}')
    return 0


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--source', choices=('all', 'games', 'jams'), default='all')
    parser.add_argument('--dry-run', action='store_true')
    args = parser.parse_args()
    try:
        return update(source=args.source, dry_run=args.dry_run)
    except (OSError, ValueError, json.JSONDecodeError) as error:
        print(f'Proposal not changed: {error}', file=sys.stderr)
        return 1


if __name__ == '__main__':
    sys.exit(main())
