"""The adb guard (.claude/hooks/adb_guard.py): every adb command names 4d42e62f, nothing names the tablet."""
import json
from pathlib import Path
import subprocess
import sys
import unittest

HOOK = Path(__file__).resolve().parent.parent / ".claude" / "hooks" / "adb_guard.py"


def run(command, tool="Bash"):
    payload = json.dumps({"tool_name": tool, "tool_input": {"command": command}})
    return subprocess.run([sys.executable, "-I", str(HOOK)], input=payload, capture_output=True, text=True, timeout=30)


class AdbGuard(unittest.TestCase):
    def assertAllowed(self, command):
        r = run(command)
        self.assertEqual(r.returncode, 0, f"blocked: {command!r}: {r.stderr}")

    def assertBlocked(self, command, says):
        r = run(command)
        self.assertEqual(r.returncode, 2, f"not blocked: {command!r}")
        self.assertIn(says, r.stderr)

    def test_the_phone_named(self):
        for c in ["adb -s 4d42e62f shell getprop ro.product.model",
                  "timeout 60 adb -s 4d42e62f install -r app.apk",
                  "nice -n 19 adb -s 4d42e62f shell true",
                  "cd app && adb -s 4d42e62f reverse tcp:8790 tcp:8790",
                  "ANDROID_SERIAL=4d42e62f ./gradlew installDebug"]:
            self.assertAllowed(c)

    def test_commands_that_touch_no_device(self):
        for c in ["adb devices -l", "ls && adb version", "pipeline/stay-awake.sh 4d42e62f"]:
            self.assertAllowed(c)

    def test_adb_as_a_word_is_not_a_call(self):
        for c in ["grep -n adb docs/pipeline.md", "echo adb shell", "git commit -m 'adb shell needs -s'",
                  "git commit -m \"$(printf 'x\nadb shell\n')\""]:
            self.assertAllowed(c)

    def test_here_document_text_is_not_a_call(self):
        for c in ["git commit -F - <<'EOF'\nPackages: x\n\nadb guard.\nEOF", "cat > notes.md <<EOF\nadb shell ls\nEOF\nls",
                  "cat <<-\"EOF\" > a.md\n\tadb shell ls\n\tEOF", "git commit -F - <<'EOF'\nnot HA24BZ2Y\nEOF"]:
            self.assertAllowed(c)

    def test_a_here_document_a_shell_runs_or_a_call_after_it(self):
        for c in ["bash <<'EOF'\nadb shell ls\nEOF", "cat <<EOF | sh\nadb shell ls\nEOF",
                  "git commit -F - <<'EOF'\nmsg\nEOF\nadb shell ls"]:
            self.assertBlocked(c, "adb -s 4d42e62f")

    def test_a_bare_adb_is_blocked(self):
        for c in ["adb shell ls", "cd app && adb install x.apk", "~/Android/Sdk/platform-tools/adb shell",
                  "$ANDROID_HOME/platform-tools/adb -d shell", "timeout -k 5 30 adb -e shell",
                  "env -u FOO adb shell", "xargs -I{} adb shell rm {}", "adb devices\nadb shell ls"]:
            self.assertBlocked(c, "adb -s 4d42e62f")

    def test_inside_a_shell_string_or_a_substitution(self):
        for c in ["bash -c 'adb shell ls'", "bash -lc \"cd x; adb push a /sdcard/\"", "echo $(adb shell getprop)",
                  "eval adb shell ls", "echo `adb shell id`"]:
            self.assertBlocked(c, "adb -s 4d42e62f")

    def test_another_serial(self):
        self.assertBlocked("adb -s 0123456789 shell", "not '0123456789'")
        self.assertBlocked("ANDROID_SERIAL=emulator-5554 ./gradlew installDebug", "ANDROID_SERIAL may only be")

    def test_the_tablet_is_never_named(self):
        for c in ["adb -s HA24BZ2Y shell true", "ANDROID_SERIAL=HA24BZ2Y foo",
                  "pipeline/devlock.sh acquire HA24BZ2Y me 0", "ps -eo args | grep -i ha24bz2y"]:
            self.assertBlocked(c, "pascaline")

    def test_the_shared_adb_server(self):
        self.assertBlocked("adb -s 4d42e62f kill-server", "kill-server")
        self.assertBlocked("adb -s 4d42e62f -P 5038 shell", "-P")

    def test_other_tools_and_bad_input_pass(self):
        self.assertEqual(run("adb shell ls", tool="Read").returncode, 0)
        r = subprocess.run([sys.executable, "-I", str(HOOK)], input="not json", capture_output=True, text=True,
                           timeout=30)
        self.assertEqual(r.returncode, 0)


if __name__ == "__main__":
    unittest.main()
