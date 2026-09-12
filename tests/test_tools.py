"""Host tooling regressions: deterministic builds, packages, and installer failures."""

import copy
import gzip
import hashlib
import io
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tarfile
import tempfile
import unittest
from unittest.mock import patch

import build_launcher as bl
from tools import check, make_ipk, merge_config, package

ROOT = Path(__file__).resolve().parents[1]
SHELL = check.find_shell()


class ConfigValidationTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.config = self.root / "config.json"
        self.patcher = patch.object(bl, "APP_DIR", str(self.root))
        self.patcher.start()
        self.addCleanup(self.patcher.stop)

    def write_config(self, value):
        self.config.write_text(json.dumps(value), encoding="utf-8")

    def test_partial_config_inherits_defaults_without_mutating_them(self):
        defaults = copy.deepcopy(bl.DEFAULTS)
        self.write_config({"ui": {"system": []}, "header": {"text": "Hello"}})
        config = bl.load_config()
        self.assertEqual(config["ui"]["system"], [])
        self.assertEqual(config["ui"]["appsPriority"], defaults["ui"]["appsPriority"])
        self.assertEqual(config["header"]["brand"], defaults["header"]["brand"])
        config["ui"]["appsPriority"].clear()
        self.assertEqual(bl.DEFAULTS, defaults)

    def test_invalid_config_fails_instead_of_using_defaults(self):
        for value in ([], {"version": "../bad"}, {"header": []},
                      {"header": {"text": None}}, {"ui": {"system": "all"}},
                      {"ui": {"appsPriority": [1]}}):
            with self.subTest(value=value):
                self.write_config(value)
                with self.assertRaises(ValueError):
                    bl.load_config()
        self.config.write_text("{broken", encoding="utf-8")
        with self.assertRaises(ValueError):
            bl.load_config()

    def test_missing_config_returns_independent_defaults(self):
        config = bl.load_config()
        config["ui"]["system"].clear()
        self.assertTrue(bl.DEFAULTS["ui"]["system"])


class BuildInputsTest(unittest.TestCase):
    def test_personal_state_is_only_loaded_explicitly(self):
        with tempfile.TemporaryDirectory() as temp:
            path = Path(temp) / "usage.json"
            path.write_text('{"netflix": 42}', encoding="utf-8")
            with patch.object(bl, "SVC_DIR", temp):
                self.assertEqual(bl.load_usage(), {})
                self.assertEqual(bl.load_usage(path), {"netflix": 42})
                with self.assertRaisesRegex(ValueError, "--usage requires --preview"):
                    bl.build(usage_path=path)
                output, _, usage = bl.build(usage_path=path, preview=True)
                self.assertEqual(usage, {"netflix": 42})
                page = output["launcher-app/index.html"]
                self.assertLess(page.index('data-id="netflix"'), page.index('data-id="youtube.leanback.v4"'))

    def test_invalid_or_missing_explicit_usage_is_an_error(self):
        with tempfile.TemporaryDirectory() as temp:
            path = Path(temp) / "usage.json"
            with self.assertRaises(FileNotFoundError):
                bl.load_usage(path)
            for value in ([], {"netflix": True}, {"netflix": -1}, {"netflix": "2"}):
                with self.subTest(value=value):
                    path.write_text(json.dumps(value), encoding="utf-8")
                    with self.assertRaises(ValueError):
                        bl.load_usage(path)

    def test_version_override_stamps_all_outputs(self):
        output, _, _ = bl.build("2.3.4")
        self.assertEqual(json.loads(output["launcher-app/appinfo.json"])["version"], "2.3.4")
        self.assertEqual(json.loads(output["launcher-service/config.json"])["version"], "2.3.4")
        self.assertIn('"version": "v2.3.4"', output["launcher-app/index.html"])
        with self.assertRaises(ValueError):
            bl.build('1.0.0";bad')


