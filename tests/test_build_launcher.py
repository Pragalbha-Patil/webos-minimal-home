import json
import os
import sys
import unittest
from unittest.mock import patch

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), os.pardir))

import build_launcher as bl


def make_lp(lp_id, title, system=False, icon=None, params=None, lptype=None):
    return {"id": lp_id, "title": title, "systemApp": system,
            "hidden": False, "icon": icon or "", "largeIcon": "", "params": params,
            "lptype": lptype or ("default" if system else "app")}


SAMPLE = [
    make_lp("youtube.leanback.v4", "YouTube", icon="/a/y.png"),
    make_lp("netflix", "Netflix"),
    make_lp("com.webos.app.hdmi1", "HDMI 1", params={"PhysicalAddress": "1000"}),
    make_lp("com.webos.app.discovery", "Apps", system=True),
    make_lp("com.webos.app.settings", "Settings", system=True),
    make_lp("com.webos.app.livetv", "Live TV", system=True),
    make_lp("com.webos.app.homedepot", "Home Depot"),
]


class ClassifyTest(unittest.TestCase):
    def setUp(self):
        self.cfg = {
            "ui": {
                "system": ["com.webos.app.discovery", "com.webos.app.mediadiscovery",
                           "com.palm.app.settings"],
                "appsPriority": ["youtube.leanback.v4", "netflix"],
            }
        }

    def test_sections(self):
        apps, inputs, sysrow = bl.classify(SAMPLE, self.cfg)
        apps_ids = [t["id"] for t in apps]
        self.assertEqual(apps_ids, ["youtube.leanback.v4", "netflix", "com.webos.app.homedepot"])
        inputs_ids = [t["id"] for t in inputs]
        self.assertIn("com.webos.app.livetv", inputs_ids)
        self.assertIn("com.webos.app.hdmi1", inputs_ids)
        sys_ids = [t["id"] for t in sysrow]
        self.assertIn("com.webos.app.discovery", sys_ids)
        self.assertIn(bl.SETTINGS_ID, sys_ids)
        self.assertIn(bl.LG_HOME_ID, sys_ids)
        self.assertNotIn("com.webos.app.homedepot", [t["id"] for t in inputs] + sys_ids)

    def test_settings_pinned(self):
        apps, inputs, sysrow = bl.classify(SAMPLE, self.cfg)
        settings = next(t for t in sysrow if t["id"] == bl.SETTINGS_ID)
        self.assertEqual(settings["icon"], bl.SETTINGS_ICON)

    def test_hides_self(self):
        lp = SAMPLE + [make_lp("org.minimal.home", "Minimal Home")]
        apps, _, _ = bl.classify(lp, self.cfg)
        self.assertNotIn("org.minimal.home", [t["id"] for t in apps])

    def test_hidden_skipped(self):
        lp = [dict(t) for t in SAMPLE]
        lp[0]["hidden"] = True
        apps, _, _ = bl.classify(lp, self.cfg)
        self.assertNotIn("youtube.leanback.v4", [t["id"] for t in apps])

    def test_malformed_and_duplicate_launch_points_are_skipped(self):
        records = [None, [], {}, {"id": 5}, make_lp('../escape', 'Bad'),
                   make_lp('valid', None), make_lp('valid', 'Duplicate')]
        apps, inputs, _ = bl.classify(records, self.cfg)
        self.assertEqual([(t['id'], t['title']) for t in apps], [('valid', 'valid')])
        self.assertEqual(inputs, [])

    def test_empty_allowlist_hides_settings_and_other_system_apps(self):
        self.cfg['ui']['system'] = []
        apps, _, system = bl.classify(SAMPLE + [make_lp(bl.SETTINGS_ID, 'Settings')], self.cfg)
        self.assertEqual([t['id'] for t in system], [bl.LG_HOME_ID])
        self.assertNotIn(bl.SETTINGS_ID, [t['id'] for t in apps])

    def test_missing_settings_pinned(self):
        lp = [t for t in SAMPLE if t["id"] != "com.webos.app.settings"]
        _, _, sysrow = bl.classify(lp, self.cfg)
        self.assertIn(bl.SETTINGS_ID, [t["id"] for t in sysrow])

    def test_system_not_in_known_filtered(self):
        lp = SAMPLE + [make_lp("com.webos.app.othersys", "Other", system=True)]
        _, _, sysrow = bl.classify(lp, self.cfg)
        self.assertNotIn("com.webos.app.othersys", [t["id"] for t in sysrow])

    def test_inputs_from_system_not_config_list(self):
        # No hardcoded input allowlist: any port launch point the system
        # reports is an input -- a device plugged back in later appears
        # automatically (here hdmi2/PS5 bookmark is absent from cfg).
        lp = SAMPLE + [make_lp("com.webos.app.hdmi2", "PlayStation 5",
                               lptype="bookmark", params={"PhysicalAddress": "2000", "value": "4"})]
        apps, inputs, _ = bl.classify(lp, self.cfg)
        ids = [t["id"] for t in inputs]
        self.assertIn("com.webos.app.hdmi2", ids)
        self.assertIn("com.webos.app.livetv", ids)
        self.assertNotIn("com.webos.app.hdmi2", [t["id"] for t in apps])
        loaded = json.loads(json.dumps(lp))
        t = next(t for t in inputs if t["id"] == "com.webos.app.hdmi2")
        self.assertEqual(t["params"], loaded[-1]["params"])

    def test_input_params_kept(self):
        _, inputs, _ = bl.classify(SAMPLE, self.cfg)
        t = next(t for t in inputs if t["id"] == "com.webos.app.hdmi1")
        self.assertEqual(t["params"], {"PhysicalAddress": "1000"})

    def test_preview_params_are_sanitized_like_runtime_launches(self):
        lp = make_lp("custom.port", "Custom", lptype="bookmark",
                     params={"id": "wrong", "value": 4, "PhysicalAddress": "2000",
                             "__proto__": {"polluted": True}, "unknown": "x"})
        _, inputs, _ = bl.classify([lp], self.cfg)
        self.assertEqual(inputs[0]["params"], {"PhysicalAddress": "2000", "value": 4})


