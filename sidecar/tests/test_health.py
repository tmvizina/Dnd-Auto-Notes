"""The sidecar must start and answer on a machine with no models installed."""

from __future__ import annotations

from fastapi.testclient import TestClient

from dnd_sidecar import capabilities
from dnd_sidecar.server import DEFAULT_PORT, app

client = TestClient(app)


def test_health_responds_on_a_bare_machine() -> None:
    response = client.get("/health")
    assert response.status_code == 200
    body = response.json()
    assert body["status"] in {"ok", "degraded"}
    assert body["version"]
    assert body["device"] in {"cpu", "cuda", "mps"} or body["device"]


def test_health_reports_every_optional_capability() -> None:
    caps = client.get("/health").json()["capabilities"]
    for name in capabilities.OPTIONAL_MODULES:
        assert name.replace(".", "_") in caps
    assert "ffmpeg" in caps
    # Values are booleans, never None — a missing probe must not read as
    # "maybe installed".
    assert all(isinstance(value, bool) for value in caps.values())


def test_health_never_raises_even_if_a_probe_explodes(monkeypatch) -> None:
    def boom() -> dict[str, object]:
        raise RuntimeError("simulated broken install")

    monkeypatch.setattr(capabilities, "health", boom)
    response = client.get("/health")
    assert response.status_code == 200
    assert response.json()["status"] == "degraded"


def test_missing_capability_messages_are_actionable() -> None:
    for name in ("mlx_whisper", "torch", "ffmpeg"):
        message = capabilities.missing_capability_message(name)
        assert name in message
        assert "To enable it:" in message


def test_default_port_is_the_documented_one() -> None:
    assert DEFAULT_PORT == 8477


def test_probe_reports_a_missing_file_without_raising(tmp_path) -> None:
    present = tmp_path / "a.txt"
    present.write_text("hello")
    response = client.post(
        "/probe", json={"paths": [str(present), str(tmp_path / "absent.txt")]}
    )
    assert response.status_code == 200
    files = response.json()["files"]
    assert files[0]["exists"] is True
    assert files[0]["size_bytes"] == 5
    assert files[1]["exists"] is False
