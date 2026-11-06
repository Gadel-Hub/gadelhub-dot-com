#!/usr/bin/env python3
"""Browse, dismiss, and explicitly promote staged external candidates."""
import argparse
from copy import deepcopy
import json
from pathlib import Path
import sys

from build import ROOT, validate as validate_home
from new import ask, atomic_write
from update_external import validate_proposal

PROPOSALS = ROOT / 'content' / 'proposals' / 'weekly.json'
HOME = ROOT / 'content' / 'home.json'
SOURCE_ALIASES = {'games': 'GamerPower', 'jams': 'gamejam.gg'}


def review_status(candidate):
    return candidate.get('review', {}).get('status', 'pending')


def load_json(path, validator):
    data = json.loads(path.read_text(encoding='utf-8'))
    validator(data)
    return data


def filtered(candidates, source=None, category=None, platform=None, search=None,
             upcoming_days=None, state='pending'):
    selected = []
    source = SOURCE_ALIASES.get(source, source)
    needle = search.casefold() if search else None
    for item in candidates:
        if source and item['source_name'] != source:
            continue
        if category and item['category'] != category:
            continue
        if platform and platform.casefold() not in {value.casefold() for value in item['platforms']}:
            continue
        if state != 'all' and review_status(item) != state:
            continue
        if needle and needle not in ' '.join((item['title'], item['description'], ' '.join(item['platforms']))).casefold():
            continue
        if upcoming_days is not None:
            start = item.get('start_at')
            if not start:
                continue
            from datetime import datetime, timedelta, timezone
            moment = datetime.now(timezone.utc)
            if not (moment <= datetime.fromisoformat(start) <= moment + timedelta(days=upcoming_days)):
                continue
        selected.append(item)
    return selected


def find(candidates, identifier):
    matches = [item for item in candidates if item['id'] == identifier]
    if len(matches) != 1:
        raise ValueError(f'No candidate with ID {identifier}')
    return matches[0]


def show(candidate):
    print('EXTERNAL CANDIDATE — not approved website copy')
    print(f'ID: {candidate["id"]}')
    print(f'Review state: {review_status(candidate)}')
    print(f'Title: {candidate["title"]}')
    print(f'Source: {candidate["source_name"]} ({candidate["source_id"]})')
    print(f'Source URL: {candidate["source_url"]}')
    print(f'Category: {candidate["category"]}')
    if candidate['platforms']:
        print(f'Platforms: {", ".join(candidate["platforms"])}')
    if candidate['start_at'] or candidate['end_at']:
        print(f'Start: {candidate["start_at"] or "—"}')
        print(f'End / expiry: {candidate["end_at"] or "—"}')
    if candidate['description']:
        print(f'Description: {candidate["description"]}')
    attribution = candidate['attribution']
    print(f'Attribution: {attribution["label"]} — {attribution["url"]}')
    print('Active attribution link required: ' + ('yes' if attribution['active_link_required'] else 'no'))


def published_ids(home):
    return {item['id'] for item in [home['featured'], home['week'], home['events'], home['teams'],
                                    *home['projects'], *home['week']['resources'], *home['events']['items']]}


def external_metadata(candidate):
    return {
        'candidate_id': candidate['id'], 'source_name': candidate['source_name'],
        'source_id': candidate['source_id'], 'source_url': candidate['source_url'],
        'attribution': candidate['attribution'], 'platforms': candidate['platforms'],
        'end_at': candidate['end_at'],
    }


def draft(candidate, home):
    if review_status(candidate) != 'pending':
        raise ValueError(f'Candidate is already {review_status(candidate)}')
    destination = 'week.resources' if candidate['category'] == 'free-game' else 'events.items'
    identifier = ask('Published ID')
    if identifier in published_ids(home):
        raise ValueError(f'Published ID already exists: {identifier}')
    title = {'tr': ask('Approved title [TR]'), 'en': ask('Approved title [EN]')}
    description = {'tr': ask('Approved description [TR]'), 'en': ask('Approved description [EN]')}
    if destination == 'week.resources':
        return destination, {'id': identifier, 'url': candidate['source_url'], 'title': title,
                             'description': description, 'external': external_metadata(candidate)}
    return destination, {'id': identifier, 'date': candidate['start_at'],
                         'location': ask('Location'), 'title': title,
                         'description': description, 'external': external_metadata(candidate)}


