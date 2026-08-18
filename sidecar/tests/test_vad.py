"""Deterministic VAD tests with no Silero model or network access."""

from __future__ import annotations

import hashlib
import math
import struct
import sys
import time
import types
import wave

import pytest
from fastapi.testclient import TestClient

from dnd_sidecar import jobs, vad
from dnd_sidecar.server import app

SOURCE_RATE = 8000
client = TestClient(app)


def _write_track(
    path, schedules: list[tuple[float, float]], *, seconds: float, amplitude: float = 0.65
) -> None:
    count = round(seconds * SOURCE_RATE)
    samples = [0.0] * count
    for start_s, end_s in schedules:
        first = round(start_s * SOURCE_RATE)
        last = min(count, round(end_s * SOURCE_RATE))
        ramp = round(0.03 * SOURCE_RATE)
        for index in range(first, last):
            position = index - first
            length = last - first
            envelope = min(1.0, position / ramp, (length - position) / ramp)
            samples[index] = (
                amplitude * envelope * math.sin(2 * math.pi * 196 * index / SOURCE_RATE)
            )

    with wave.open(str(path), "wb") as handle:
        handle.setnchannels(1)
        handle.setsampwidth(2)
        handle.setframerate(SOURCE_RATE)
        handle.writeframes(
            b"".join(
                struct.pack("<h", round(max(-1.0, min(1.0, value)) * 32767)) for value in samples
            )
        )


@pytest.fixture(autouse=True)
def force_energy_backend(monkeypatch: pytest.MonkeyPatch) -> None:
    """Silero is optional; these tests must prove the bare-machine path."""
    monkeypatch.setattr(vad, "silero_available", lambda: False)


@pytest.fixture(autouse=True)
def reset_job_registry():
    jobs.reset_for_tests()
    yield
    jobs.reset_for_tests()


def _wait_for_job(job_id: str, statuses: set[str], *, timeout: float = 10.0) -> dict:
    deadline = time.time() + timeout
    while time.time() < deadline:
        response = client.get(f"/jobs/{job_id}")
        assert response.status_code == 200
        job = response.json()
        if job["status"] in statuses:
            return job
        time.sleep(0.01)
    raise AssertionError(f"job {job_id} never reached {statuses}")


def test_energy_fallback_finds_fixture_boundaries_and_keeps_source_unchanged(tmp_path) -> None:
    path = tmp_path / "1-synthetic.wav"
    schedule = [(1.0, 2.4), (3.2, 5.0), (6.0, 7.1)]
    _write_track(path, schedule, seconds=9.0)
    original = path.read_bytes()
    expected_hash = hashlib.sha256(original).hexdigest()

    result = vad.analyze_track(path, {"backend": "energy"})

    assert result["backend"] == "energy"
    assert result["source_sha256"] == expected_hash
    assert path.read_bytes() == original
    segments = result["segments"]
    assert isinstance(segments, list)
    assert len(segments) == len(schedule)
    for segment, (expected_start, expected_end) in zip(segments, schedule, strict=True):
        assert abs(segment["start_s"] - expected_start) <= 0.2
        assert abs(segment["end_s"] - expected_end) <= 0.2
        assert segment["mean_rms"] > 0.0
    assert 0.0 < result["speech_ratio"] < 1.0
    assert result["speech_seconds"] > sum(end - start for start, end in schedule)


def test_silero_raw_intervals_receive_only_one_default_pad(tmp_path, monkeypatch) -> None:
    path = tmp_path / "1-silero-raw.wav"
    _write_track(path, [(1.0, 2.4)], seconds=4.0)
    monkeypatch.setattr(vad, "silero_available", lambda: True)
    silero_calls: dict[str, object] = {}
    silero = types.ModuleType("silero_vad")

    def fake_get_speech_timestamps(_samples, _model, **kwargs):
        silero_calls.update(kwargs)
        return [{"start": 16_000, "end": 38_400}]

    silero.get_speech_timestamps = fake_get_speech_timestamps
    silero.load_silero_vad = lambda: object()
    torch = types.ModuleType("torch")
    torch.from_numpy = lambda samples: samples
    monkeypatch.setitem(sys.modules, "silero_vad", silero)
    monkeypatch.setitem(sys.modules, "torch", torch)

    result = vad.analyze_track(path, {"backend": "silero"})

    segment = result["segments"][0]
    assert silero_calls["speech_pad_ms"] == 0
    assert abs(segment["start_s"] - 1.0) <= 0.2
    assert abs(segment["end_s"] - 2.4) <= 0.2
    assert segment["start_s"] == pytest.approx(0.85, abs=0.02)
    assert segment["end_s"] == pytest.approx(2.55, abs=0.02)


