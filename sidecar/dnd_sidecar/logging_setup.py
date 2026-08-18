"""Structured JSON logs on stdout, carrying the job id on every line.

The Node supervisor tails this file; plain text would mean parsing prose to
answer "which job failed".
"""

from __future__ import annotations

import json
import logging
import sys
from typing import Any

from . import cancel


class JsonFormatter(logging.Formatter):
    def format(self, record: logging.LogRecord) -> str:
        payload: dict[str, Any] = {
            "ts": self.formatTime(record, "%Y-%m-%dT%H:%M:%S%z"),
            "level": record.levelname.lower(),
            "logger": record.name,
            "message": record.getMessage(),
        }
        job_id = getattr(record, "job_id", None) or cancel.current_job()
        if job_id:
            payload["job_id"] = job_id
        if record.exc_info:
            payload["exception"] = self.formatException(record.exc_info)
        for key, value in getattr(record, "extra_fields", {}).items():
            payload[key] = value
        return json.dumps(payload, default=str)


def configure(level: int = logging.INFO) -> None:
    handler = logging.StreamHandler(sys.stdout)
    handler.setFormatter(JsonFormatter())
    root = logging.getLogger()
    root.handlers = [handler]
    root.setLevel(level)