def write_json(path, data):
    atomic_write(path, json.dumps(data, ensure_ascii=False, indent=2) + '\n')


def dismiss(candidate, proposals_path):
    if review_status(candidate) != 'pending':
        raise ValueError(f'Candidate is already {review_status(candidate)}')
    if input(f'Dismiss {candidate["id"]}? [y/N]: ').strip().lower() != 'y':
        print('Cancelled; no file changed.')
        return False
    proposal = load_json(proposals_path, validate_proposal)
    live = find(proposal['candidates'], candidate['id'])
    if review_status(live) != 'pending':
        raise ValueError('Candidate changed while reviewing')
    live['review'] = {'status': 'dismissed'}
    validate_proposal(proposal)
    write_json(proposals_path, proposal)
    print(f'Dismissed {candidate["id"]}.')
    return True


def promote(candidate, proposals_path, home_path):
    home = load_json(home_path, validate_home)
    destination, record = draft(candidate, home)
    candidate_home = deepcopy(home)
    target = candidate_home['week']['resources'] if destination == 'week.resources' else candidate_home['events']['items']
    target.append(record)
    validate_home(candidate_home)
    print(f'Publish {candidate["id"]} as {record["id"]} in {destination}.')
    if input('Write approved content and mark proposal promoted? [y/N]: ').strip().lower() != 'y':
        print('Cancelled; no file changed.')
        return False
    proposal = load_json(proposals_path, validate_proposal)
    live = find(proposal['candidates'], candidate['id'])
    fresh_home = load_json(home_path, validate_home)
    if review_status(live) != 'pending' or record['id'] in published_ids(fresh_home):
        raise ValueError('Content changed while reviewing')
    target = fresh_home['week']['resources'] if destination == 'week.resources' else fresh_home['events']['items']
    target.append(record)
    validate_home(fresh_home)
    live['review'] = {'status': 'promoted', 'published_id': record['id']}
    validate_proposal(proposal)
    write_json(home_path, fresh_home)
    write_json(proposals_path, proposal)
    print(f'Promoted {candidate["id"]} as {record["id"]}. Run python3 scripts/build.py.')
    return True


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--source', choices=('games', 'jams'))
    parser.add_argument('--type', dest='category', choices=('free-game', 'game-jam'))
    parser.add_argument('--platform')
    parser.add_argument('--search')
    parser.add_argument('--upcoming-days', type=int)
    parser.add_argument('--state', choices=('pending', 'dismissed', 'promoted', 'all'), default='pending')
    parser.add_argument('--id', help='show one candidate in detail')
    parser.add_argument('--promote', metavar='ID')
    parser.add_argument('--dismiss', metavar='ID')
    parser.add_argument('--proposals', type=Path, default=PROPOSALS)
    parser.add_argument('--home', type=Path, default=HOME)
    args = parser.parse_args()
    if sum(bool(value) for value in (args.id, args.promote, args.dismiss)) > 1:
        parser.error('Use only one of --id, --promote, or --dismiss')
    if args.upcoming_days is not None and args.upcoming_days < 0:
        parser.error('--upcoming-days must be nonnegative')
    try:
        proposal = load_json(args.proposals, validate_proposal)
        if args.id or args.promote or args.dismiss:
            candidate = find(proposal['candidates'], args.id or args.promote or args.dismiss)
            show(candidate)
            if args.dismiss:
                dismiss(candidate, args.proposals)
            elif args.promote:
                promote(candidate, args.proposals, args.home)
            return 0
        rows = filtered(proposal['candidates'], args.source, args.category, args.platform,
                        args.search, args.upcoming_days, args.state)
        print(f'{len(rows)} {args.state} external candidates')
        for item in rows:
            dates = item['start_at'] or item['end_at'] or 'no date'
            platforms = ', '.join(item['platforms']) or '—'
            print(f'{item["id"]} | {item["category"]} | {dates} | {platforms} | {item["title"]}')
    except (OSError, ValueError, json.JSONDecodeError) as error:
        print(f'Error: {error}; no file changed.', file=sys.stderr)
        return 1
    return 0


if __name__ == '__main__':
    sys.exit(main())
