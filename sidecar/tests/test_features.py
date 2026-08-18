"""Fixture-driven feature extraction tests; no model or network is required."""

from __future__ import annotations

import json
import math
import struct
import sys
import time
import types
import wave

import pytest
from fastapi.testclient import TestClient

from dnd_sidecar import features, jobs
from dnd_sidecar.server import app

RATE = 16_000
CLIENT = TestClient(app)


def _write_track(path, seconds: float = 4.0) -> None:
    values = []
    for index in range(round(seconds * RATE)):
        t = index / RATE
        amplitude = 0.55 if (t % 1.4) < 0.9 else 0.08
        values.append(amplitude * math.sin(2 * math.pi * (180 + 30 * t) * t))
    with wave.open(str(path), "wb") as handle:
        handle.setnchannels(1)
        handle.setsampwidth(2)
        handle.setframerate(RATE)
        handle.writeframes(b"".join(struct.pack("<h", round(value * 32767)) for value in values))


@pytest.fixture(autouse=True)
def fake_features(monkeypatch: pytest.MonkeyPatch):
    monkeypatch.setenv("DND_FAKE_EMBED", "1")
    features.reset_for_tests()
    jobs.reset_for_tests()
    yield
    jobs.reset_for_tests()
    features.reset_for_tests()


def _truth(root) -> None:
    (root / "truth.json").write_text(
        json.dumps(
            {
                "utterances": [
                    {"id": "u1", "player_id": "p1", "character_id": "c1"},
                    {"id": "u2", "player_id": "p1", "character_id": "c1"},
                    {"id": "u3", "player_id": "p1", "character_id": "c2"},
                ]
            }
        ),
        encoding="utf-8",
    )


def test_fake_features_are_deterministic_normalized_and_character_seeded(tmp_path) -> None:
    path = tmp_path / "track.wav"
    _write_track(path)
    _truth(tmp_path)
    utterances = [
        {"id": "u1", "player_id": "p1", "start": 0.1, "end": 1.1, "words": [{"s": 0.2, "e": 0.4}]},
        {"id": "u2", "player_id": "p1", "start": 1.2, "end": 2.2, "words": [{"s": 1.3, "e": 1.5}, {"s": 1.7, "e": 1.9}]},
        {"id": "u3", "player_id": "p1", "start": 2.3, "end": 3.3, "words": [{"s": 2.4, "e": 2.6}]},
    ]
    first = features.compute_features(path, utterances, {"backend": "fake"})
    second = features.compute_features(path, utterances, {"backend": "fake"})
    rows = first["rows"]
    assert rows == second["rows"]
    assert first["dimension"] == 16
    assert rows[0]["embedding"] == rows[1]["embedding"]
    assert rows[0]["embedding"] != rows[2]["embedding"]
    for row in rows:
        vector = row["embedding"]
        assert vector is not None
        assert math.isclose(math.sqrt(sum(value * value for value in vector)), 1.0, rel_tol=1e-6)
        assert set(row["prosody"]) == set(features._PROSODY_FIELDS)
        assert set(row["prosody_z"]) == set(features._PROSODY_FIELDS)
        assert isinstance(row["prosody"]["jitter_proxy"], float)
        assert isinstance(row["prosody_z"]["jitter_proxy"], float)
    assert rows[0]["prosody_z"]["rate_wps"] < rows[1]["prosody_z"]["rate_wps"]


def test_short_utterance_is_explicitly_null(tmp_path) -> None:
    path = tmp_path / "track.wav"
    _write_track(path)
    result = features.compute_features(
        path,
        [{"id": "short", "player_id": "p1", "start": 0.1, "end": 0.2}],
        {"backend": "fake", "min_duration_s": 0.6},
    )
    assert result["rows"] == [{
        "utterance_id": "short",
        "player_id": "p1",
        "duration_s": 0.1,
        "embedding": None,
        "prosody": None,
        "prosody_z": None,
        "features": None,
    }]


def test_features_endpoint_completes_async_job(tmp_path) -> None:
    path = tmp_path / "track.wav"
    _write_track(path)
    response = CLIENT.post(
        "/features",
        json={"track_path": str(path), "utterances": [{"id": "u1", "player_id": "p1", "start": 0.1, "end": 1.1}]},
    )
    assert response.status_code == 200
    job_id = response.json()["job_id"]
    deadline = time.time() + 5
    while time.time() < deadline:
        job = CLIENT.get(f"/jobs/{job_id}").json()
        if job["status"] in {"done", "failed"}:
            break
        time.sleep(0.01)
    assert job["status"] == "done", job
    assert job["result"]["backend"] == "fake"


def test_unknown_player_is_rejected_instead_of_inferred(tmp_path) -> None:
    path = tmp_path / "track.wav"
    _write_track(path)
    with pytest.raises(ValueError, match="no player_id"):
        features.compute_features(path, [{"id": "u1", "start": 0.1, "end": 1.1}], {"backend": "fake"})


def test_real_embedding_batches_multiple_clips(monkeypatch: pytest.MonkeyPatch) -> None:
    import numpy as np

    calls = []

    class Tensor:
        def __init__(self, value):
            self.value = value

    class Output:
        def __init__(self, value):
            self.value = value

        def detach(self):
            return self

        def cpu(self):
            return self

        def __array__(self, dtype=None):
            return np.asarray(self.value, dtype=dtype)

    class Model:
        def encode_batch(self, tensor, lengths):
            calls.append(tensor.value.shape)
            assert lengths.value.tolist() == [0.5, 1.0]
            return Output(np.ones((tensor.value.shape[0], 1, 4), dtype=np.float32))

    monkeypatch.setitem(sys.modules, "torch", types.SimpleNamespace(from_numpy=Tensor))
    result = features._real_embeddings(Model(), [np.ones(10, dtype=np.float32), np.ones(20, dtype=np.float32)])
    assert calls == [(2, 20)]
    assert len(result) == 2
    assert all(math.isclose(math.sqrt(sum(value * value for value in row)), 1.0, rel_tol=1e-6) for row in result)
