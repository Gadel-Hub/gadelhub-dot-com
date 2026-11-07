"""Offline artifact checks; all builds use temporary output, never tracked HTML."""
from copy import deepcopy
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
                    'tr/projects/index.html', 'en/projects/index.html'}
        assets = {path.relative_to(self.root).as_posix()
                  for path in (self.root / 'assets').rglob('*') if path.is_file()}
        styles = {path.relative_to(self.root).as_posix()
                  for path in (self.root / 'styles').rglob('*.css')}
        self.assertEqual({path.as_posix() for path in self.snapshot()}, required | assets | styles)
        self.assertEqual((self.output / 'index.html').read_bytes(), (self.root / 'src/index.html').read_bytes())
        self.assertIn('url=tr/', files[Path('index.html')].decode())
        for lang in build.LANGS:
            for suffix in ('index.html', 'projects/index.html'):
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
            {name + '.css' for name in shared + ['home', 'projects']},
        )
        for lang in build.LANGS:
            for page, prefix, specific in (
                ('index.html', '../', 'home'),
                ('projects/index.html', '../../', 'projects'),
            ):
                with self.subTest(lang=lang, page=page):
                    html = files[Path(lang) / page].decode('utf-8')
                    links = re.findall(r'href="([^"\n]+\.css)"', html)
                    self.assertEqual(
                        links,
                        [f'{prefix}styles/{name}.css' for name in shared + [specific]],
                    )
        build.validate_site(files)

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
