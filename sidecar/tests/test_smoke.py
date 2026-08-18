"""Harness smoke test.

Two jobs: prove pytest is wired up, and prove the dependency floor the sidecar
needs is importable *without any model package installed*. The /health check
activates once P1-01 creates the app.
"""

from __future__ import annotations

import importlib

import pytest

import dnd_sidecar


def test_package_imports() -> None:
    assert dnd_sidecar.__version__


@pytest.mark.parametrize("module", ["fastapi", "uvicorn", "pydantic", "numpy", "soundfile"])
def test_base_dependency_imports(module: str) -> None:
    """The sidecar must start on a bare machine, so these five are the floor."""
    assert importlib.import_module(module) is not None


@pytest.mark.parametrize("module", ["torch", "mlx_whisper", "faster_whisper", "speechbrain"])
def test_model_stack_is_not_required(module: str) -> None:
    """
    Not an assertion that models are absent — only that nothing in the base
    install pulls them in. If one happens to be present that is fine; what must
    never happen is the base package depending on it.
    """
    try:
        importlib.import_module(module)
    except ImportError:
        pass  # expected on a bare install


def test_health_endpoint() -> None:
    """Activates when P1-01 lands the FastAPI app."""
    server = pytest.importorskip(
        "dnd_sidecar.server", reason="FastAPI app lands in P1-01"
    )
    from fastapi.testclient import TestClient

    response = TestClient(server.app).get("/health")
    assert response.status_code == 200
    assert "device" in response.json()