def test_long_gap_does_not_swallow_a_quiet_sentence(tmp_path) -> None:
    path = tmp_path / "2-quiet-after-gap.wav"
    _write_track(path, [(0.8, 2.0), (8.0, 9.2)], seconds=11.0, amplitude=0.11)

    result = vad.analyze_track(path, {"backend": "energy"})

    assert len(result["segments"]) == 2
    assert result["segments"][1]["start_s"] < 8.2


def test_max_segment_is_a_hard_limit_with_overlap(tmp_path) -> None:
    path = tmp_path / "3-long.wav"
    _write_track(path, [(0.0, 65.0)], seconds=65.0)

    result = vad.analyze_track(
        path,
        {
            "backend": "energy",
            "pad_s": 0,
            "max_segment_s": 30,
            "overlap_s": 0.5,
        },
    )

    segments = result["segments"]
    assert len(segments) == 3
    assert all(segment["end_s"] - segment["start_s"] <= 30.0 for segment in segments)
    assert segments[1]["start_s"] < segments[0]["end_s"]
    assert segments[2]["start_s"] < segments[1]["end_s"]
    assert segments[-1]["end_s"] == pytest.approx(65.0, abs=0.01)


def test_silent_track_has_no_segments(tmp_path) -> None:
    path = tmp_path / "4-silent.wav"
    _write_track(path, [], seconds=4.0)

    result = vad.analyze_track(path, {"backend": "energy"})

    assert result["segments"] == []
    assert result["speech_ratio"] == 0.0
    assert result["speech_seconds"] == 0.0


def test_vad_parameter_aliases_are_deterministic_and_reject_conflicts() -> None:
    options = vad._params(
        {
            "overlap_s": 0.5,
            "split_overlap_s": 0.5,
            "threshold_db": -50,
            "absolute_floor_db": -50,
        }
    )
    assert options.split_overlap_s == 0.5
    assert options.absolute_floor_db == -50.0

    with pytest.raises(ValueError, match="split_overlap_s and overlap_s conflict"):
        vad._params({"overlap_s": 0.5, "split_overlap_s": 0.75})
    with pytest.raises(ValueError, match="absolute_floor_db and threshold_db conflict"):
        vad._params({"threshold_db": -50, "absolute_floor_db": -45})


def test_fallback_is_proportional_to_track_length(tmp_path) -> None:
    """A small benchmark guards against accidentally loading source-rate audio."""
    path = tmp_path / "5-throughput.wav"
    _write_track(path, [(10.0, 20.0), (80.0, 95.0)], seconds=120.0)

    started = time.perf_counter()
    result = vad.analyze_track(path, {"backend": "energy"})
    elapsed = time.perf_counter() - started

    assert result["backend"] == "energy"
    assert result["duration_s"] == pytest.approx(120.0, abs=0.01)
    assert elapsed < 15.0


def test_vad_endpoint_queues_and_returns_the_same_result_shape(tmp_path) -> None:
    path = tmp_path / "6-endpoint.wav"
    _write_track(path, [(1.0, 2.4)], seconds=4.0)

    response = client.post(
        "/vad",
        json={"track_path": str(path), "params": {"backend": "energy"}},
    )

    assert response.status_code == 200
    job_id = response.json()["job_id"]
    job = _wait_for_job(job_id, {"done"})
    assert job["result"]["backend"] == "energy"
    assert len(job["result"]["segments"]) == 1
    assert client.get("/health").status_code == 200


@pytest.mark.parametrize(
    ("payload", "message"),
    [
        (
            {"track_path": "does-not-exist.wav", "params": {"backend": "energy"}},
            "FileNotFoundError",
        ),
        (
            {"track_path": "also-does-not-exist.wav", "params": {"not_a_param": 1}},
            "unknown VAD parameter",
        ),
    ],
)
def test_vad_endpoint_reports_invalid_path_or_params_as_job_error(payload, message) -> None:
    response = client.post("/vad", json=payload)

    assert response.status_code == 200
    job = _wait_for_job(response.json()["job_id"], {"error"})
    assert message in job["error"]
    assert job["result"] is None
    assert client.get("/health").status_code == 200