class SortTest(unittest.TestCase):
    def setUp(self):
        self.cfg = {"ui": {"appsPriority": ["netflix", "youtube.leanback.v4"]}}

    def test_priority_order(self):
        tiles = [{"id": "zebra", "title": "Z"}, {"id": "netflix", "title": "N"}]
        sorted_tiles = sorted(tiles, key=lambda t: bl.sort_key(t, {}, self.cfg["ui"]["appsPriority"]))
        self.assertEqual(sorted_tiles[0]["id"], "netflix")

    def test_used_wins_with_mru(self):
        tiles = [{"id": "netflix", "title": "N"}, {"id": "alpha", "title": "A"}]
        usage = {"alpha": 5, "netflix": 1}
        s = sorted(tiles, key=lambda t: bl.sort_key(t, usage, self.cfg["ui"]["appsPriority"]))
        self.assertEqual(s[0]["id"], "alpha")

    def test_unknown_alpha(self):
        tiles = [{"id": "b", "title": "B"}, {"id": "a", "title": "A"}]
        s = sorted(tiles, key=lambda t: bl.sort_key(t, {}, self.cfg["ui"]["appsPriority"]))
        self.assertEqual([t["id"] for t in s], ["a", "b"])


class TemplateTest(unittest.TestCase):
    def test_tile_attributes_and_labels_are_escaped(self):
        tile = {'id': 'app" onload="bad', 'title': '<img onerror="bad">',
                'icon': 'anything.png', 'params': {'value': '"<bad>'}}
        rendered = bl.tile_html(tile)
        self.assertNotIn(' onload="bad', rendered)
        self.assertNotIn('<img onerror=', rendered)
        self.assertIn('&lt;img onerror=&quot;bad&quot;&gt;', rendered)

    def test_embedded_config_cannot_close_its_script(self):
        cfg = bl.load_config()
        cfg['ui']['system'].append('</script><script>alert(1)</script>')
        with patch.object(bl, 'load_config', return_value=cfg):
            output, _, _ = bl.build()
        self.assertNotIn('</script><script>alert(1)', output['launcher-app/index.html'])
        self.assertIn('\\u003c/script>', output['launcher-app/index.html'])

    def test_default_build_does_not_read_sample_tiles(self):
        with patch.object(bl, 'load_tiles', side_effect=AssertionError('sample read')):
            out, counts, _ = bl.build()
        self.assertEqual(counts, (0, 0, 0))
        body = out['launcher-app/index.html'].split('<script>')[0]
        self.assertNotIn('data-id=', body)
        self.assertIn('Loading apps, inputs and system from TV', body)

    def test_all_placeholders_substituted(self):
        out, _, _ = bl.build()
        html = out["launcher-app/index.html"]
        self.assertNotIn("__MH_", html)
        self.assertNotIn("__WELCOME_", html)
        self.assertNotIn("__APPS__", html)
        self.assertNotIn("__INPUTS__", html)
        self.assertNotIn("__SYS__", html)

    def test_version_echo(self):
        out, _, _ = bl.build()
        html = out["launcher-app/index.html"]
        self.assertIn('"version": "v', html)
        self.assertIn('window.__MHBUILD = BUILD', html)

    def test_appinfo_version_matches(self):
        out, _, _ = bl.build()
        appinfo = json.loads(out["launcher-app/appinfo.json"])
        self.assertEqual(appinfo["version"], bl.load_config().get("version", "1.0.0"))

    def test_no_ghost_icons(self):
        out, _, _ = bl.build()
        self.assertNotIn('src="icons/settings.png"', out["launcher-app/index.html"])

    def test_settings_tile_uses_provisioned_icon(self):
        out, _, _ = bl.build(preview=True)
        self.assertIn("icons/com.palm.app.settings.png", out["launcher-app/index.html"])
        self.assertNotIn("/usr/palm/applications/com.palm.app.settings/icon.png",
                         out["launcher-app/index.html"])


    def test_baked_icons_are_app_relative_not_absolute(self):
        # file:// blocks absolute icon paths (issue #17): baked tiles must use
        # the same icons/<id>.png mechanism as the live getTiles response.
        out, _, _ = bl.build(preview=True)
        html = out["launcher-app/index.html"]
        self.assertIn('src="icons/youtube.leanback.v4.png"', html)
        self.assertNotIn("/media/cryptofs/apps/", html)
        self.assertNotIn("/usr/palm/applications/", html)
        self.assertNotIn("assets/icon", html)
        self.assertIn("onerror=", html)

    def test_baked_banner_is_generic_not_config(self):
        # Branding is per-TV: the committed index.html ships the generic
        # DEFAULTS banner ("Welcome Minimal Home"), never config.json's.
        out, _, _ = bl.build()
        html = out["launcher-app/index.html"]
        self.assertIn('id="headText">WELCOME</span>', html)
        self.assertIn('id="headBrand">Minimal Home</b>', html)
        start = html.index('<h1 id="headLine">')
        end = html.index('</h1>', start)
        self.assertNotIn("PSP", html[start:end])

    def test_service_config_generated_from_same_source(self):
        # The service cannot read the app-dir config (jailer ENOENT), so the
        # build stamps an identical runtime config into the service dir.
        out, _, _ = bl.build()
        self.assertIn("launcher-service/config.json", out)
        svc_cfg = json.loads(out["launcher-service/config.json"])
        with open(os.path.join(bl.BASE, "launcher-app", "config.json"), encoding="utf-8") as f:
            app_cfg = json.load(f)
        self.assertEqual(svc_cfg.get("header", {}).get("brand"), app_cfg.get("header", {}).get("brand"))
        self.assertEqual(svc_cfg["ui"]["system"], app_cfg["ui"]["system"])
        self.assertEqual(svc_cfg["ui"]["appsPriority"], app_cfg["ui"]["appsPriority"])
        self.assertEqual(svc_cfg.get("version"), app_cfg.get("version"))

    def test_manifest_preserves_application_owned_back_key(self):
        output, _, _ = bl.build()
        self.assertTrue(json.loads(output["launcher-app/appinfo.json"])["disableBackHistoryAPI"])


if __name__ == "__main__":
    unittest.main()
