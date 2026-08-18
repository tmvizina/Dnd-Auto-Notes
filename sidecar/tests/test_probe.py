"""Tests for the intake probe (`P1-03`).

Everything here runs with no ffmpeg and no ffprobe installed: the WAV paths use
the standard library, and the ffprobe JSON is a recorded payload rather than a
live call. That is deliberate — CI must be able to prove the parsing and the
energy maths without a media stack.
"""

from __future__ import annotations

import math
import struct
import wave

from dnd_sidecar.probe import (
    ABSOLUTE_FLOOR_DB,
    FRAME_MS,
    SPEECH_CEILING_DB,
    SPEECH_MARGIN_DB,
    parse_ffprobe,
    probe_file,
    speech_ratio,
)

SAMPLE_RATE = 8000


def _tone(seconds: float, frequency: float = 196.0, amplitude: float = 0.7) -> list[float]:
    count = int(seconds * SAMPLE_RATE)
    return [amplitude * math.sin(2 * math.pi * frequency * (i / SAMPLE_RATE)) for i in range(count)]


def _write_wav(path, samples: list[float], *, channels: int = 1, width: int = 2) -> None:
    with wave.open(str(path), "wb") as handle:
        handle.setnchannels(channels)
        handle.setsampwidth(width)
        handle.setframerate(SAMPLE_RATE)
        scale = 32767
        frames = bytearray()
        for value in samples:
            clamped = max(-1.0, min(1.0, value))
            frames += struct.pack("<" + "h" * channels, *([int(clamped * scale)] * channels))
        handle.writeframes(bytes(frames))


# --- the energy maths ------------------------------------------------------


def test_digital_silence_is_exactly_zero() -> None:
    assert speech_ratio([0.0] * SAMPLE_RATE, SAMPLE_RATE) == 0.0


def test_a_full_tone_is_entirely_speech() -> None:
    """A track that never stops must not read as silent.

    Every frame sits at the same level, so the adaptive floor lands on the
    signal itself; only the ceiling saves this case.
    """
    assert speech_ratio(_tone(1.0), SAMPLE_RATE) == 1.0


def test_ratio_tracks_the_speaking_fraction() -> None:
    # 2 s of tone inside 10 s of silence: one fifth of the frames.
    samples = [0.0] * (4 * SAMPLE_RATE) + _tone(2.0) + [0.0] * (4 * SAMPLE_RATE)
    assert speech_ratio(samples, SAMPLE_RATE) == 0.2


def test_a_quiet_hiss_is_not_mistaken_for_speech() -> None:
    """The absolute floor is what stops a track of dither reading as 100 %.

    Without it the adaptive floor sits just under the hiss and every frame
    clears it by the 12 dB margin.
    """
    quiet = [1e-4 * (1 if i % 2 else -1) for i in range(SAMPLE_RATE)]
    assert 20 * math.log10(1e-4) < ABSOLUTE_FLOOR_DB
    assert speech_ratio(quiet, SAMPLE_RATE) == 0.0


def test_frames_shorter_than_one_frame_measure_nothing() -> None:
    assert speech_ratio([0.5] * 10, SAMPLE_RATE) == 0.0


def test_constants_match_the_typescript_side() -> None:
    """These are a cross-language contract, not local tuning knobs.

    `packages/core/src/intake/craig/speech.ts` declares the same three values;
    if one side changes, the same session reports different silent participants
    depending on whether a sidecar happened to be running.
    """
    assert FRAME_MS == 20
    assert SPEECH_MARGIN_DB == 12.0
    assert ABSOLUTE_FLOOR_DB == -55.0
    assert SPEECH_CEILING_DB == -35.0


# --- ffprobe json ----------------------------------------------------------


def test_parse_ffprobe_reads_the_audio_stream() -> None:
    facts = parse_ffprobe(
        {
            "streams": [
                {"codec_type": "video", "codec_name": "png"},
                {
                    "codec_type": "audio",
                    "codec_name": "flac",
                    "sample_rate": "48000",
                    "channels": 2,
                    "duration": "14682.300000",
                },
            ],
            "format": {"duration": "14682.310000"},
        }
    )
    assert facts == {
        "duration_s": 14682.3,
        "sample_rate": 48000,
        "channels": 2,
        "codec": "flac",
    }


def test_parse_ffprobe_falls_back_to_the_container_duration() -> None:
    """Some AAC-in-M4A files carry a duration only on the format."""
    facts = parse_ffprobe(
        {
            "streams": [{"codec_type": "audio", "codec_name": "aac", "sample_rate": "44100"}],
            "format": {"duration": "120.5"},
        }
    )
    assert facts["duration_s"] == 120.5
    assert facts["channels"] is None


def test_parse_ffprobe_survives_a_file_with_no_audio() -> None:
    facts = parse_ffprobe({"streams": [], "format": {}})
    assert facts["duration_s"] is None
    assert facts["codec"] is None


# --- probe_file ------------------------------------------------------------


def test_probe_file_measures_a_wav_without_ffmpeg(tmp_path) -> None:
    path = tmp_path / "1-ashcodes.wav"
    _write_wav(path, [0.0] * (5 * SAMPLE_RATE) + _tone(5.0))

    result = probe_file(str(path))

    assert result["exists"] is True
    assert result["duration_s"] == 10.0
    assert result["sample_rate"] == SAMPLE_RATE
    assert result["channels"] == 1
    assert result["codec"] == "pcm_s16le"
    assert result["speech_ratio"] == 0.5


def test_probe_file_reports_a_silent_track(tmp_path) -> None:
    path = tmp_path / "2-blybird.wav"
    _write_wav(path, [0.0] * (3 * SAMPLE_RATE))

    result = probe_file(str(path))

    assert result["duration_s"] == 3.0
    assert result["speech_ratio"] == 0.0


def test_probe_file_averages_channels(tmp_path) -> None:
    """A hand-converted stereo file must not read as silence.

    Taking only the first channel would report a participant whose voice landed
    in the right channel as absent for the whole session.
    """
    path = tmp_path / "3-cyd_h.wav"
    _write_wav(path, _tone(1.0), channels=2)

    result = probe_file(str(path))

    assert result["channels"] == 2
    assert result["speech_ratio"] == 1.0


def test_probe_file_does_not_raise_on_a_missing_file(tmp_path) -> None:
    result = probe_file(str(tmp_path / "nope.flac"))
    assert result["exists"] is False
    assert "error" in result


def test_media_false_skips_measurement(tmp_path) -> None:
    path = tmp_path / "4-wren_dm.wav"
    _write_wav(path, _tone(0.5))

    result = probe_file(str(path), media=False)

    assert result["exists"] is True
    assert "speech_ratio" not in result
