"""Offline artifact checks; all builds use temporary output, never tracked HTML."""
from copy import deepcopy
from datetime import datetime, timezone
import json
import re
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parent))
import build


class BuildTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.root = Path(self.directory.name)
        for directory in ('src', 'content', 'assets', 'styles'):
            shutil.copytree(build.ROOT / directory, self.root / directory)
        (self.root / 'scripts').mkdir()
        shutil.copyfile(build.ROOT / 'scripts/build.py', self.root / 'scripts/build.py')
        self.patch = patch.object(build, 'ROOT', self.root)
        self.patch.start()
        self.data = json.loads((self.root / 'content/home.json').read_text(encoding='utf-8'))
        self.output = self.root / 'dist'

    def tearDown(self):
        self.patch.stop()
        self.directory.cleanup()

    def files(self):
        return build.site_files(self.data)

    def snapshot(self):
        return {path.relative_to(self.output): path.read_bytes()
                for path in self.output.rglob('*') if path.is_file()}

    def cli(self, *args):
        return subprocess.run([sys.executable, str(self.root / 'scripts/build.py'), *args],
                              cwd=self.directory.name, capture_output=True, text=True)

    def test_complete_standalone_artifact(self):
        files = self.files()
        build.validate_site(files)
        build.write_output(files, self.output)
        build.check_output(files, self.output)
        required = {'index.html', 'tr/index.html', 'en/index.html',
                    'tr/projects/index.html', 'en/projects/index.html',
                    'tr/events/index.html', 'en/events/index.html',
                    'tr/resources/index.html', 'en/resources/index.html',
                    'tr/teams/index.html', 'en/teams/index.html',
                    'tr/about/index.html', 'en/about/index.html',
                    'tr/join/index.html', 'en/join/index.html'}
        assets = {path.relative_to(self.root).as_posix()
                  for path in (self.root / 'assets').rglob('*') if path.is_file()}
        styles = {path.relative_to(self.root).as_posix()
                  for path in (self.root / 'styles').rglob('*.css')}
        self.assertEqual({path.as_posix() for path in self.snapshot()}, required | assets | styles)
        self.assertEqual((self.output / 'index.html').read_bytes(), (self.root / 'src/index.html').read_bytes())
        self.assertIn('url=tr/', files[Path('index.html')].decode())
        for lang in build.LANGS:
            for suffix in ('index.html', 'projects/index.html', 'events/index.html', 'resources/index.html',
                           'teams/index.html', 'about/index.html', 'join/index.html'):
                page = files[Path(lang) / suffix].decode()
                self.assertIn(f'<html lang="{lang}">', page)
                self.assertNotIn('{{', page)
        for name in assets | styles:
            self.assertEqual((self.root / name).read_bytes(), (self.output / name).read_bytes())

    def test_locale_pages_load_expected_stylesheets_in_order(self):
        files = self.files()
        shared = ['tokens', 'base', 'layout', 'components']
        self.assertEqual(
            {path.name for path in files if path.parent == Path('styles')},
            {name + '.css' for name in shared + ['home', 'projects', 'events', 'resources', 'community']},
        )
        for lang in build.LANGS:
            for page, prefix, specific in (
                ('index.html', '../', ['home']),
                ('projects/index.html', '../../', ['home', 'projects']),
                ('events/index.html', '../../', ['home', 'events']),
                ('resources/index.html', '../../', ['home', 'resources']),
                ('teams/index.html', '../../', ['home', 'community']),
                ('about/index.html', '../../', ['home', 'community']),
                ('join/index.html', '../../', ['home', 'community']),
            ):
                with self.subTest(lang=lang, page=page):
                    html = files[Path(lang) / page].decode('utf-8')
                    links = re.findall(r'href="([^"\n]+\.css)"', html)
                    self.assertEqual(
                        links,
                        [f'{prefix}styles/{name}.css' for name in shared + specific],
                    )
        build.validate_site(files)

    def test_projects_bind_verified_records_and_real_collaboration(self):
        files = self.files()
        project = next(p for p in self.data['projects'] if p['verified'])
        for lang in build.LANGS:
            page = files[Path(lang) / 'projects/index.html'].decode()
            self.assertIn(f'data-content-id="{project["id"]}"', page)
            self.assertIn(f'data-domain="{project["domain"]}" data-verified="true"', page)
            self.assertIn(build.h(project['title'][lang]), page)
            self.assertIn(build.h(project['description'][lang]), page)
            self.assertNotIn('data-content-id="game-development-area"', page)
            card = re.search(r'<article\b.*?</article>', page, re.S).group()
            self.assertNotIn('<a ', card)  # The real project has no supplied URL.
            self.assertIn(build.h(self.data['teams']['description'][lang]), page)
            self.assertIn(f'href="{self.data["teams"]["url"]}"', page)
            for domain in build.PROJECT_DOMAINS:
                self.assertIn(f'href="#{domain}"', page)
                self.assertIn(f'id="{domain}"', page)
            self.assertIn(f'aria-current="page" class="active" href="/{lang}/projects/"', page)
            for locale in build.LANGS:
                self.assertIn(f'href="/{locale}/projects/"', page)
            _, footer = build.project_site_chrome(lang)
            self.assertIn(footer, page)
        build.validate_site(files)

    def test_projects_review_gate_and_localized_content_updates(self):
        data = deepcopy(self.data)
        project = next(p for p in data['projects'] if p['verified'])
        project['title'] = {'tr': 'Güncel <başlık>', 'en': 'Updated <title>'}
        project['description'] = {'tr': 'Güncel & açıklama', 'en': 'Updated & description'}
        build.validate(data)
        for lang in build.LANGS:
            page = build.render_projects(data, lang)
            self.assertIn(build.h(project['title'][lang]), page)
            self.assertIn(build.h(project['description'][lang]), page)
            self.assertNotIn(self.data['projects'][1]['title'][lang], page)
            self.assertNotIn(project['title'][lang], page)  # HTML is escaped.
        project['verified'] = False
        build.validate(data)
        for lang in build.LANGS:
            page = build.render_projects(data, lang)
            self.assertNotIn('<article ', page)
            self.assertNotIn('data-verified="true"', page)
            self.assertEqual(page.count('class="game-empty"'), 2)

    def test_archived_projects_are_hidden_without_changing_verification(self):
        data = deepcopy(self.data)
        record = next(p for p in data['projects'] if p['verified'])
        record['archived'] = True
        build.validate(data)
        for lang in build.LANGS:
            home = build.render(data, lang)
            projects = build.render_projects(data, lang)
            self.assertNotIn(record['title'][lang], home)
            self.assertNotIn(record['title'][lang], projects)
            self.assertNotIn(f'data-content-id="{record["id"]}"', home + projects)
        self.assertTrue(record['verified'])
        record['archived'] = False
        self.assertIn(record['title']['en'], build.render_projects(data, 'en'))
        record['archived'] = 'true'
        with self.assertRaisesRegex(ValueError, 'archived'):
            build.validate(data)

    def test_event_archive_and_past_semantics_preserve_empty_state_and_attribution(self):
        data = deepcopy(self.data)
        events = [
            {'id': 'past-event', 'date': '2020-01-01T16:00:00+03:00',
             'location': 'GTÜ', 'title': {'tr': 'Geçmiş etkinlik', 'en': 'Past event'},
             'description': {'tr': 'TR', 'en': 'EN'}},
            {'id': 'future-event', 'date': '2099-01-01T16:00:00+03:00',
             'location': 'Online', 'title': {'tr': 'Gelecek etkinlik', 'en': 'Future event'},
             'description': {'tr': 'TR', 'en': 'EN'},
             'external': {'candidate_id': 'test:jam', 'source_name': 'Source', 'source_id': 'jam',
                          'source_url': 'https://example.org/jam',
                          'attribution': {'label': 'Source', 'url': 'https://example.org/',
                                          'active_link_required': True}}},
        ]
        data['events']['items'] = events
        build.validate(data)
        page = build.render(data, 'en')
        self.assertIn('Past event', page)
        self.assertIn('Future event', page)
        self.assertIn('<a href="https://example.org/">Source</a>', page)
        self.assertLess(page.index('past-event'), page.index('future-event'))
        for event in events:
            event['archived'] = True
        for lang in build.LANGS:
            self.assertEqual(build.home_events(data['events'], lang),
                             build.home_events(self.data['events'], lang))
        events[0]['archived'] = False
        self.assertIn('Past event', build.render(data, 'en'))
        events[0]['archived'] = 'true'
        with self.assertRaisesRegex(ValueError, 'archived'):
            build.validate(data)

    def test_events_empty_state_semantics_chrome_and_real_destination(self):
        files = self.files()
        for lang, title in [('tr', 'ETKİNLİKLER'), ('en', 'EVENTS')]:
            page = files[Path(lang) / 'events/index.html'].decode()
            headings = re.findall(r'<h1\b[^>]*>(.*?)</h1>', page, re.S)
            self.assertEqual(len(headings), 1)
            self.assertIn(title, headings[0])
            self.assertIn('aria-hidden="true" class="page-display"', page)
            self.assertNotIn('<article ', page)
            self.assertNotIn('class="community-strip', page)
            self.assertIn(build.h(self.data['events']['notice'][lang]), page)
            self.assertIn(build.h(self.data['events']['description'][lang]), page)
            self.assertIn(f'href="{self.data["teams"]["url"]}"', page)
            self.assertIn(f'aria-current="page" class="active" href="/{lang}/events/"', page)
            self.assertIn('assets/js/events.js', page)
            for locale in build.LANGS:
                self.assertIn(f'href="/{locale}/events/"', page)
            self.assertIn(f'href="/{lang}/events/"', files[Path(lang) / 'index.html'].decode())
            self.assertIn(f'href="/{lang}/events/"', files[Path(lang) / 'projects/index.html'].decode())
        build.validate_site(files)

    def test_events_cards_filter_calendar_provenance_and_archive(self):
        data = deepcopy(self.data)
        def event(identifier, date, **extra):
            return {'id': identifier, 'date': date, 'location': 'GTÜ & Online',
                    'title': {'tr': 'Etkinlik <başlığı>', 'en': 'Event <title>'},
                    'description': {'tr': 'Açıklama & metin', 'en': 'Description & text'}, **extra}
        data['events']['items'] = [
            event('past-event', '2026-11-01T12:00:00+03:00'),
            event('future-event', '2026-11-15T16:00:00+03:00', external={
                'candidate_id': 'source:jam', 'source_name': 'Source', 'source_id': 'jam',
                'source_url': 'https://example.org/jam',
                'attribution': {'label': 'Required credit', 'url': 'https://example.org/',
                                'active_link_required': True}}),
            event('hidden-event', '2026-11-25T12:00:00+03:00', archived=True),
        ]
        build.validate(data)
        now = datetime(2026, 11, 9, 12, tzinfo=timezone.utc)
        before = deepcopy(data)
        for lang in build.LANGS:
            page = build.render_events(data, lang, now)
            self.assertEqual(page.count('<article '), 2)
            self.assertNotIn('hidden-event', page)
            self.assertNotIn('data-calendar-date="2026-11-25"', page)
            self.assertIn('data-calendar-date="2026-11-15"', page)
            self.assertIn('<a href="https://example.org/">Required credit</a>', page)
            self.assertIn('href="https://example.org/jam"', page)
            self.assertIn(build.h(data['events']['items'][0]['title'][lang]), page)
            self.assertIn('GTÜ &amp; Online', page)
            self.assertIn('datetime="2026-11-15T16:00:00+03:00"', page)
            self.assertLess(page.index('data-event-group="upcoming"'), page.index('data-content-id="future-event"'))
            self.assertLess(page.index('data-event-group="past"'), page.index('data-content-id="past-event"'))
            self.assertIn('class="has-event"', page)
            self.assertNotIn('source:jam', page)  # Internal provenance is not a public tag.
        self.assertEqual(data, before)
        # Calendar's current day follows Istanbul, not a builder/visitor's local zone.
        page = build.render_events(data, 'en', datetime(2026, 11, 30, 22, tzinfo=timezone.utc))
        self.assertIn('DECEMBER 2026', page)
        self.assertIn('aria-current="date">1</span>', page)

    def test_resources_content_chrome_semantics_and_destinations(self):
        files = self.files()
        for lang, title in [('tr', 'KAYNAKLAR'), ('en', 'RESOURCES')]:
            page = files[Path(lang) / 'resources/index.html'].decode()
            headings = re.findall(r'<h1\b[^>]*>(.*?)</h1>', page, re.S)
            self.assertEqual([heading.strip() for heading in headings], [title])
            self.assertEqual(page.count('<article '), 2)
            self.assertIn(f'aria-current="page" class="active" href="/{lang}/resources/"', page)
            for locale in build.LANGS:
                self.assertIn(f'href="/{locale}/resources/"', page)
            for record in self.data['week']['resources']:
                self.assertIn(f'href="#{record["id"]}"', page)
                self.assertIn(f'id="{record["id"]}" data-content-id="{record["id"]}"', page)
                self.assertIn(build.h(record['title'][lang]), page)
                self.assertIn(build.h(record['description'][lang]), page)
                self.assertIn(f'href="{record["url"]}"', page)
            project = next(item for item in self.data['projects'] if item['verified'])
            self.assertIn(f'<aside class="related" data-content-id="{project["id"]}"', page)
            self.assertIn(build.h(project['title'][lang]), page)
            self.assertIn(build.h(project['description'][lang]), page)
            self.assertIn(f'href="/{lang}/projects/#electronics-embedded"', page)
            self.assertIn(f'href="{self.data["teams"]["url"]}"', page)
            for suffix in ('index.html', 'projects/index.html', 'events/index.html'):
                self.assertIn(f'href="/{lang}/resources/"', files[Path(lang) / suffix].decode())
        build.validate_site(files)

    def test_resources_routes_are_direct_canonical_and_have_no_legacy_alias(self):
        files = self.files()
        for lang, label in [('tr', 'KAYNAKLAR'), ('en', 'RESOURCES')]:
            target = f'/{lang}/resources/'
            for suffix in ('index.html', 'projects/index.html', 'events/index.html', 'resources/index.html',
                           'teams/index.html', 'about/index.html', 'join/index.html'):
                page = files[Path(lang) / suffix].decode()
                navigation = re.search(r'<nav\b[^>]*>(.*?)</nav>', page, re.S).group(1)
                link = re.search(r'<a\b[^>]*href="([^"]+)"[^>]*>\s*' + label + r'\s*</a>', navigation)
                self.assertIsNotNone(link, (lang, suffix))
                self.assertEqual(link.group(1), target, (lang, suffix))
            page = files[Path(lang) / 'resources/index.html'].decode()
            self.assertIn(f'rel="canonical" href="https://gadelhub.com{target}"', page)
            self.assertNotIn('http-equiv="refresh"', page)
            self.assertNotIn('<script', page)
        # No compatibility alias exists: only the canonical directories build.
        for path, body in files.items():
            self.assertNotIn('kaynaklar', path.parts)
            if path.suffix == '.html':
                for link in build.PageLinks(body.decode()).links:
                    self.assertNotRegex(link, r'(?:^|/)kaynaklar(?:/|[?#]|$)')
        build.validate_site(files)

    def test_resources_bind_edited_translations_urls_and_required_attribution(self):
        data = deepcopy(self.data)
        record = data['week']['resources'][0]
        record['title'] = {'tr': 'Düzenlenmiş <belge>', 'en': 'Edited <document>'}
        record['description'] = {'tr': 'Kaynak & açıklama', 'en': 'Resource & description'}
        record['url'] = 'https://example.org/reference?q=one&lang=all'
        record['external'] = {
            'candidate_id': 'qa:resource', 'source_name': 'QA source', 'source_id': 'resource',
            'source_url': 'https://example.org/reference',
            'attribution': {'label': 'Required credit', 'url': 'https://example.org/',
                            'active_link_required': True},
        }
        project = next(item for item in data['projects'] if item['verified'])
        project['title'] = {'tr': 'Yeni <proje>', 'en': 'Updated <project>'}
        data['teams']['url'] = 'https://example.org/community'
        build.validate(data)
        before = deepcopy(data)
        for lang in build.LANGS:
            page = build.render_resources(data, lang)
            self.assertEqual(page.count(build.h(record['title'][lang])), 2)
            self.assertIn(build.h(record['description'][lang]), page)
            self.assertIn(f'href="{build.h(record["url"])}"', page)
            self.assertIn('<a href="https://example.org/">Required credit</a>', page)
            self.assertIn(build.h(project['title'][lang]), page)
            self.assertIn('href="https://example.org/community"', page)
            self.assertNotIn('qa:resource', page)  # Internal provenance stays private.
        self.assertEqual(data, before)

    def test_resources_missing_selection_has_no_dangling_anchor_and_projects_stay_private(self):
        data = deepcopy(self.data)
        data['week']['resources'] = []
        project = next(item for item in data['projects'] if item['verified'])
        for flag in ('archived', 'verified'):
            project['archived'] = flag == 'archived'
            project['verified'] = flag != 'verified'
            for lang in build.LANGS:
                page = build.render_resources(data, lang)
                self.assertNotIn('<article ', page)
                self.assertNotIn('href="#godot-docs"', page)
                self.assertNotIn('href="#kicad-docs"', page)
                self.assertNotIn('class="related"', page)
                self.assertNotIn(build.h(project['title'][lang]), page)
            build.validate_site(build.site_files(data))

    def test_homepage_headline_language_and_local_font_license(self):
        files = self.files()
        semantic = {
            'tr': ('OYUN GELİŞTİR.', 'DONANIM ÜRET.', 'BİRLİKTE YAP.'),
            'en': ('BUILD GAMES.', 'BUILD HARDWARE.', 'BUILD THINGS.'),
        }
        decorative = {
            'tr': ('OYUN GELISTIR.', 'DONANIM URET.', 'BIRLIKTE YAP.'),
            'en': semantic['en'],
        }
        for lang in build.LANGS:
            page = files[Path(lang) / 'index.html'].decode()
            headings = re.findall(r'<h1\b[^>]*>(.*?)</h1>', page, re.S)
            self.assertEqual(len(headings), 1)
            for line in semantic[lang]:
                self.assertIn(line, headings[0])
            visible = re.search(
                r'<div aria-hidden="true" class="hero-display">(.*?)</div>',
                page, re.S,
            )
            self.assertIsNotNone(visible)
            for line in decorative[lang]:
                self.assertIn(line, visible.group(1))
            self.assertNotRegex(visible.group(1), '[ÇĞİÖŞÜ]')
        css = files[Path('styles/home.css')].decode()
        self.assertIn('../assets/fonts/upheavtt.ttf', css)
        self.assertNotRegex(css, r'url\([\'\"]?https?://')
        self.assertIn(Path('assets/fonts/upheaval-readme.txt'), files)
        self.assertIn(b'All I ask is that you keep this text file',
                      files[Path('assets/fonts/upheaval-readme.txt')])

    def test_homepage_binds_published_content_and_required_attribution(self):
        data = deepcopy(self.data)
        data['featured']['placeholder'] = False
        data['featured']['title'] = {'tr': 'Onaylı <çalışma>', 'en': 'Approved <work>'}
        data['week']['resources'][0]['external'] = {
            'candidate_id': 'test:resource', 'source_name': 'Test source', 'source_id': 'resource',
            'source_url': 'https://example.org/resource',
            'attribution': {
                'label': 'Source attribution', 'url': 'https://example.org/',
                'active_link_required': True,
            },
        }
        data['events']['items'] = [{
            'id': 'published-workshop', 'date': '2026-11-21T16:00:00+03:00',
            'location': 'GTÜ', 'title': {'tr': 'Onaylı atölye', 'en': 'Approved workshop'},
            'description': {'tr': 'Atölye açıklaması', 'en': 'Workshop description'},
        }]
        build.validate(data)
        files = build.site_files(data)
        build.validate_site(files)

        for lang, featured_title, event_title in (
            ('tr', 'Onaylı &lt;çalışma&gt;', 'Onaylı atölye'),
            ('en', 'Approved &lt;work&gt;', 'Approved workshop'),
        ):
            page = files[Path(lang) / 'index.html'].decode()
            self.assertIn(featured_title, page)
            self.assertIn(event_title, page)
            self.assertIn('data-content-id="published-workshop"', page)
            self.assertIn('<time datetime="2026-11-21T16:00:00+03:00">', page)
            self.assertIn('<a href="https://example.org/">Source attribution</a>', page)
            self.assertNotIn('class="events-empty"', page)

    def test_all_public_navigation_and_language_switches_are_canonical(self):
        files = self.files()
        routes = ('', 'projects', 'events', 'resources', 'teams', 'about', 'join')
        for lang in build.LANGS:
            for route in routes:
                with self.subTest(lang=lang, route=route):
                    page = files[Path(lang) / route / 'index.html'].decode()
                    header = re.search(r'<header\b.*?</header>', page, re.S).group()
                    nav = re.search(r'<nav\b.*?</nav>', header, re.S).group()
                    expected = [f'/{lang}/{target}/' if target else f'/{lang}/'
                                for target in routes]
                    self.assertEqual(re.findall(r'href="([^"]+)"', nav), expected)
                    self.assertNotIn('#', header)
                    current = re.findall(r'<a\b[^>]*aria-current="page"[^>]*>', nav)
                    self.assertEqual(len(current), 1)
                    self.assertIn(f'href="{expected[routes.index(route)]}"', current[0])
                    for locale in build.LANGS:
                        target = f'/{locale}/{route}/' if route else f'/{locale}/'
                        self.assertIn(f'href="{target}" hreflang="{locale}" lang="{locale}"', header)
                    self.assertIn(f'class="join" href="/{lang}/join/"', header)
                    self.assertEqual(len(re.findall(r'<h1\b', page)), 1)
        for lang in build.LANGS:
            home = files[Path(lang) / 'index.html'].decode()
            self.assertIn(f'class="hero-button" href="/{lang}/join/"', home)
            self.assertIn('class="hero-button primary" href="#projects"', home)
        build.validate_site(files)

    def test_community_pages_preserve_copy_boundaries_and_destination_binding(self):
        data = deepcopy(self.data)
        data['teams']['url'] = 'https://example.org/community?one=1&two=2'
        for lang in build.LANGS:
            for route in ('teams', 'about', 'join'):
                page = build.render_community(data, lang, route)
                self.assertNotIn('/qa/', page)
                self.assertNotIn('noindex', page)
                self.assertNotIn(' — prototype', page)
                self.assertNotRegex(page, r'class="[^"]*-prototype')
                self.assertNotIn('{{', page)
                self.assertIn(f'rel="canonical"', page)
                self.assertIn(f'https://gadelhub.com/{lang}/{route}/', page)
                self.assertIn('aria-hidden="true" class="page-display"', page)
                if route != 'about':
                    self.assertIn('href="https://example.org/community?one=1&amp;two=2"', page)
            about = build.render_community(data, lang, 'about')
            for route in ('projects', 'events', 'resources', 'join'):
                self.assertIn(f'href="/{lang}/{route}/"', about)
            join = build.render_community(data, lang, 'join')
            self.assertLess(join.index('class="channel community-panel"'),
                            join.index('class="participation-paths community-panel"'))

    def test_teams_related_project_is_localized_escaped_and_review_gated(self):
        data = deepcopy(self.data)
        project = next(p for p in data['projects'] if p['id'] == 'stm32-beginner-resources')
        project['title'] = {'tr': 'Yeni <başlık>', 'en': 'New <title>'}
        project['description'] = {'tr': 'A & B', 'en': 'C & D'}
        for lang in build.LANGS:
            page = build.render_community(data, lang, 'teams')
            self.assertIn(build.h(project['title'][lang]), page)
            self.assertIn(build.h(project['description'][lang]), page)
            self.assertIn(f'data-content-id="{project["id"]}"', page)
            self.assertIn(f'href="/{lang}/projects/#electronics-embedded"', page)
        for field, value in (('verified', False), ('archived', True), ('domain', 'game-development')):
            private = deepcopy(data)
            private['projects'][1][field] = value
            for lang in build.LANGS:
                page = build.render_community(private, lang, 'teams')
                self.assertNotIn(build.h(project['title'][lang]), page)
                self.assertNotIn('class="related community-panel"', page)
        data['projects'] = []
        self.assertNotIn('class="related community-panel"', build.render_community(data, 'tr', 'teams'))

    def test_rebuild_cleans_stale_files_and_restores_deleted_output(self):
        build.write_output(self.files(), self.output)
        first = self.snapshot()
        (self.output / 'old-page').mkdir()
        (self.output / 'old-page/index.html').write_text('stale')
        build.write_output(self.files(), self.output)
        self.assertEqual(self.snapshot(), first)
        shutil.rmtree(self.output)
        build.write_output(self.files(), self.output)
        self.assertEqual(self.snapshot(), first)

    def test_check_detects_missing_extra_and_changed_files_without_writing(self):
        files = self.files()
        with self.assertRaisesRegex(ValueError, 'missing or invalid build'):
            build.check_output(files, self.output)
        for change in ('missing', 'extra', 'stale'):
            with self.subTest(change=change):
                build.write_output(files, self.output)
                if change == 'missing':
                    (self.output / 'en/projects/index.html').unlink()
                elif change == 'extra':
                    (self.output / 'obsolete.txt').write_text('old')
                else:
                    (self.output / 'assets/illustrations/chip.svg').write_text('changed')
                before = self.snapshot()
                with self.assertRaisesRegex(ValueError, change):
                    build.check_output(files, self.output)
                self.assertEqual(self.snapshot(), before)

    def test_check_detects_source_changes(self):
        build.write_output(self.files(), self.output)
        for source in ('styles/components.css', 'src/en/index.html', 'assets/illustrations/chip.svg'):
            with self.subTest(source=source):
                path = self.root / source
                original = path.read_bytes()
                path.write_bytes(original + b'\n')
                with self.assertRaisesRegex(ValueError, 'stale'):
                    build.check_output(self.files(), self.output)
                path.write_bytes(original)
        changed = deepcopy(self.data)
        changed['featured']['title']['tr'] += ' updated'
        with self.assertRaisesRegex(ValueError, 'stale'):
            build.check_output(build.site_files(changed), self.output)

    def test_local_link_asset_and_fragment_validation(self):
        for link in ('/missing/', '../../outside.html', '#missing-fragment', '/en/#missing-fragment'):
            with self.subTest(link=link):
                files = self.files()
                files[Path('tr/index.html')] += f'<a href="{link}">Link</a>'.encode()
                with self.assertRaisesRegex(ValueError, 'missing local|escapes deployment'):
                    build.validate_site(files)
        files = self.files()
        files[Path('styles/home.css')] += b"\na { background: url('../assets/missing.svg'); }"
        with self.assertRaisesRegex(ValueError, 'missing local target'):
            build.validate_site(files)

    def test_cli_validation_check_and_invalid_source_preserves_build(self):
        self.assertEqual(self.cli('--validate').returncode, 0)
        self.assertFalse(self.output.exists())
        self.assertNotEqual(self.cli('--check').returncode, 0)
        self.assertFalse(self.output.exists())
        self.assertEqual(self.cli().returncode, 0)
        self.assertEqual(self.cli('--check').returncode, 0)
        first = self.snapshot()
        (self.root / 'content/home.json').write_text('{}')
        self.assertNotEqual(self.cli().returncode, 0)
        self.assertEqual(self.snapshot(), first)

    def test_symlink_output_is_rejected_without_touching_target(self):
        target = self.root / 'keep'
        target.mkdir()
        marker = target / 'source.txt'
        marker.write_text('keep')
        self.output.symlink_to(target, target_is_directory=True)
        with self.assertRaisesRegex(ValueError, 'symlink'):
            build.write_output(self.files(), self.output)
        self.assertEqual(marker.read_text(), 'keep')


if __name__ == '__main__':
    unittest.main()
