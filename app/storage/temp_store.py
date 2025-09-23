import os
import json
import tempfile
import threading
from datetime import datetime
from typing import Any, Dict, Iterable, List, Optional, Tuple

from app.utils.time import KST_TZ

_io_lock = threading.Lock()

# Bit layout for synthetic numeric record IDs
# [ proxy_id (20 bits) | collected_at_unix_sec (32 bits) | line_index (12 bits) ]
_PROXY_BITS = 20
_TS_BITS = 32
_INDEX_BITS = 12
_INDEX_MASK = (1 << _INDEX_BITS) - 1
_TS_MASK = (1 << _TS_BITS) - 1


def _get_base_tmp_dir() -> str:
    base = os.getenv("SESSION_TMP_DIR") or os.path.join(tempfile.gettempdir(), "session_browser")
    os.makedirs(base, exist_ok=True)
    return base


def _proxy_dir(proxy_id: int) -> str:
    base = _get_base_tmp_dir()
    path = os.path.join(base, f"proxy_{proxy_id}")
    os.makedirs(path, exist_ok=True)
    return path


def _batch_filename(collected_at: datetime) -> str:
    # Use KST timestamp for consistency with app
    ts = collected_at.astimezone(KST_TZ).strftime("%Y%m%dT%H%M%S")
    return f"batch_{ts}.jsonl"


def write_batch(proxy_id: int, collected_at: datetime, records: List[Dict[str, Any]]) -> str:
    """
    Write a batch of records for a proxy as JSON Lines to a temp file.
    Returns the absolute file path written.
    """
    directory = _proxy_dir(proxy_id)
    filename = _batch_filename(collected_at)
    path = os.path.join(directory, filename)
    payload: List[Dict[str, Any]] = []
    for rec in records:
        item = dict(rec)
        # Ensure proxy_id and collected_at are present and serializable
        item["proxy_id"] = proxy_id
        item["collected_at"] = collected_at.astimezone(KST_TZ).isoformat()
        ct = item.get("creation_time")
        if isinstance(ct, datetime):
            item["creation_time"] = ct.astimezone(KST_TZ).isoformat()
        payload.append(item)
    with _io_lock:
        with open(path, "w", encoding="utf-8") as f:
            for row in payload:
                f.write(json.dumps(row, ensure_ascii=False))
                f.write("\n")
    # Also update a latest pointer for quick reads
    latest_link = os.path.join(directory, "latest")
    try:
        with _io_lock:
            with open(latest_link, "w", encoding="utf-8") as f:
                f.write(os.path.basename(path))
    except Exception:
        pass
    return path