class PackagingTest(unittest.TestCase):
    def test_reproducible_archive_allowlist_and_checksum(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp) / "source"
            for name in package.RELEASE_FILES:
                path = root / name
                path.parent.mkdir(parents=True, exist_ok=True)
                path.write_bytes(("fixture: " + name).encode())
            (root / "launcher-service/prefs.json").write_text('{"private":true}', encoding="utf-8")
            first, second = Path(temp) / "first.tar.gz", Path(temp) / "second.tar.gz"
            package.package(first, root)
            for name in package.RELEASE_FILES:
                os.utime(root / name, (100000, 100000))
            package.package(second, root)
            self.assertEqual(first.read_bytes(), second.read_bytes())
            with tarfile.open(first) as archive:
                self.assertEqual(set(archive.getnames()), set(package.RELEASE_FILES))
                for entry in archive:
                    self.assertEqual(entry.mtime, 0)
                    expected_mode = 0o755 if entry.name == "tools/install.sh" else 0o644
                    self.assertEqual(entry.mode, expected_mode)
                    self.assertEqual(archive.extractfile(entry).read(), (root / entry.name).read_bytes())
            checksum = first.with_name(first.name + ".sha256").read_text().split()[0]
            self.assertEqual(checksum, hashlib.sha256(first.read_bytes()).hexdigest())
            staged = Path(temp) / "staged"
            package.stage(staged, root)
            actual = {p.relative_to(staged).as_posix() for p in staged.rglob("*") if p.is_file()}
            self.assertEqual(actual, set(package.RUNTIME_FILES))

    def test_ipk_contains_only_staged_app_service_and_package_metadata(self):
        with tempfile.TemporaryDirectory() as temp:
            staged = Path(temp) / "staged"
            package.stage(staged)
            first = Path(temp) / "first.ipk"
            second = Path(temp) / "second.ipk"
            make_ipk.build(staged, first)
            make_ipk.build(staged, second)
            self.assertEqual(first.read_bytes(), second.read_bytes())

            payload = first.read_bytes()
            self.assertTrue(payload.startswith(b"!<arch>\n"))
            members = {}
            offset = 8
            while offset < len(payload):
                header = payload[offset:offset + 60]
                size = int(header[48:58])
                name = header[:16].decode("ascii").strip().rstrip("/")
                start = offset + 60
                members[name] = payload[start:start + size]
                offset = start + size + (size % 2)
            self.assertEqual(set(members), {"debian-binary", "control.tar.gz", "data.tar.gz"})
            with tarfile.open(fileobj=io.BytesIO(gzip.decompress(members["data.tar.gz"]))) as archive:
                names = set(archive.getnames())
                self.assertIn("usr/palm/applications/org.minimal.home/appinfo.json", names)
                self.assertIn("usr/palm/services/org.minimal.home.service/service.js", names)
                self.assertIn("usr/palm/packages/org.minimal.home/packageinfo.json", names)
                self.assertNotIn("usr/palm/applications/org.minimal.home/src/launcher.js", names)
                self.assertNotIn("usr/palm/applications/org.minimal.home/tiles.json", names)

    def test_mismatched_tag_fails_before_build_or_packaging(self):
        with patch.object(package.subprocess, "run") as run:
            with self.assertRaises(SystemExit) as error:
                package.main(["--tag", "v999.0.0"])
            self.assertEqual(error.exception.code, 1)
            run.assert_not_called()

    def test_stale_build_prevents_packaging(self):
        with tempfile.TemporaryDirectory() as temp:
            destination = Path(temp) / "dist"
            with patch.object(package.subprocess, "run", side_effect=subprocess.CalledProcessError(1, "build")):
                with self.assertRaises(SystemExit):
                    package.main(["--output-dir", str(destination)])
            self.assertFalse(destination.exists())


class MergeConfigTest(unittest.TestCase):
    def test_custom_values_survive_and_new_schema_and_version_win(self):
        new = {
            "version": "2.0.0",
            "header": {"text": "Welcome", "brand": "Minimal Home", "style": "new"},
            "ui": {"system": ["settings"], "appsPriority": [], "newOption": True},
        }
        installed = {
            "version": "1.4.1",
            "header": {"text": "Hello", "brand": "Living Room"},
            "ui": {"system": [], "appsPriority": ["custom.app"]},
            "futureCustom": {"enabled": True},
        }
        self.assertEqual(
            merge_config.merge_configs(new, installed),
            {
                "version": "2.0.0",
                "header": {"text": "Hello", "brand": "Living Room", "style": "new"},
                "ui": {"system": [], "appsPriority": ["custom.app"], "newOption": True},
                "futureCustom": {"enabled": True},
            },
        )

    def test_invalid_installed_known_fields_are_rejected(self):
        for installed in ([], {"header": []}, {"header": {"text": False}},
                          {"ui": []}, {"ui": {"system": [False]}}):
            with self.subTest(installed=installed), self.assertRaises(ValueError):
                merge_config.merge_configs({"version": "2.0.0"}, installed)


