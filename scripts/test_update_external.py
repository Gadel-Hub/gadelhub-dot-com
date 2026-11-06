"""Focused offline checks for the proposal-only updater (stdlib unittest)."""
import json
from pathlib import Path
import sys
import tempfile
import unittest
from datetime import datetime, timezone

sys.path.insert(0, str(Path(__file__).resolve().parent))
import update_external as updater

NOW = datetime(2026, 11, 6, 12, tzinfo=timezone.utc)


def game(identifier=1, **changes):
    item = {'id': identifier, 'type': 'Game', 'status': 'Active',
            'title': f'Game {identifier}', 'platforms': 'PC, Steam',
            'end_date': '2026-11-08 12:00:00',
            'description': 'A full game.',
            'gamerpower_url': f'https://www.gamerpower.com/game-{identifier}?utm_source=test'}
    item.update(changes)
    return item


def calendar(*events):
    return ('BEGIN:VCALENDAR\r\n' + ''.join(events) + 'END:VCALENDAR\r\n').encode()


def jam(uid='jam-1@gamejam.gg', title='Jam One', start='20261108T120000Z', end='20261110T120000Z'):
    return (f'BEGIN:VEVENT\r\nUID:{uid}\r\nDTSTART:{start}\r\nDTEND:{end}\r\n'
            f'SUMMARY:{title}\r\nURL:https://gamejam.gg/jam/one?utm_source=test\r\nEND:VEVENT\r\n')


class UpdaterTests(unittest.TestCase):
    def test_game_filters_and_attribution(self):
        rows = [game(), game(2, type='Loot'), game(3, platforms='Android, iOS'),
                game(4, status='Expired'), game(5, end_date='2026-11-01 00:00:00'),
                game(6, title=''), game(7, platforms='PC, DRM-Free')]
        result = updater.normalize_games(rows, NOW)
        self.assertEqual([item['source_id'] for item in result], ['1', '7'])
        self.assertEqual(result[0]['source_url'], 'https://www.gamerpower.com/game-1')
        self.assertTrue(result[0]['attribution']['active_link_required'])
        self.assertEqual(updater.normalize_games([], NOW), [])
        with self.assertRaises(updater.SourceError):
            updater.normalize_games({'bad': 'shape'}, NOW)

    def test_jam_filters_and_calendar_parsing(self):
        feed = calendar(jam(), jam('jam-2@gamejam.gg', 'Past', '20261101T120000Z', '20261102T120000Z'),
                        jam('jam-3@gamejam.gg', 'Far future', '20261201T120000Z', '20261203T120000Z'),
                        jam('jam-4@gamejam.gg', 'Line\\, folded\r\n continuation'))
        result = updater.normalize_jams(feed.decode(), NOW)
        self.assertEqual([item['source_id'] for item in result], ['jam-1@gamejam.gg', 'jam-4@gamejam.gg'])
        self.assertEqual(result[1]['title'], 'Line, foldedcontinuation')
        self.assertEqual(result[0]['source_url'], 'https://gamejam.gg/jam/one')
        with self.assertRaises(updater.SourceError):
            updater.normalize_jams('not a calendar', NOW)
        with self.assertRaises(updater.SourceError):
            updater.normalize_jams(calendar(jam(uid='bad')).decode(), NOW)

    def test_dry_run_unchanged_dedupe_and_failure(self):
        with tempfile.TemporaryDirectory() as directory:
            output = Path(directory) / 'weekly.json'
            home = Path('content/home.json').read_bytes()
            games = json.dumps([game(), game(1, title='Duplicate')]).encode()
            jams = calendar(jam())
            def fetch(url):
                return games if url == updater.GAMES_URL else jams
            lines = []
            self.assertEqual(updater.update(dry_run=True, output=output, fetcher=fetch, now=NOW, report=lines.append), 0)
            self.assertFalse(output.exists())
            self.assertEqual(updater.update(output=output, fetcher=fetch, now=NOW, report=lines.append), 0)
            first = output.read_bytes()
            proposal = json.loads(first)
            self.assertEqual(len(proposal['candidates']), 2)
            self.assertEqual(next(x for x in proposal['candidates'] if x['source_name'] == 'GamerPower')['title'], 'Game 1')
            updater.validate_proposal(proposal)
            later = datetime(2026, 11, 7, 12, tzinfo=timezone.utc)
            self.assertEqual(updater.update(output=output, fetcher=fetch, now=later, report=lines.append), 0)
            self.assertEqual(output.read_bytes(), first)
            def games_fail(url):
                if url == updater.GAMES_URL:
                    raise updater.SourceError('offline')
                return jams
            self.assertEqual(updater.update(output=output, fetcher=games_fail, now=later, report=lines.append), 0)
            self.assertEqual(output.read_bytes(), first)
            self.assertEqual(updater.update(source='games', output=output, fetcher=games_fail, now=later, report=lines.append), 1)
            self.assertEqual(output.read_bytes(), first)
            self.assertEqual(Path('content/home.json').read_bytes(), home)

    def test_proposal_validation(self):
        with self.assertRaises(ValueError):
            updater.validate_proposal({'schema_version': 1, 'review_status': 'candidates_only', 'candidates': [{'id': 'x'}]})
        with self.assertRaises(ValueError):
            updater.clean_url('http://example.org/')
        with tempfile.TemporaryDirectory() as directory:
            output = Path(directory) / 'weekly.json'
            updater.update(source='games', output=output,
                           fetcher=lambda _: json.dumps([game()]).encode(), now=NOW, report=lambda _: None)
            proposal = json.loads(output.read_text())
            proposal['candidates'].append(proposal['candidates'][0].copy())
            with self.assertRaisesRegex(ValueError, 'duplicate candidate ID'):
                updater.validate_proposal(proposal)
            proposal['candidates'].pop()
            proposal['candidates'][0]['end_at'] = 'not-a-date'
            with self.assertRaises(ValueError):
                updater.validate_proposal(proposal)


if __name__ == '__main__':
    unittest.main()