def _iter_jsonl(path: str) -> Iterable[Dict[str, Any]]:
    with open(path, "r", encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            try:
                yield json.loads(line)
            except Exception:
                continue


def list_batches(proxy_id: Optional[int] = None) -> List[Tuple[int, str]]:
    """
    Return list of (proxy_id, batch_path) for available batches.
    """
    base = _get_base_tmp_dir()
    results: List[Tuple[int, str]] = []
    try:
        dirs = [d for d in os.listdir(base) if d.startswith("proxy_")]
    except FileNotFoundError:
        return []
    for d in dirs:
        try:
            pid = int(d.split("_")[1])
        except Exception:
            continue
        if proxy_id is not None and pid != proxy_id:
            continue
        pdir = os.path.join(base, d)
        try:
            for fn in os.listdir(pdir):
                if fn.startswith("batch_") and fn.endswith(".jsonl"):
                    results.append((pid, os.path.join(pdir, fn)))
        except Exception:
            continue
    # Newest first by filename timestamp
    results.sort(key=lambda t: os.path.basename(t[1]), reverse=True)
    return results


def read_latest(proxy_id: int) -> List[Dict[str, Any]]:
    """
    Return records from the latest batch for a proxy. Empty list if none.
    """
    directory = _proxy_dir(proxy_id)
    latest_link = os.path.join(directory, "latest")
    path: Optional[str] = None
    try:
        with open(latest_link, "r", encoding="utf-8") as f:
            fn = f.read().strip()
            if fn:
                path = os.path.join(directory, fn)
    except Exception:
        pass
    if not path or not os.path.exists(path):
        batches = list_batches(proxy_id)
        if batches:
            _, path = batches[0]
    if not path or not os.path.exists(path):
        return []
    return list(_iter_jsonl(path))


def _iso_to_unix_seconds(iso_str: str) -> int:
    try:
        dt = datetime.fromisoformat(iso_str)
        # Ensure timezone-aware in KST for consistency, then convert to UTC timestamp
        if dt.tzinfo is None:
            dt = dt.replace(tzinfo=KST_TZ)
        return int(dt.timestamp())
    except Exception:
        return 0


def build_record_id(proxy_id: int, collected_at_iso: str, line_index: int) -> int:
    ts_sec = _iso_to_unix_seconds(collected_at_iso) & _TS_MASK
    pid = proxy_id & ((1 << _PROXY_BITS) - 1)
    idx = line_index & _INDEX_MASK
    return (pid << (_TS_BITS + _INDEX_BITS)) | (ts_sec << _INDEX_BITS) | idx


def _decode_record_id(record_id: int) -> Tuple[int, int, int]:
    idx = record_id & _INDEX_MASK
    ts_sec = (record_id >> _INDEX_BITS) & _TS_MASK
    pid = record_id >> (_TS_BITS + _INDEX_BITS)
    return int(pid), int(ts_sec), int(idx)


def _ts_to_batch_name(ts_sec: int) -> str:
    dt = datetime.fromtimestamp(ts_sec, tz=KST_TZ)
    return _batch_filename(dt)


def read_item_by_id(record_id: int) -> Optional[Dict[str, Any]]:
    pid, ts_sec, idx = _decode_record_id(record_id)
    directory = _proxy_dir(pid)
    batch_name = _ts_to_batch_name(ts_sec)
    path = os.path.join(directory, batch_name)
    if not os.path.exists(path):
        return None
    try:
        for line_no, obj in enumerate(_iter_jsonl(path)):
            if line_no == idx:
                # Attach essential identifiers
                item = dict(obj)
                item.setdefault("proxy_id", pid)
                return item
    except Exception:
        return None
    return None


def query_for_datatables(
    group_filter: Optional[int],
    proxy_ids: Optional[List[int]],
    search: Optional[str],
    order_col: Optional[int],
    order_dir: Optional[str],
    start: int,
    length: int,
) -> Tuple[int, int, List[List[Any]]]:
    """
    Provide a DataTables-like query result directly from temp files.
    Returns (records_total, records_filtered, data_rows)
    """
    # Note: group_filter unsupported without DB join; we just ignore it.
    target_proxies = proxy_ids or []
    if not target_proxies:
        # If not specified, include all proxies we have batches for
        target_proxies = sorted(set(pid for pid, _ in list_batches()))
    rows: List[Dict[str, Any]] = []
    for pid in target_proxies:
        rows.extend(read_latest(pid))

    records_total = len(rows)

    # Apply search filter (simple contains over several fields)
    def include(row: Dict[str, Any]) -> bool:
        if not search:
            return True
        s = str(search).lower()
        for key in ("transaction", "user_name", "client_ip", "server_ip", "protocol", "status", "url"):
            val = row.get(key)
            if val is not None and s in str(val).lower():
                return True
        return False

    filtered = [r for r in rows if include(r)]
    records_filtered = len(filtered)

    # Prepare sort key similar to backend mapping
    def sort_key(row: Dict[str, Any]) -> Any:
        mapping = {
            0: (row.get("host") or ""),
            1: row.get("creation_time") or "",
            2: row.get("user_name") or "",
            3: row.get("client_ip") or "",
            4: row.get("server_ip") or "",
            5: row.get("cl_bytes_received") or -1,
            6: row.get("cl_bytes_sent") or -1,
            7: row.get("age_seconds") or -1,
            8: row.get("url") or "",
            9: row.get("id") or 0,
        }
        return mapping.get(order_col or 1)

    reverse = (order_dir or "desc").lower() == "desc"
    try:
        filtered.sort(key=sort_key, reverse=reverse)
    except Exception:
        pass

    # Build DataTables rows
    data: List[List[Any]] = []
    for rec in filtered[start:start + length]:
        ct = rec.get("creation_time") or ""
        cl_recv = rec.get("cl_bytes_received")
        cl_sent = rec.get("cl_bytes_sent")
        age = rec.get("age_seconds")
        url = rec.get("url") or ""
        url_short = url[:100] + ("…" if len(url) > 100 else "")
        data.append([
            f"#{rec.get('proxy_id')}",
            ct,
            rec.get("user_name") or "",
            rec.get("client_ip") or "",
            rec.get("server_ip") or "",
            str(cl_recv) if cl_recv is not None else "",
            str(cl_sent) if cl_sent is not None else "",
            str(age) if isinstance(age, int) and age >= 0 else "",
            url_short,
            rec.get("id") or 0,
        ])

    return records_total, records_filtered, data

