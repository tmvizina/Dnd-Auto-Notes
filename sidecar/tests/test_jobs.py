"""Job lifecycle: progress, completion, failure, cancellation, and the gate."""

from __future__ import annotations

import threading
import time

import pytest
from fastapi.testclient import TestClient

from dnd_sidecar import cancel, jobs
from dnd_sidecar.server import app

client = TestClient(app)


@pytest.fixture(autouse=True)
def _clean_registry():
    jobs.reset_for_tests()
    yield
    jobs.reset_for_tests()


def wait_for(job_id: str, statuses: set[str], timeout: float = 5.0) -> dict:
    deadline = time.time() + timeout
    while time.time() < deadline:
        job = jobs.get_job(job_id)
        assert job is not None
        if job["status"] in statuses:
            return job
        time.sleep(0.01)
    raise AssertionError(f"job {job_id} never reached {statuses}")


def test_job_runs_and_result_is_retrievable() -> None:
    job_id = client.post("/jobs/echo", json={"steps": 4}).json()["job_id"]
    job = wait_for(job_id, {"done"})
    assert job["result"] == {"steps": 4}
    assert job["progress"] == 1.0
    assert job["finished_at"] is not None


def test_progress_is_monotonic() -> None:
    seen: list[float] = []

    def run(progress):
        for value in (0.5, 0.2, 0.9):  # deliberately out of order
            progress(value, "step")
            seen.append(jobs.get_job(cancel.current_job())["progress"])
        return "ok"

    job_id = jobs.create_job("probe", run)
    wait_for(job_id, {"done"})
    assert seen == sorted(seen), f"progress went backwards: {seen}"


def test_failure_is_reported_not_raised() -> None:
    job_id = client.post("/jobs/echo", json={"steps": 1, "fail": True}).json()["job_id"]
    job = wait_for(job_id, {"error"})
    assert "echo asked to fail" in job["error"]
    assert job["result"] is None


def test_cancel_stops_the_job_at_its_next_checkpoint() -> None:
    started = threading.Event()

    def run(progress):
        started.set()
        for step in range(500):
            progress(step / 500, "working")
            time.sleep(0.01)
        return "should not finish"

    job_id = jobs.create_job("probe", run)
    assert started.wait(timeout=5)

    assert jobs.cancel_job(job_id) is True
    job = wait_for(job_id, {"cancelled"})
    assert job["result"] is None


def test_cancelling_a_finished_job_reports_false() -> None:
    job_id = client.post("/jobs/echo", json={"steps": 1}).json()["job_id"]
    wait_for(job_id, {"done"})
    assert jobs.cancel_job(job_id) is False


def test_cancel_endpoint_404s_for_an_unknown_job() -> None:
    assert client.post("/jobs/nope/cancel").status_code == 404
    assert client.get("/jobs/nope").status_code == 404


def test_readers_run_concurrently() -> None:
    """Two light jobs must overlap, or a scoring pass serialises for nothing."""
    running = threading.Semaphore(0)
    release = threading.Event()
    overlap = threading.Event()
    active = []
    lock = threading.Lock()

    def run(progress):
        with lock:
            active.append(1)
            if len(active) >= 2:
                overlap.set()
        running.release()
        release.wait(timeout=5)
        with lock:
            active.pop()
        return "ok"

    first = jobs.create_job("probe", run)
    second = jobs.create_job("score", run)
    assert running.acquire(timeout=5)
    assert running.acquire(timeout=5)
    assert overlap.is_set(), "two reader jobs did not run at the same time"

    release.set()
    wait_for(first, {"done"})
    wait_for(second, {"done"})


def test_a_writer_excludes_everything_else() -> None:
    writer_in = threading.Event()
    writer_release = threading.Event()
    reader_ran = threading.Event()

    def writer(progress):
        writer_in.set()
        writer_release.wait(timeout=5)
        return "writer"

    def reader(progress):
        reader_ran.set()
        return "reader"

    writer_id = jobs.create_job("transcribe", writer)  # not a READER_KIND
    assert writer_in.wait(timeout=5)

    reader_id = jobs.create_job("probe", reader)
    # The reader must be held at the gate while the writer holds it.
    assert not reader_ran.wait(timeout=0.3)

    writer_release.set()
    wait_for(writer_id, {"done"})
    wait_for(reader_id, {"done"})
    assert reader_ran.is_set()


def test_jobs_listing_reports_recent_first() -> None:
    first = client.post("/jobs/echo", json={"steps": 1}).json()["job_id"]
    wait_for(first, {"done"})
    second = client.post("/jobs/echo", json={"steps": 1}).json()["job_id"]
    wait_for(second, {"done"})

    listed = [job["job_id"] for job in client.get("/jobs").json()["jobs"]]
    assert listed.index(second) < listed.index(first)
