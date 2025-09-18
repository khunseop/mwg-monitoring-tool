import os
import sys
from typing import Optional


def get_base_path() -> str:
    """
    Return the base path for accessing project resources.

    When packaged with PyInstaller, sys._MEIPASS points to the temporary
    extraction directory containing bundled resources. Otherwise, use the
    repository root inferred from this file's location.
    """
    base_path = getattr(sys, "_MEIPASS", None)
    if base_path:
        return base_path  # type: ignore[return-value]
    # In dev, this file lives at <repo>/app/utils/path_resolver.py
    # Use two levels up from this file to reach the repo root.
    return os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))


def resolve_path(*relative_parts: str, must_exist: bool = False) -> str:
    """
    Resolve a path relative to the base path.

    Example: resolve_path("app", "templates")
    """
    path = os.path.join(get_base_path(), *relative_parts)
    if must_exist and not os.path.exists(path):
        raise FileNotFoundError(path)
    return path


def get_templates_dir() -> str:
    return resolve_path("app", "templates", must_exist=False)


def get_static_dir() -> str:
    return resolve_path("app", "static", must_exist=False)


def get_docs_dir() -> str:
    return resolve_path("docs", must_exist=False)