@unittest.skipUnless(SHELL, "POSIX sh is required for installer regression tests")
class InstallerTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.bin = self.root / "bin"
        self.bin.mkdir()
        self.log = self.root / "calls.log"
        self.env = dict(os.environ, TV_HOST="example-tv", TV_USER="root",
                        PYTHON=Path(sys.executable).as_posix(), MH_CALL_LOG=self.log.as_posix(),
                        MH_TEST_BIN=self.bin.as_posix(),
                        MH_RESPONSE='{"returnValue":true}', MH_INSTALL_RESPONSE='{"state":"installed"}',
                        MH_SSH_EXIT="0", MH_SCP_EXIT="0",
                        MH_CONFIG_PRESENT="1",
                        MH_INSTALLED_CONFIG='{"version":"1.0.0","header":{"text":"Hello TV"},'
                        '"ui":{"system":[],"appsPriority":["custom.app"]}}')
        self.env.pop("APP_ID", None)
        self.env.pop("SVC_ID", None)
        # Windows runners may use 'Path': duplicate case variants can cause the
        # child process to select the real SSH binary instead of our stubs.
        inherited_path = os.environ.get("PATH", "")
        for key in list(self.env):
            if key.upper() == "PATH":
                del self.env[key]
        self.env["PATH"] = os.pathsep.join((str(self.bin), str(Path(SHELL).parent), inherited_path))
        self.stub("ssh", 'printf "ssh\\n" >> "$MH_CALL_LOG"\nprintf "%s\\n" "$@" >> "$MH_CALL_LOG"\n'
                  'if [ "$MH_SSH_EXIT" != 0 ]; then exit "$MH_SSH_EXIT"; fi\n'
                  'case "$*" in\n'
                  '  *appInstallService*) printf "%s\\n" "$MH_INSTALL_RESPONSE"; '
                  'case "$MH_INSTALL_RESPONSE" in *failed*) exit 1;; esac;;\n'
                  '  *luna-send*) printf "%s\\n" "$MH_RESPONSE";;\n'
                  '  *"if test -f"*)\n'
                  '    if [ "$MH_CONFIG_PRESENT" = 1 ]; then\n'
                  '      printf "MINIMAL_HOME_CONFIG_PRESENT\\n%s" "$MH_INSTALLED_CONFIG"\n'
                  '    fi;;\n'
                  'esac\n')
        self.stub("scp", 'printf "scp\\n" >> "$MH_CALL_LOG"\nprintf "%s\\n" "$@" >> "$MH_CALL_LOG"\n'
                  'exit "$MH_SCP_EXIT"\n')

    def stub(self, name, body):
        path = self.bin / name
        path.write_text("#!/bin/sh\nset -eu\n" + body, encoding="utf-8", newline="\n")
        path.chmod(0o755)

    def install_script(self, script, *args):
        # Run outside the checkout to catch accidental reliance on cwd.
        # Git for Windows' bin/sh.exe wrapper can prepend its own binaries on
        # startup. Set PATH inside that shell and verify both stubs before any
        # installer code runs, so tests can never fall through to real SSH/SCP.
        bootstrap = (
            'stub_bin=$(cd "$MH_TEST_BIN" && pwd) || exit 98\n'
            'PATH="$stub_bin:$PATH"\nexport PATH\n'
            'for tool in ssh scp; do\n'
            '  if [ "$(command -v "$tool")" != "$stub_bin/$tool" ]; then\n'
            '    echo "test stub not selected: $tool" >&2; exit 99\n'
            '  fi\ndone\n'
            '. "$0"\n'
        )
        return subprocess.run([SHELL, "-c", bootstrap, script.as_posix(), *args],
                              cwd=self.root, env=self.env, capture_output=True,
                              text=True, encoding="utf-8", timeout=30)

    def install(self, *args):
        return self.install_script(ROOT / "tools/install.sh", *args)

    def test_help_and_unknown_arguments_do_not_contact_tv(self):
        self.env.pop("TV_HOST")
        self.assertEqual(self.install("--help").returncode, 0)
        self.assertNotEqual(self.install("--typo").returncode, 0)
        self.assertFalse(self.log.exists())

    def test_invalid_destinations_and_id_overrides_are_rejected(self):
        for host in ("-oProxyCommand=bad", "tv;echo bad", "user@tv", ""):
            with self.subTest(host=host):
                self.env["TV_HOST"] = host
                self.assertNotEqual(self.install("--check").returncode, 0)
        self.env["TV_HOST"] = "example-tv"
        self.env["APP_ID"] = "other.app"
        self.assertNotEqual(self.install("--check").returncode, 0)
        self.assertFalse(self.log.exists())

    def test_check_only_uses_read_only_ssh(self):
        result = self.install("--check")
        self.assertEqual(result.returncode, 0, result.stderr)
        calls = self.log.read_text()
        self.assertIn("test -x", calls)
        self.assertIn("elevate-service", calls)
        self.assertNotIn("scp", calls)
        self.assertNotIn("mkdir", calls)

    def test_positional_host_is_accepted_and_overrides_env(self):
        self.env.pop("TV_HOST")
        result = self.install("example-tv", "--check")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("example-tv", result.stdout)
        self.env["TV_HOST"] = "other-tv"
        result = self.install("example-tv", "--check")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("example-tv", result.stdout)

    def test_second_positional_host_is_rejected(self):
        result = self.install("one-tv", "two-tv", "--check")
        self.assertNotEqual(result.returncode, 0)

    def test_missing_host_fails_fast_without_prompt(self):
        self.env.pop("TV_HOST")
        result = self.install("--no-build")
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("TV_HOST", result.stderr)
        self.assertFalse(self.log.exists())

    def test_deploy_runs_preflight_check_before_upload(self):
        result = self.install("--no-build")
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        calls = self.log.read_text()
        self.assertLess(calls.find("test -x"), calls.find("\nscp\n"))

    def test_upload_sends_valid_launch_json(self):
        result = self.install("--no-build")
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        command = next(
            line for line in self.log.read_text().splitlines()
            if "applicationManager/launch" in line
        )
        payload = command.rsplit("'", 2)[1]
        self.assertEqual(json.loads(payload), {"id": "org.minimal.home"})
        self.assertIn("xargs -0 env", command)
        self.assertIn("/proc/$watcher/environ", command)
        calls = self.log.read_text()
        self.assertIn("chmod 0777", calls)
        self.assertIn("-w 600000", calls)
        self.assertIn("appInstallService/dev/install", calls)
        self.assertIn("elevate-service' org.minimal.home.service", calls)
        self.assertIn("applicationManager/close", calls)
        self.assertIn('$2 == "org.minimal.home.service"', calls)
        self.assertIn("/var/lib/webosbrew/init.d/50-minimal-home", calls)
        self.assertIn("com.palm.app.settings.png", calls)
        self.assertIn('count + 1', calls)
        self.assertIn("org.minimal.home-install-state", calls)
        self.assertIn("|| cmp -s", calls)
        self.assertLess(calls.find("cp -p"), calls.find("appInstallService/dev/install"))
        self.assertGreater(calls.rfind("cp -p"), calls.find("appInstallService/dev/install"))
        self.assertLess(calls.find("chmod 0777"), calls.rfind("cp -p"))
        self.assertLess(calls.rfind("\nscp\n"), calls.find("appInstallService/dev/install"))
        self.assertLess(calls.find("applicationManager/close"), calls.find("appInstallService/dev/install"))
        self.assertLess(calls.find("elevate-service' org.minimal.home.service"),
                        calls.find('$2 == "org.minimal.home.service"'))
        self.assertLess(calls.find('$2 == "org.minimal.home.service"'),
                        calls.find("applicationManager/launch"))
        self.assertEqual(calls.splitlines().count("scp"), 1)
        self.assertIn("Preserved installed Minimal Home configuration.", result.stdout)

    def test_bundled_release_installer_preserves_config(self):
        release = self.root / "release"
        for name in package.RELEASE_FILES:
            target = release / name
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(ROOT / name, target)
        result = self.install_script(release / "tools/install.sh")
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertIn("Preserved installed Minimal Home configuration.", result.stdout)
        self.assertEqual(self.log.read_text().splitlines().count("scp"), 1)

    def test_missing_config_is_a_first_install(self):
        self.env["MH_CONFIG_PRESENT"] = "0"
        result = self.install("--no-build")
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertNotIn("Preserved", result.stdout)

    def test_invalid_installed_config_stops_before_upload(self):
        self.env["MH_INSTALLED_CONFIG"] = '{"header":{"text":false}}'
        result = self.install("--no-build")
        self.assertNotEqual(result.returncode, 0)
        calls = self.log.read_text()
        self.assertNotIn("scp", calls)
        self.assertNotIn("mkdir", calls)

    def test_empty_installed_config_stops_before_upload(self):
        self.env["MH_INSTALLED_CONFIG"] = ""
        result = self.install("--no-build")
        self.assertNotEqual(result.returncode, 0)
        self.assertNotIn("scp", self.log.read_text())

    def test_upload_failure_prevents_launch(self):
        self.env["MH_SCP_EXIT"] = "1"
        result = self.install("--no-build")
        self.assertNotEqual(result.returncode, 0)
        calls = self.log.read_text()
        self.assertNotIn("appInstallService/dev/install", calls)
        self.assertNotIn("applicationManager/launch", calls)

    def test_remote_and_luna_failures_propagate(self):
        self.env["MH_SSH_EXIT"] = "255"
        self.assertNotEqual(self.install("--check").returncode, 0)
        self.env["MH_SSH_EXIT"] = "0"
        for response in ('{"returnValue":false}', 'not json'):
            with self.subTest(response=response):
                self.env["MH_RESPONSE"] = response
                self.assertNotEqual(self.install("--no-build").returncode, 0)
                self.assertIn("luna-send", self.log.read_text())

    def test_install_service_failure_stops_before_hook_and_launch(self):
        self.env["MH_INSTALL_RESPONSE"] = '{"state":"install failed"}'
        result = self.install("--no-build")
        self.assertNotEqual(result.returncode, 0)
        calls = self.log.read_text()
        self.assertNotIn("elevate-service' org.minimal.home.service", calls)
        self.assertNotIn("50-minimal-home", calls)


if __name__ == "__main__":
    unittest.main()
