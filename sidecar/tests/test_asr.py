"""Model-free ASR contract tests."""

from __future__ import annotations

import json
import sys
import time
import types
from itertools import pairwise
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from dnd_sidecar import asr, jobs
from dnd_sidecar.server import app

client = TestClient(app)


@pytest.fixture(autouse=True)
def reset_asr_state(monkeypatch: pytest.MonkeyPatch):
    jobs.reset_for_tests()
    asr.reset_for_tests()
    monkeypatch.setenv("DND_FAKE_ASR", "1")
    yield
    jobs.reset_for_tests()
    asr.reset_for_tests()


def _fixture_session(tmp_path: Path) -> Path:
    root = tmp_path / "session"
    track = root / "input" / "craig" / "1-voice.wav"
    track.parent.mkdir(parents=True)
    track.write_bytes(b"synthetic audio bytes")
    (root / "campaign").mkdir(parents=True)
    (root / "campaign" / "glossary.md").write_text(
        "# Glossary\n\n- Zephyrax\n- Moonsteel\n", encoding="utf-8"
    )
    (root / "campaign" / "players.json").write_text(
        json.dumps(
            {
                "players": [
                    {
                        "display_name": "Test Player",
                        "characters": [{"name": "Aelwyn", "aliases": ["Ael"]}],
                    }
                ]
            }
        ),
        encoding="utf-8",
    )
    (root / "campaign" / "npcs.json").write_text(
        json.dumps({"npcs": [{"name": "Varkesh", "aliases": ["the Warden"]}]}),
        encoding="utf-8",
    )
    (root / "truth.json").write_text(
        json.dumps(
            {
                "tracks": [{"file": "1-voice.wav", "player_id": "pl_fixture"}],
                "utterances": [
                    {
                        "id": "u0001",
                        "player_id": "pl_fixture",
                        "start": 1.0,
                        "end": 2.8,
                        "text": "Zephyrax guards the Moonsteel gate.",
                    },
                    {
                        "id": "u0002",
                        "player_id": "pl_fixture",
                        "start": 4.0,
                        "end": 5.2,
                        "text": "Aelwyn saw Varkesh.",
                    },
                ],
            }
        ),
        encoding="utf-8",
    )
    return track


def _wait_for(job_id: str, statuses: set[str], timeout: float = 5.0) -> dict:
    deadline = time.time() + timeout
    while time.time() < deadline:
        job = jobs.get_job(job_id)
        assert job is not None
        if job["status"] in statuses:
            return job
        time.sleep(0.01)
    raise AssertionError(f"job {job_id} never reached {statuses}")


def test_fake_asr_is_absolute_deterministic_and_biases_proper_nouns(tmp_path: Path) -> None:
    track = _fixture_session(tmp_path)
    windows = [{"start_s": 0.8, "end_s": 3.2}, {"start_s": 3.8, "end_s": 5.5}]

    first = asr.transcribe_track(track, windows, backend="auto")
    second = asr.transcribe_track(track, windows, backend="auto")

    assert first == second
    assert first["backend"] == "fake"
    assert first["model"] == "fixture-truth"
    assert first["errors"] == []
    segments = first["segments"]
    assert [segment["start_s"] for segment in segments] == [1.0, 4.0]
    assert "Zephyrax" in segments[0]["text"]
    assert "Moonsteel" in first["initial_prompt"]
    words = [word for segment in segments for word in segment["words"]]
    assert all(left["s"] <= right["s"] for left, right in pairwise(words))
    assert all(word["e"] > word["s"] for word in words)


def test_initial_prompt_is_bounded_and_contains_campaign_names(tmp_path: Path) -> None:
    track = _fixture_session(tmp_path)
    prompt = asr.build_initial_prompt(track_path=track, max_chars=48)

    assert len(prompt.text) <= 48
    assert prompt.text == asr.build_initial_prompt(track_path=track, max_chars=48).text
    assert prompt.terms


