"""Offline checks for proposal review and promotion."""
import builtins
from copy import deepcopy
from datetime import datetime, timezone
import json
from pathlib import Path
import sys
import tempfile
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parent))
import review_proposals as review
import update_external as updater
import build


def candidate(identifier='gamerpower:1', category='free-game'):
    game = category == 'free-game'
    return {
        'id': identifier, 'source_id': identifier.split(':', 1)[1],
        'source_name': 'GamerPower' if game else 'gamejam.gg',
        'source_url': 'https://www.gamerpower.com/item' if game else 'https://gamejam.gg/jam/item',
        'source_feed_url': updater.GAMES_URL if game else updater.JAMS_URL,
        'title': 'Candidate', 'category': category, 'description': 'External description.',
        'start_at': None if game else '2026-11-08T12:00:00+00:00',
        'end_at': '2026-11-10T12:00:00+00:00',
        'platforms': ['PC', 'Steam'] if game else [],
        'attribution': {'label': 'GamerPower' if game else 'gamejam.gg',
                        'url': 'https://www.gamerpower.com/' if game else 'https://gamejam.gg/',
                        'active_link_required': game},
        'fetched_at': '2026-11-06T12:00:00+00:00',
    }


def proposal(rows):
    return {'schema_version': 1, 'review_status': 'candidates_only', 'candidates': rows}


class Inputs:
    def __init__(self, *answers):
        self.answers = iter(answers)
        self.original = None

    def __enter__(self):
        self.original = builtins.input
        builtins.input = lambda _: next(self.answers)

    def __exit__(self, *_):
        builtins.input = self.original


class ReviewTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.root = Path(self.directory.name)
        self.home = self.root / 'home.json'
        self.proposals = self.root / 'weekly.json'
        self.home.write_text(Path('content/home.json').read_text())
        self.proposals.write_text(json.dumps(proposal([candidate(), candidate('gamejam:jam-1@gamejam.gg', 'game-jam')]), indent=2))

    def tearDown(self):
        self.directory.cleanup()

    def test_filter_and_lookup(self):
        data = review.load_json(self.proposals, updater.validate_proposal)
        self.assertEqual(len(review.filtered(data['candidates'], source='games', platform='steam')), 1)
        self.assertEqual(len(review.filtered(data['candidates'], category='game-jam')), 1)
        self.assertEqual(review.find(data['candidates'], 'gamerpower:1')['title'], 'Candidate')
        with self.assertRaises(ValueError):
            review.find(data['candidates'], 'missing')

    def test_promote_resource_and_preserve_attribution(self):
        data = review.load_json(self.proposals, updater.validate_proposal)
        data['candidates'][0]['end_at'] = '2026-11-10T12:00:00'
        review.write_json(self.proposals, data)
        with Inputs('free-game-one', 'Ücretsiz oyun', 'Free game', 'Türkçe editör metni', 'Approved editorial text', 'y'):
            self.assertTrue(review.promote(data['candidates'][0], self.proposals, self.home))
        home = review.load_json(self.home, review.validate_home)
        item = home['week']['resources'][-1]
        self.assertEqual(item['id'], 'free-game-one')
        self.assertEqual(item['external']['candidate_id'], 'gamerpower:1')
        self.assertTrue(item['external']['attribution']['active_link_required'])
        self.assertIn('https://www.gamerpower.com/', build.render(home, 'en'))
        state = review.load_json(self.proposals, updater.validate_proposal)['candidates'][0]['review']
        self.assertEqual(state, {'status': 'promoted', 'published_id': 'free-game-one'})

    def test_promote_jam_as_event(self):
        data = review.load_json(self.proposals, updater.validate_proposal)
        jam = review.find(data['candidates'], 'gamejam:jam-1@gamejam.gg')
        with Inputs('jam-one', 'Oyun maratonu', 'Game jam', 'Türkçe metin', 'Approved text', 'Online', 'y'):
            self.assertTrue(review.promote(jam, self.proposals, self.home))
        item = review.load_json(self.home, review.validate_home)['events']['items'][-1]
        self.assertEqual(item['id'], 'jam-one')
        self.assertEqual(item['date'], '2026-11-08T12:00:00+00:00')
        self.assertEqual(item['location'], 'Online')
        self.assertEqual(item['external']['candidate_id'], 'gamejam:jam-1@gamejam.gg')

    def test_duplicate_and_cancel_do_not_write(self):
        data = review.load_json(self.proposals, updater.validate_proposal)
        home_before, proposals_before = self.home.read_bytes(), self.proposals.read_bytes()
        with Inputs('godot-docs'):
            with self.assertRaisesRegex(ValueError, 'already exists'):
                review.promote(data['candidates'][0], self.proposals, self.home)
        self.assertEqual(self.home.read_bytes(), home_before)
        self.assertEqual(self.proposals.read_bytes(), proposals_before)
        with Inputs('new-id', 'TR', 'EN', 'TR text', 'EN text', 'n'):
            self.assertFalse(review.promote(data['candidates'][0], self.proposals, self.home))
        self.assertEqual(self.home.read_bytes(), home_before)
        self.assertEqual(self.proposals.read_bytes(), proposals_before)

    def test_dismissal_and_refresh_preserves_state(self):
        data = review.load_json(self.proposals, updater.validate_proposal)
        with Inputs('y'):
            self.assertTrue(review.dismiss(data['candidates'][0], self.proposals))
        dismissed = review.load_json(self.proposals, updater.validate_proposal)['candidates'][0]
        self.assertEqual(dismissed['review']['status'], 'dismissed')
        payload = [
            {'id': 1, 'type': 'Game', 'status': 'Active', 'title': 'Candidate',
             'platforms': 'PC, Steam', 'end_date': '2026-11-10 12:00:00',
             'description': 'External description.', 'gamerpower_url': 'https://www.gamerpower.com/item'}
        ]
        self.assertEqual(updater.update(source='games', output=self.proposals,
                         fetcher=lambda _: json.dumps(payload).encode(),
                         now=datetime(2026, 11, 6, 12, tzinfo=timezone.utc), report=lambda _: None), 0)
        refreshed = review.load_json(self.proposals, updater.validate_proposal)
        self.assertEqual(review.find(refreshed['candidates'], 'gamerpower:1')['review']['status'], 'dismissed')

    def test_malformed_proposal_cannot_promote(self):
        bad = proposal([candidate()])
        bad['candidates'][0]['attribution'] = {}
        self.proposals.write_text(json.dumps(bad))
        with self.assertRaises(ValueError):
            review.load_json(self.proposals, updater.validate_proposal)


if __name__ == '__main__':
    unittest.main()
