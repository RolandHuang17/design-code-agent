import json
import threading
from pathlib import Path

import pytest

from codeagent.inputs import load_inputs, parse_markdown
from codeagent.safety import Redactor, safe_path
from codeagent.tools import Toolset

ROOT = Path(__file__).resolve().parents[1]


def test_supplied_documents_are_lossless_and_traceable():
    data = load_inputs(ROOT / "Architecture_Documentation.md", ROOT / "Architecture_View.md")
    assert data["diagram_count"] == 13
    assert data["issues"][0]["id"] == "INPUT-001"
    doc = data["documents"][0]
    lines = doc["text"].splitlines()
    for block in doc["code_blocks"]:
        assert block["content"] == "\n".join(lines[block["start_line"]:block["end_line"] - 1])
    assert any(h["title"] == "C. Architecture Overview" for h in doc["headings"])


def test_fences_do_not_parse_fake_headings(tmp_path):
    path = tmp_path / "test.md"
    path.write_text("# Real\n~~~~python\n# Not a heading\n```\n~~~~\n", encoding="utf-8")
    parsed = parse_markdown(path, "test")
    assert len(parsed["headings"]) == 1
    assert parsed["code_blocks"][0]["content"] == "# Not a heading\n```"
    path.write_text("```js\nunclosed", encoding="utf-8")
    with pytest.raises(ValueError, match="未闭合"):
        parse_markdown(path, "test")


@pytest.mark.parametrize("name", ["../escape", "a/../../secret", "D:\\secret", "/etc/passwd", "\\\\server\\share", "a:stream", "a/NUL.txt", "a. /x", ".git/config", "a//b", "a/../b", "a\x00b"])
def test_paths_reject_windows_escapes(tmp_path, name):
    with pytest.raises(ValueError):
        safe_path(tmp_path, name)


def test_unicode_paths_and_stale_edits(tmp_path):
    tools = Toolset(tmp_path, threading.Event(), Redactor("actual-secret"))
    write = lambda content: tools.execute("write_file", json.dumps({"path": "中文 目录/a.js", "content": content}))
    assert write("one")["written"]
    path = tmp_path / "中文 目录/a.js"
    path.write_text("// external change", encoding="utf-8")
    assert "error" in write("two")
    assert tools.execute("read_file", '{"path":"中文 目录/a.js"}')["content"] == "// external change"
    result = tools.execute("edit_file", '{"path":"中文 目录/a.js","old":"external","new":"reviewed"}')
    assert "written" in result
    assert path.read_text() == "// reviewed change"
    assert "error" in write("actual-secret")


def test_tool_validation_and_redaction(tmp_path):
    tools = Toolset(tmp_path, threading.Event(), Redactor("my-private-key"))
    for name, args in (("shell", "{}"), ("write_file", "bad-json"), ("write_file", '{"path":4,"content":"hi"}'),
                       ("list_files", '{"command":"echo"}'), ("read_file", '{"path":"x","offset":true}')):
        assert "error" in tools.execute(name, args)
    assert Redactor("my-private-key").value({"key": "my-private-key", "other": "sk-abcdefghijk"}) == {"key": "[REDACTED]", "other": "[REDACTED]"}


def test_unicode_file_continuation_uses_character_offsets(tmp_path):
    content = "甲乙\n" * 6000
    (tmp_path / "large.txt").write_text(content, encoding="utf-8")
    tools = Toolset(tmp_path, threading.Event(), Redactor("placeholder"))
    first = tools.execute("read_file", '{"path":"large.txt"}')
    assert first["offset_unit"] == "characters"
    second = tools.execute("read_file", json.dumps({"path": "large.txt", "offset": first["next_offset"]}))
    assert second["next_offset"] is None
    assert first["content"] + second["content"] == content


def test_symlink_escape(tmp_path):
    outside = tmp_path.parent / (tmp_path.name + "-outside")
    outside.mkdir()
    try:
        (tmp_path / "link").symlink_to(outside, target_is_directory=True)
    except OSError:
        pytest.skip("This Windows account cannot create symlinks")
    with pytest.raises(ValueError):
        safe_path(tmp_path, "link/file")