def test_transcribe_endpoint_is_async_and_returns_common_schema(tmp_path: Path) -> None:
    track = _fixture_session(tmp_path)
    response = client.post(
        "/transcribe",
        json={
            "track_path": str(track),
            "segments": [{"start_s": 0.8, "end_s": 3.2}],
            "backend": "auto",
        },
    )

    assert response.status_code == 200
    job = _wait_for(response.json()["job_id"], {"done"})
    assert job["result"]["backend"] == "fake"
    segment = job["result"]["segments"][0]
    assert set(segment) == {
        "start_s",
        "end_s",
        "text",
        "words",
        "avg_logprob",
        "no_speech_prob",
    }


def test_missing_backend_names_install_command(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("DND_FAKE_ASR", "0")
    monkeypatch.setattr(
        asr,
        "backend_capabilities",
        lambda: {name: False for name in (*asr.BACKENDS, "fake")},
    )

    with pytest.raises(asr.BackendUnavailableError, match=r"pip install faster-whisper"):
        asr.select_backend("faster-whisper")
    with pytest.raises(asr.BackendUnavailableError, match=r"pip install mlx-whisper"):
        asr.select_backend("mlx-whisper")
    with pytest.raises(asr.BackendUnavailableError, match=r"install whisper\.cpp"):
        asr.select_backend("whisper.cpp")


def test_segment_failure_is_recorded_without_discarding_other_segments(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    track = _fixture_session(tmp_path)

    class FailingBackend:
        name = "fake"
        model = "injected"

        def load(self) -> None:
            return None

        def transcribe_segment(self, _track_path, window, _settings, _prompt):
            if window.start_s >= 2:
                raise RuntimeError("synthetic segment failure")
            return asr._RawBatch(
                (
                    {
                        "start": 0.1,
                        "end": 0.4,
                        "text": "first",
                        "words": [{"word": "first", "start": 0.1, "end": 0.4}],
                    },
                ),
                timestamps_absolute=False,
            )

    monkeypatch.setattr(asr, "select_backend", lambda _requested: "fake")
    monkeypatch.setattr(asr, "_adapter", lambda *_args: FailingBackend())

    result = asr.transcribe_track(
        track,
        [{"start_s": 0.8, "end_s": 1.2}, {"start_s": 2.0, "end_s": 2.5}],
        backend="fake",
    )

    assert len(result["segments"]) == 1
    assert result["segments"][0]["start_s"] == 0.9
    assert result["errors"] == [
        {
            "segment_index": 1,
            "start_s": 2.0,
            "end_s": 2.5,
            "error": "RuntimeError: synthetic segment failure",
        }
    ]


def test_relative_backend_times_become_track_absolute() -> None:
    normalized = asr._normalise_batch(
        asr._RawBatch(
            (
                {
                    "start": 0.25,
                    "end": 0.75,
                    "text": "word",
                    "words": [{"word": "word", "start": 0.25, "end": 0.75}],
                },
            ),
            timestamps_absolute=False,
        ),
        asr.SegmentWindow(10.0, 12.0),
    )

    assert normalized[0]["start_s"] == 10.25
    assert normalized[0]["end_s"] == 10.75
    assert normalized[0]["words"] == [{"t": "word", "s": 10.25, "e": 10.75}]


def test_faster_whisper_clip_timestamps_are_not_offset_twice(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    track = tmp_path / "track.wav"
    track.write_bytes(b"synthetic")
    calls: list[dict[str, object]] = []

    class FixtureWhisperModel:
        def __init__(self, _model: str, *, device: str, compute_type: str) -> None:
            calls.append({"device": device, "compute_type": compute_type})

        def transcribe(self, _path: str, **kwargs: object):
            calls.append(kwargs)
            return (
                iter(
                    (
                        {
                            "start": 10.25,
                            "end": 10.75,
                            "text": "word",
                            "words": [{"word": "word", "start": 10.25, "end": 10.75}],
                        },
                    )
                ),
                {},
            )

    faster_module = types.ModuleType("faster_whisper")
    faster_module.WhisperModel = FixtureWhisperModel  # type: ignore[attr-defined]
    monkeypatch.setitem(sys.modules, "faster_whisper", faster_module)
    adapter = asr._FasterWhisperBackend("fixture", "cpu", "int8")
    window = asr.SegmentWindow(10.0, 12.0)
    batch = adapter.transcribe_segment(
        track,
        window,
        asr.ASRSettings(device="cpu", compute_type="int8"),
        "",
    )

    assert batch.timestamps_absolute is True
    assert asr._normalise_batch(batch, window)[0]["start_s"] == 10.25
    assert calls[1]["clip_timestamps"] == [10.0, 12.0]


def test_overlapping_windows_clip_duplicate_words_globally(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    track = _fixture_session(tmp_path)

    class OverlapBackend:
        name = "fake"
        model = "overlap-fixture"

        def load(self) -> None:
            return None

        def transcribe_segment(self, _track_path, window, _settings, _prompt):
            if window.start_s < 1:
                return asr._RawBatch(
                    (
                        {
                            "start": 1.0,
                            "end": 3.0,
                            "text": "one two",
                            "words": [
                                {"word": "one", "start": 1.0, "end": 2.0},
                                {"word": "two", "start": 2.5, "end": 3.0},
                            ],
                        },
                    ),
                    timestamps_absolute=True,
                )
            return asr._RawBatch(
                (
                    {
                        "start": 2.5,
                        "end": 4.0,
                        "text": "duplicate tail",
                        "words": [
                            {"word": "duplicate", "start": 2.5, "end": 2.8},
                            {"word": "tail", "start": 2.9, "end": 3.6},
                        ],
                    },
                ),
                timestamps_absolute=True,
            )

    monkeypatch.setattr(asr, "select_backend", lambda _requested: "fake")
    monkeypatch.setattr(asr, "_adapter", lambda *_args: OverlapBackend())
    result = asr.transcribe_track(
        track,
        [{"start_s": 0.0, "end_s": 3.0}, {"start_s": 2.0, "end_s": 4.0}],
        backend="fake",
    )

    words = [word for segment in result["segments"] for word in segment["words"]]
    assert [word["t"] for word in words] == ["one", "two", "tail"]
    assert [word["s"] for word in words] == [1.0, 2.5, 3.0]
    assert all(left["s"] <= right["s"] for left, right in pairwise(words))
    assert all(left["e"] <= right["e"] for left, right in pairwise(words))


def test_all_backend_adapters_normalize_to_the_same_schema_and_settings(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Exercise every adapter with tiny injected outputs, without model packages."""
    track = tmp_path / "track.wav"
    track.write_bytes(b"synthetic")
    window = asr.SegmentWindow(10.0, 12.0)
    settings = asr.ASRSettings(language="en", beam_size=7, timeout_s=12.5)
    expected = {
        "start_s": 10.25,
        "end_s": 10.75,
        "text": "Zephyrax",
        "words": [{"t": "Zephyrax", "s": 10.25, "e": 10.75}],
        "avg_logprob": -0.2,
        "no_speech_prob": 0.1,
    }
    absolute_faster = {
        "start": 10.25,
        "end": 10.75,
        "text": "Zephyrax",
        "words": [{"word": "Zephyrax", "start": 10.25, "end": 10.75}],
        "avg_logprob": -0.2,
        "no_speech_prob": 0.1,
    }
    absolute = {
        "start": 10.25,
        "end": 10.75,
        "text": "Zephyrax",
        "words": [{"word": "Zephyrax", "start": 10.25, "end": 10.75}],
        "avg_logprob": -0.2,
        "no_speech_prob": 0.1,
    }
    faster_calls: list[dict[str, object]] = []

    class FixtureWhisperModel:
        def __init__(self, model: str, *, device: str, compute_type: str) -> None:
            faster_calls.append({"load": model, "device": device, "compute_type": compute_type})

        def transcribe(self, _path: str, **kwargs: object):
            faster_calls.append(kwargs)
            return iter((absolute_faster,)), {"fixture": True}

    faster_module = types.ModuleType("faster_whisper")
    faster_module.WhisperModel = FixtureWhisperModel  # type: ignore[attr-defined]
    monkeypatch.setitem(sys.modules, "faster_whisper", faster_module)
    faster = asr._FasterWhisperBackend("fixture", "cpu", "int8")
    faster_batch = faster.transcribe_segment(track, window, settings, "Zephyrax")

    mlx_calls: list[dict[str, object]] = []
    mlx_module = types.ModuleType("mlx_whisper")

    def mlx_transcribe(_path: str, **kwargs: object):
        mlx_calls.append(kwargs)
        return {"segments": [absolute]}

    mlx_module.transcribe = mlx_transcribe  # type: ignore[attr-defined]
    monkeypatch.setitem(sys.modules, "mlx_whisper", mlx_module)
    mlx = asr._MlxWhisperBackend("fixture")
    mlx_batch = mlx.transcribe_segment(track, window, settings, "Zephyrax")

    cpp_payload = {
        "transcription": [
            {
                "timestamps": {"from": "00:00:10,250", "to": "00:00:10,750"},
                "text": "Zephyrax",
                "tokens": [
                    {
                        "text": "Zephyrax",
                        "timestamps": {"from": "00:00:10,250", "to": "00:00:10,750"},
                    }
                ],
                "avg_logprob": -0.2,
                "no_speech_prob": 0.1,
            }
        ]
    }

    server_starts: list[object] = []
    server_requests: list[tuple[Path, asr.ASRSettings, str]] = []

    def start_server(instance) -> None:
        server_starts.append(instance)
        instance._process = object()  # type: ignore[attr-defined]
        instance._base_url = "http://fixture"  # type: ignore[attr-defined]
        instance._server_ready = True  # type: ignore[attr-defined]

    def request_server(instance, path, request_settings, prompt):
        server_requests.append((path, request_settings, prompt))
        return asr._RawBatch(asr._cpp_segments(cpp_payload), timestamps_absolute=True)

    monkeypatch.setattr(asr._WhisperCppBackend, "_start_server", start_server)
    monkeypatch.setattr(asr._WhisperCppBackend, "_request_server", request_server)
    cpp = asr._WhisperCppBackend("fixture.gguf")
    cpp.load()
    cpp_batch = cpp.transcribe_segment(track, window, settings, "Zephyrax")

    assert faster_batch.timestamps_absolute is True
    assert asr._normalise_batch(faster_batch, window) == [expected]
    assert asr._normalise_batch(mlx_batch, window) == [expected]
    assert asr._normalise_batch(cpp_batch, window) == [expected]
    assert len(server_starts) == 1
    assert server_requests == [(track, settings, "Zephyrax")]
    assert faster_calls[0] == {"load": "fixture", "device": "cpu", "compute_type": "int8"}
    assert faster_calls[1]["temperature"] == 0.0
    assert faster_calls[1]["beam_size"] == 7
    assert faster_calls[1]["condition_on_previous_text"] is False
    assert faster_calls[1]["word_timestamps"] is True
    assert mlx_calls[0]["temperature"] == 0.0
    assert mlx_calls[0]["beam_size"] == 7
    assert mlx_calls[0]["condition_on_previous_text"] is False


def test_real_backend_singleton_is_lazy_and_loaded_once(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    track = tmp_path / "track.wav"
    track.write_bytes(b"synthetic")
    loads: list[tuple[str, str, str]] = []

    class FixtureWhisperModel:
        def __init__(self, model: str, *, device: str, compute_type: str) -> None:
            loads.append((model, device, compute_type))

    faster_module = types.ModuleType("faster_whisper")
    faster_module.WhisperModel = FixtureWhisperModel  # type: ignore[attr-defined]
    monkeypatch.setitem(sys.modules, "faster_whisper", faster_module)
    settings = asr.ASRSettings(device="cpu", compute_type="int8")

    first = asr._adapter("faster-whisper", "fixture", settings, track)
    second = asr._adapter("faster-whisper", "fixture", settings, track)
    assert first is second
    assert loads == []
    first.load()
    first.load()
    assert loads == [("fixture", "cpu", "int8")]


def test_mlx_model_holder_is_reused_across_jobs(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    track = _fixture_session(tmp_path)
    loads: list[tuple[str, object]] = []
    get_calls: list[str] = []

    class FixtureHolder:
        model: object | None = None
        model_path: str | None = None

        @classmethod
        def get_model(cls, model_path: str, *, dtype: object):
            get_calls.append(model_path)
            if cls.model is None or cls.model_path != model_path:
                loads.append((model_path, dtype))
                cls.model = object()
                cls.model_path = model_path
            return cls.model

    mlx_module = types.ModuleType("mlx_whisper")
    mlx_module.__path__ = []  # type: ignore[attr-defined]

    def mlx_transcribe(_path: str, **kwargs: object):
        FixtureHolder.get_model(kwargs["path_or_hf_repo"], dtype=mlx_core.float16)
        start = kwargs["clip_timestamps"][0] + 0.1  # type: ignore[index,operator]
        end = kwargs["clip_timestamps"][0] + 0.4  # type: ignore[index,operator]
        return {
            "segments": [
                {
                    "start": start,
                    "end": end,
                    "text": "fixture",
                    "words": [{"word": "fixture", "start": start, "end": end}],
                }
            ]
        }

    mlx_module.transcribe = mlx_transcribe  # type: ignore[attr-defined]
    transcribe_module = types.ModuleType("mlx_whisper.transcribe")
    transcribe_module.ModelHolder = FixtureHolder  # type: ignore[attr-defined]
    mlx_core = types.ModuleType("mlx.core")
    mlx_core.float16 = object()  # type: ignore[attr-defined]
    mlx_parent = types.ModuleType("mlx")
    mlx_parent.__path__ = []  # type: ignore[attr-defined]
    mlx_parent.core = mlx_core  # type: ignore[attr-defined]
    monkeypatch.setitem(sys.modules, "mlx_whisper", mlx_module)
    monkeypatch.setitem(sys.modules, "mlx_whisper.transcribe", transcribe_module)
    monkeypatch.setitem(sys.modules, "mlx", mlx_parent)
    monkeypatch.setitem(sys.modules, "mlx.core", mlx_core)
    monkeypatch.setattr(asr, "select_backend", lambda _requested: "mlx-whisper")

    first = asr.transcribe_track(
        track,
        [{"start_s": 0.0, "end_s": 2.0}],
        backend="mlx-whisper",
        model="fixture",
    )
    second = asr.transcribe_track(
        track,
        [{"start_s": 2.0, "end_s": 4.0}],
        backend="mlx-whisper",
        model="fixture",
    )

    assert first["errors"] == []
    assert second["errors"] == []
    assert len(get_calls) == 3  # preload + one call inside each transcribe job
    assert len(loads) == 1


def test_whisper_cpp_batches_windows_one_process_per_job(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    track = _fixture_session(tmp_path)
    payload = {
        "transcription": [
            {
                "timestamps": {"from": "00:00:01,000", "to": "00:00:02,000"},
                "text": "first",
                "tokens": [
                    {
                        "text": "first",
                        "timestamps": {"from": "00:00:01,000", "to": "00:00:02,000"},
                    }
                ],
            },
            {
                "timestamps": {"from": "00:00:03,000", "to": "00:00:04,000"},
                "text": "second",
                "tokens": [
                    {
                        "text": "second",
                        "timestamps": {"from": "00:00:03,000", "to": "00:00:04,000"},
                    }
                ],
            },
        ]
    }

    server_starts: list[object] = []
    server_requests: list[tuple[Path, asr.ASRSettings, str]] = []

    class FixtureProcess:
        def poll(self) -> None:
            return None

        def terminate(self) -> None:
            return None

        def wait(self, *, timeout: float) -> None:
            assert timeout == 2

    def start_server(instance) -> None:
        server_starts.append(instance)
        instance._process = FixtureProcess()  # type: ignore[attr-defined]
        instance._base_url = "http://fixture"  # type: ignore[attr-defined]
        instance._server_ready = True  # type: ignore[attr-defined]

    def request_server(instance, path, settings, prompt):
        server_requests.append((path, settings, prompt))
        return asr._RawBatch(asr._cpp_segments(payload), timestamps_absolute=True)

    adapter = asr._WhisperCppBackend("fixture.gguf")
    monkeypatch.setattr(asr._WhisperCppBackend, "_start_server", start_server)
    monkeypatch.setattr(asr._WhisperCppBackend, "_request_server", request_server)
    monkeypatch.setattr(asr, "select_backend", lambda _requested: "whisper.cpp")
    monkeypatch.setattr(asr, "_adapter", lambda *_args: adapter)
    windows = [{"start_s": 0.0, "end_s": 2.0}, {"start_s": 2.0, "end_s": 4.0}]

    first = asr.transcribe_track(track, windows, backend="whisper.cpp", model="fixture.gguf")
    second = asr.transcribe_track(track, windows, backend="whisper.cpp", model="fixture.gguf")

    assert first["errors"] == []
    assert second["errors"] == []
    assert [segment["text"] for segment in first["segments"]] == ["first", "second"]
    assert len(server_starts) == 1  # one persistent model process across both jobs
    assert len(server_requests) == 2  # one full-track HTTP request per job
    adapter.close()


def test_whisper_cpp_request_disables_decoder_context(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    track = tmp_path / "track.wav"
    track.write_bytes(b"synthetic audio")
    adapter = asr._WhisperCppBackend("fixture.gguf")

    class FixtureProcess:
        def __init__(self) -> None:
            self.returncode: int | None = None

        def poll(self) -> int | None:
            return self.returncode

        def terminate(self) -> None:
            self.returncode = 0

        def wait(self, *, timeout: float) -> int:
            assert timeout == 2
            return 0

        def kill(self) -> None:
            self.returncode = -9

    adapter._process = FixtureProcess()  # type: ignore[attr-defined]
    adapter._base_url = "http://fixture"  # type: ignore[attr-defined]
    adapter._server_ready = True  # type: ignore[attr-defined]
    requests: list[tuple[object, bytes]] = []

    class FixtureResponse:
        status = 200

        def __enter__(self):
            return self

        def __exit__(self, *_args):
            return None

        def read(self) -> bytes:
            return b'{"transcription": []}'

    def urlopen(request, *, timeout):
        requests.append((request, request.data))
        assert timeout == asr.DEFAULT_TIMEOUT_S
        return FixtureResponse()

    monkeypatch.setattr(asr.urllib.request, "urlopen", urlopen)
    adapter._request_server(track, asr.ASRSettings(), "")

    assert len(requests) == 1
    request, body = requests[0]
    assert request.full_url == "http://fixture/inference"
    assert b'name="no_context"\r\n\r\n1\r\n' in body
    adapter.close()


def test_glossary_prompt_improves_invented_name_against_unbiased_control(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    track = _fixture_session(tmp_path)

    class PromptSensitiveFixture:
        name = "fake"
        model = "prompt-sensitive"

        def load(self) -> None:
            return None

        def transcribe_segment(self, _track_path, window, _settings, prompt):
            text = "Zephyrax" if "Zephyrax" in prompt else "Zeffyrax"
            return asr._RawBatch(
                (
                    {
                        "start": window.start_s,
                        "end": window.start_s + 0.5,
                        "text": text,
                        "words": [
                            {"word": text, "start": window.start_s, "end": window.start_s + 0.5}
                        ],
                    },
                ),
                timestamps_absolute=True,
            )

    monkeypatch.setattr(asr, "select_backend", lambda _requested: "fake")
    monkeypatch.setattr(asr, "_adapter", lambda *_args: PromptSensitiveFixture())
    biased = asr.transcribe_track(track, [{"start_s": 1.0, "end_s": 2.0}], backend="fake")
    unbiased = asr.transcribe_track(
        track,
        [{"start_s": 1.0, "end_s": 2.0}],
        backend="fake",
        params={"campaign_root": str(tmp_path / "empty-campaign")},
    )

    assert biased["prompt_terms"]
    assert biased["segments"][0]["text"] == "Zephyrax"
    assert unbiased["segments"][0]["text"] == "Zeffyrax"
    assert biased["segments"][0]["text"] != unbiased["segments"][0]["text"]


def test_transcribe_endpoint_reports_missing_backend_as_job_error(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    track = _fixture_session(tmp_path)
    monkeypatch.setenv("DND_FAKE_ASR", "0")
    monkeypatch.setattr(
        asr,
        "backend_capabilities",
        lambda: {name: False for name in (*asr.BACKENDS, "fake")},
    )

    response = client.post(
        "/transcribe",
        json={
            "track_path": str(track),
            "segments": [{"start_s": 0.8, "end_s": 3.2}],
            "backend": "whisper.cpp",
            "model": "fixture.gguf",
        },
    )
    assert response.status_code == 200
    job = _wait_for(response.json()["job_id"], {"error"})
    assert "install whisper.cpp" in job["error"]
