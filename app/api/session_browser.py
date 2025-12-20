from fastapi import APIRouter, Depends, HTTPException, Query, Request
from fastapi.responses import StreamingResponse
from sqlalchemy.orm import Session
from typing import List, Dict, Any, Tuple, Iterable
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime
from app.utils.time import now_kst, KST_TZ
import re
import warnings
import time
import logging
import io
from openpyxl import Workbook
from openpyxl.styles import Font
try:
    from cryptography.utils import CryptographyDeprecationWarning
    warnings.filterwarnings("ignore", category=CryptographyDeprecationWarning)
except Exception:
    pass
from app.utils.ssh import ssh_exec

from app.database.database import get_db
from app.models.proxy import Proxy
from app.models.session_browser_config import SessionBrowserConfig as SessionBrowserConfigModel
from app.schemas.session_record import (
    SessionRecord as SessionRecordSchema,
    CollectRequest,
    CollectResponse,
)
from app.schemas.session_browser_config import (
    SessionBrowserConfig as SessionBrowserConfigSchema,
)
from app.services.session_browser_config import get_or_create_config as _get_cfg_service
from app.utils.crypto import decrypt_string_if_encrypted
from app.storage import temp_store
from urllib.parse import urlparse


router = APIRouter()
logger = logging.getLogger(__name__)
def _ensure_timestamps(item: Dict[str, Any]) -> Dict[str, Any]:
    out = dict(item)
    collected = out.get("collected_at")
    # Use collected_at if available; otherwise now
    try:
        default_dt = now_kst()
        if collected:
            # Pydantic can parse ISO strings, no need to convert
            out.setdefault("created_at", collected)
            out.setdefault("updated_at", collected)
        else:
            out.setdefault("created_at", default_dt)
            out.setdefault("updated_at", default_dt)
    except Exception:
        pass
    return out


def _get_cfg(db: Session) -> SessionBrowserConfigModel:
    return _get_cfg_service(db)
# Removed DB session query helpers; temp-store mode doesn't use them





def _parse_sessions(output: str) -> List[Dict[str, Any]]:
    lines = [line.strip() for line in output.splitlines() if line.strip()]
    if not lines:
        return []

    # Skip first summary line and second header line if present
    start_idx = 0
    if lines and lines[0].lower().startswith("there are currently"):
        start_idx = 1
    # Detect header in next line by checking for Transaction and URL presence
    if len(lines) > start_idx and "Transaction" in lines[start_idx] and "URL" in lines[start_idx]:
        start_idx += 1

    records: List[Dict[str, Any]] = []
    for line in lines[start_idx:]:
        # split by pipe and trim cells (keep empty tokens)
        parts = [p.strip() for p in line.split("|")]

        if not parts:
            continue

        # Transaction is always at index 0
        transaction = parts[0] if len(parts) > 0 and parts[0] != "" else None

        # Find creation time token within the next few positions (handles extra blank column before it)
        dt_regex = re.compile(r"^\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}:\d{2}$")
        creation_time_idx = None
        for i in range(1, min(6, len(parts))):
            if dt_regex.match(parts[i] or ""):
                creation_time_idx = i
                break

        creation_time = None
        if creation_time_idx is not None:
            ct = parts[creation_time_idx]
            try:
                creation_time = datetime.strptime(ct, "%Y-%m-%d %H:%M:%S").replace(tzinfo=KST_TZ)
            except Exception:
                creation_time = None

        # Columns AFTER creation_time are shifted by (creation_time_idx - 1)
        shift_after = (creation_time_idx - 1) if creation_time_idx is not None else 0

        def get_after(expected_index: int) -> Any:
            idx = expected_index + shift_after
            if 0 <= idx < len(parts):
                value = parts[idx].strip()
                return value if value != "" else None
            return None

        def _to_int(value: Any) -> int | None:
            try:
                if value is None:
                    return None
                value_str = str(value).strip()
                if value_str == "":
                    return None
                return int(value_str)
            except Exception:
                return None

        protocol = get_after(2)
        cust_id = get_after(3)
        user_name = get_after(4)
        client_ip = get_after(5)
        # Normalize client_ip: drop trailing :port for IPv4 forms (e.g., 1.2.3.4:56789)
        def _strip_port(ip: Any) -> Any:
            try:
                s = str(ip or '').strip()
                # Only strip patterns like a.b.c.d:port
                if re.match(r"^\d+\.\d+\.\d+\.\d+:\d+$", s):
                    return s.rsplit(":", 1)[0]
                return s
            except Exception:
                return ip
        client_ip = _strip_port(client_ip)
        client_side_mwg_ip = get_after(6)
        server_side_mwg_ip = get_after(7)
        server_ip = get_after(8)

        # Use raw values as reported
        cl_bytes_received = _to_int(get_after(9))
        cl_bytes_sent = _to_int(get_after(10))
        srv_bytes_received = _to_int(get_after(11))
        srv_bytes_sent = _to_int(get_after(12))
        trxn_index = _to_int(get_after(13))
        age_seconds = _to_int(get_after(14))
        status = get_after(15)
        in_use = _to_int(get_after(16))

        url = get_after(17)
        if not url and parts:
            last = parts[-1]
            if isinstance(last, str) and (last.startswith("http://") or last.startswith("https://")):
                url = last.strip()

        record = {
            "transaction": transaction,
            "creation_time": creation_time,
            "protocol": protocol,
            "cust_id": cust_id,
            "user_name": user_name,
            "client_ip": client_ip,
            "client_side_mwg_ip": client_side_mwg_ip,
            "server_side_mwg_ip": server_side_mwg_ip,
            "server_ip": server_ip,
            "cl_bytes_received": cl_bytes_received,
            "cl_bytes_sent": cl_bytes_sent,
            "srv_bytes_received": srv_bytes_received,
            "srv_bytes_sent": srv_bytes_sent,
            "trxn_index": trxn_index,
            "age_seconds": age_seconds,
            "status": status,
            "in_use": in_use,
            "url": url,
            "raw_line": line,
        }
        records.append(record)

    return records


def _collect_for_proxy(proxy: Proxy, cfg: SessionBrowserConfigModel) -> Tuple[int, List[Dict[str, Any]] | None, str | None]:
    if not proxy.username:
        return proxy.id, None, "Proxy is missing SSH username"
    command = f"{cfg.command_path} {cfg.command_args}".strip()
    try:
        t0 = time.perf_counter()
        stdout_str = ssh_exec(
            host=proxy.host,
            port=cfg.ssh_port or 22,
            username=proxy.username,
            password=decrypt_string_if_encrypted(proxy.password),
            command=command,
            timeout_sec=cfg.timeout_sec or 10,
            auth_timeout_sec=cfg.timeout_sec or 10,
            banner_timeout_sec=cfg.timeout_sec or 10,
            host_key_policy=cfg.host_key_policy or "auto_add",
            look_for_keys=False,
            allow_agent=False,
        )
        t1 = time.perf_counter()
        records = _parse_sessions(stdout_str)
        t2 = time.perf_counter()
        try:
            logger.debug(
                "session-collect-proxy: proxy_id=%s host=%s fetch_ms=%.1f parse_ms=%.1f rows=%d",
                proxy.id,
                proxy.host,
                (t1 - t0) * 1000.0,
                (t2 - t1) * 1000.0,
                len(records or []),
            )
        except Exception:
            pass
        return proxy.id, records, None
    except Exception as e:
        return proxy.id, None, str(e)


@router.post("/session-browser/collect", response_model=CollectResponse)
async def collect_sessions(payload: CollectRequest, db: Session = Depends(get_db)):
    if not payload.proxy_ids or len(payload.proxy_ids) == 0:
        raise HTTPException(status_code=400, detail="proxy_ids is required and cannot be empty")

    cfg = _get_cfg(db)

    query = db.query(Proxy).filter(Proxy.is_active == True).filter(Proxy.id.in_(payload.proxy_ids))
    proxies: List[Proxy] = query.all()
    if not proxies:
        return CollectResponse(requested=0, succeeded=0, failed=0, errors={}, items=[])

    errors: Dict[int, str] = {}

    # Replacement semantics now happen at temp-store level by creating a new batch per proxy
    t_overall_start = time.perf_counter()
    collected_at_ts = now_kst()
    per_proxy_records: Dict[int, List[Dict[str, Any]]] = {}

    t_fetch_parse_start = time.perf_counter()
    with ThreadPoolExecutor(max_workers=cfg.max_workers or 4) as executor:
        future_to_proxy = {executor.submit(_collect_for_proxy, p, cfg): p for p in proxies}
        for future in as_completed(future_to_proxy):
            proxy = future_to_proxy[future]
            try:
                proxy_id, records, err = future.result()
                if err:
                    errors[proxy_id] = err
                    continue
                enriched: List[Dict[str, Any]] = []
                for rec in records or []:
                    row = {
                        "proxy_id": proxy_id,
                        "transaction": rec.get("transaction"),
                        "creation_time": rec.get("creation_time"),
                        "protocol": rec.get("protocol"),
                        "cust_id": rec.get("cust_id"),
                        "user_name": rec.get("user_name"),
                        "client_ip": rec.get("client_ip"),
                        "client_side_mwg_ip": rec.get("client_side_mwg_ip"),
                        "server_side_mwg_ip": rec.get("server_side_mwg_ip"),
                        "server_ip": rec.get("server_ip"),
                        "cl_bytes_received": rec.get("cl_bytes_received"),
                        "cl_bytes_sent": rec.get("cl_bytes_sent"),
                        "srv_bytes_received": rec.get("srv_bytes_received"),
                        "srv_bytes_sent": rec.get("srv_bytes_sent"),
                        "trxn_index": rec.get("trxn_index"),
                        "age_seconds": rec.get("age_seconds"),
                        "status": rec.get("status"),
                        "in_use": rec.get("in_use"),
                        "url": rec.get("url"),
                        "raw_line": rec.get("raw_line"),
                        # enrich for UI convenience
                        "host": proxy.host,
                    }
                    enriched.append(row)
                per_proxy_records[proxy_id] = enriched
            except Exception as e:
                errors[proxy.id] = str(e)

    t_fetch_parse_end = time.perf_counter()

    # Write temp batches per proxy for real-time use
    t_tmp_write_start = time.perf_counter()
    total_written = 0
    for pid, rows in per_proxy_records.items():
        try:
            temp_store.write_batch(pid, collected_at_ts, rows)
            total_written += len(rows or [])
        except Exception as e:
            errors[pid] = str(e)
    t_tmp_write_end = time.perf_counter()

    # Keep only the latest batch per proxy to avoid accumulation
    try:
        temp_store.cleanup_old_batches(retain_per_proxy=1)
    except Exception:
        pass

    logger.info(
        "session-collect: proxies=%d ok=%d fail=%d records=%d delete_ms=%.1f fetch_parse_ms=%.1f db_insert_ms=%.1f total_ms=%.1f",
        len(proxies),
        len(proxies) - len(errors),
        len(errors),
        total_written,
        0.0,
        (t_fetch_parse_end - t_fetch_parse_start) * 1000.0,
        (t_tmp_write_end - t_tmp_write_start) * 1000.0,
        (time.perf_counter() - t_overall_start) * 1000.0,
    )

    return CollectResponse(
        requested=len(proxies),
        succeeded=len(proxies) - len(errors),
        failed=len(errors),
        errors=errors,
        # Keep payload light; UI reloads from server-side table anyway
        items=[],
    )


@router.get("/session-browser", response_model=List[SessionRecordSchema])
async def list_sessions(
    db: Session = Depends(get_db),
    limit: int = Query(100, ge=1, le=1000),
    offset: int = Query(0, ge=0),
):
    # Aggregate latest batches across all proxies
    rows: List[Dict[str, Any]] = []
    proxies = db.query(Proxy).filter(Proxy.is_active == True).all()
    for p in proxies:
        latest = temp_store.read_latest(p.id)
        for idx, rec in enumerate(latest):
            item = dict(rec)
            item.setdefault("proxy_id", p.id)
            # build stable numeric id: proxy + collected_at + line index
            rid = temp_store.build_record_id(p.id, str(item.get("collected_at") or ""), idx)
            item["id"] = rid
            rows.append(_ensure_timestamps(item))
    # Sort by collected_at desc then id asc
    def _to_sort_ts(v: Any) -> float:
        try:
            if not v:
                return 0.0
            return datetime.fromisoformat(str(v)).timestamp()
        except Exception:
            return 0.0
    rows.sort(key=lambda r: (_to_sort_ts(r.get("collected_at")), r.get("id") or 0), reverse=True)
    sliced = rows[offset:offset + limit]
    return [SessionRecordSchema(**r) for r in sliced]


@router.get("/session-browser/latest/{proxy_id}", response_model=List[SessionRecordSchema])
async def latest_sessions(proxy_id: int, db: Session = Depends(get_db)):
    latest = temp_store.read_latest(proxy_id)
    out: List[SessionRecordSchema] = []
    for idx, rec in enumerate(latest):
        r = dict(rec)
        r.setdefault("proxy_id", proxy_id)
        rid = temp_store.build_record_id(proxy_id, str(r.get("collected_at") or ""), idx)
        r["id"] = rid
        out.append(SessionRecordSchema(**_ensure_timestamps(r)))
    return out


 


# DataTables server-side endpoint for large datasets
def _load_latest_rows_for_proxies(db: Session, target_ids: List[int]) -> List[Dict[str, Any]]:
    host_map: Dict[int, str] = {}
    if target_ids:
        for p in db.query(Proxy).filter(Proxy.id.in_(target_ids)).all():
            host_map[p.id] = p.host
    
    def _read_and_process_proxy(pid: int) -> List[Dict[str, Any]]:
        """Read and process records for a single proxy"""
        batch = temp_store.read_latest(pid)
        proxy_rows: List[Dict[str, Any]] = []
        for idx, rec in enumerate(batch):
            r = dict(rec)
            r.setdefault("proxy_id", pid)
            r.setdefault("host", host_map.get(pid, f"#{pid}"))
            r["__line_index"] = idx
            # Normalize client_ip by dropping ephemeral port if present
            try:
                cip = r.get("client_ip")
                if isinstance(cip, str) and re.match(r"^\d+\.\d+\.\d+\.\d+:\d+$", cip.strip()):
                    r["client_ip"] = cip.strip().rsplit(":", 1)[0]
            except Exception:
                pass
            proxy_rows.append(r)
        return proxy_rows
    
    # Read from multiple proxies in parallel using ThreadPoolExecutor
    rows: List[Dict[str, Any]] = []
    if len(target_ids) > 1:
        # Use parallel reading for multiple proxies
        with ThreadPoolExecutor(max_workers=min(len(target_ids), 8)) as executor:
            futures = {executor.submit(_read_and_process_proxy, pid): pid for pid in target_ids}
            for future in as_completed(futures):
                try:
                    proxy_rows = future.result()
                    rows.extend(proxy_rows)
                except Exception as e:
                    pid = futures[future]
                    logger.warning(f"[session_browser] Failed to load data for proxy {pid}: {e}")
    else:
        # Single proxy: no need for parallel processing
        for pid in target_ids:
            try:
                proxy_rows = _read_and_process_proxy(pid)
                rows.extend(proxy_rows)
            except Exception as e:
                logger.warning(f"[session_browser] Failed to load data for proxy {pid}: {e}")
    
    return rows


def _filter_rows(rows: List[Dict[str, Any]], search: str | None) -> List[Dict[str, Any]]:
    if not search:
        return rows
    s = str(search).lower()
    def include(row: Dict[str, Any]) -> bool:
        for key in ("transaction", "user_name", "client_ip", "server_ip", "protocol", "status", "url", "host"):
            val = row.get(key)
            if val is not None and s in str(val).lower():
                return True
        return False
    return [r for r in rows if include(r)]


def _filter_rows_by_columns(rows: List[Dict[str, Any]], per_col: Dict[int, str]) -> List[Dict[str, Any]]:
    """Apply DataTables-style per-column text filters.

    The mapping of column index to row key must mirror the client-side columns order.
    Only simple substring matching is applied for now to keep behavior predictable.
    """
    if not per_col:
        return rows
    # Column index mapping (0-based) aligned with session_browser.js `columns` order
    col_to_key = {
        0: "host",
        1: "creation_time",
        2: "protocol",
        3: "user_name",
        4: "client_ip",
        5: "server_ip",
        6: "cl_bytes_received",
        7: "cl_bytes_sent",
        8: "age_seconds",
        9: "url",
        # 10: id (hidden) -> ignore for filtering
    }
    out: List[Dict[str, Any]] = []
    for row in rows:
        include = True
        for col_idx, query in per_col.items():
            if col_idx == 10:
                continue
            key = col_to_key.get(col_idx)
            if not key:
                continue
            q = (str(query or "")).strip()
            if q == "":
                continue
            val = row.get(key)
            text = str(val if val is not None else "")
            # Case-insensitive substring match
            if q.lower() not in text.lower():
                include = False
                break
        if include:
            out.append(row)
    return out


def _sort_key_func(order_col: int | None):
    def sort_key(row: Dict[str, Any]):
        # This mapping must match the order of columns in the DataTables `columns` option
        mapping = {
            0: (row.get("host") or ""),
            1: row.get("creation_time") or "",
            2: (row.get("protocol") or ""),
            3: row.get("user_name") or "",
            4: row.get("client_ip") or "",
            5: row.get("server_ip") or "",
            6: row.get("cl_bytes_received") or -1,
            7: row.get("cl_bytes_sent") or -1,
            8: row.get("age_seconds") or -1,
            9: (row.get("url") or ""),
            10: 0,  # id column, not sortable
        }
        return mapping.get(order_col or 1)
    return sort_key


@router.get("/session-browser/datatables")
async def sessions_datatables(
    request: Request,
    db: Session = Depends(get_db),
    startRow: int = Query(0, ge=0, alias="startRow"),
    endRow: int = Query(100, ge=1, alias="endRow"),
    sortModel: str | None = Query(None, alias="sortModel"),
    filterModel: str | None = Query(None, alias="filterModel"),
    group_id: int | None = Query(None),
    proxy_ids: str | None = Query(None),  # comma-separated
):
    # Require explicit selection: if no proxy_ids provided, return empty dataset
    target_ids: List[int] = []
    if proxy_ids:
        try:
            target_ids = [int(x) for x in proxy_ids.split(",") if x.strip()]
        except Exception:
            target_ids = []
    if not target_ids:
        return {"rowData": [], "rowCount": 0}

    # Load latest rows
    rows = _load_latest_rows_for_proxies(db, target_ids)

    records_total = len(rows)
    filtered = rows

    # Parse filterModel (ag-grid format: JSON string)
    if filterModel:
        try:
            import json
            filter_dict = json.loads(filterModel)
            # Apply filters from filterModel
            for col_id, filter_config in filter_dict.items():
                if isinstance(filter_config, dict) and "filter" in filter_config:
                    filter_value = str(filter_config.get("filter", "")).strip().lower()
                    if filter_value:
                        # Map column IDs to row keys
                        col_to_key = {
                            "host": "host",
                            "creation_time": "creation_time",
                            "protocol": "protocol",
                            "user_name": "user_name",
                            "client_ip": "client_ip",
                            "server_ip": "server_ip",
                            "cl_bytes_received": "cl_bytes_received",
                            "cl_bytes_sent": "cl_bytes_sent",
                            "age_seconds": "age_seconds",
                            "url": "url",
                        }
                        key = col_to_key.get(col_id)
                        if key:
                            filtered = [
                                r for r in filtered
                                if key in r and filter_value in str(r.get(key, "")).lower()
                            ]
        except Exception:
            pass

    # Apply global quick filter if present (ag-grid quickFilterText)
    quick_filter = request.query_params.get("quickFilterText")
    if quick_filter:
        filtered = _filter_rows(filtered, quick_filter)

    records_filtered = len(filtered)

    # Parse sortModel (ag-grid format: JSON string)
    if sortModel:
        try:
            import json
            sort_list = json.loads(sortModel)
            if isinstance(sort_list, list) and len(sort_list) > 0:
                sort_item = sort_list[0]
                col_id = sort_item.get("colId", "")
                sort_dir = sort_item.get("sort", "asc")
                # Map column IDs to sort keys
                col_to_sort_key = {
                    "host": lambda r: (r.get("host") or ""),
                    "creation_time": lambda r: r.get("creation_time") or "",
                    "protocol": lambda r: (r.get("protocol") or ""),
                    "user_name": lambda r: r.get("user_name") or "",
                    "client_ip": lambda r: r.get("client_ip") or "",
                    "server_ip": lambda r: r.get("server_ip") or "",
                    "cl_bytes_received": lambda r: r.get("cl_bytes_received") or -1,
                    "cl_bytes_sent": lambda r: r.get("cl_bytes_sent") or -1,
                    "age_seconds": lambda r: r.get("age_seconds") or -1,
                    "url": lambda r: (r.get("url") or ""),
                }
                sort_key_func = col_to_sort_key.get(col_id)
                if sort_key_func:
                    reverse = sort_dir.lower() == "desc"
                    filtered.sort(key=sort_key_func, reverse=reverse)
        except Exception:
            pass

    # Pagination
    page_size = endRow - startRow
    page = filtered[startRow:endRow]

    # Build ag-grid row data (object format, not array)
    row_data: List[Dict[str, Any]] = []
    for rec in page:
        host = rec.get("host") or f"#{rec.get('proxy_id')}"
        ct_str = rec.get("creation_time") or ""
        cl_recv = rec.get("cl_bytes_received")
        cl_sent = rec.get("cl_bytes_sent")
        age_val = rec.get("age_seconds")
        url_full = rec.get("url") or ""
        # Use stored '__line_index' if present; else 0
        pid = int(rec.get("proxy_id") or 0)
        collected_iso = str(rec.get("collected_at") or "")
        line_index = int(rec.get("__line_index") or 0)
        rid_val = temp_store.build_record_id(pid, collected_iso, line_index)
        # Ensure client_ip without port for display
        try:
            cip = rec.get("client_ip") or ""
            if isinstance(cip, str) and re.match(r"^\d+\.\d+\.\d+\.\d+:\d+$", cip.strip()):
                cip = cip.strip().rsplit(":", 1)[0]
        except Exception:
            cip = rec.get("client_ip") or ""
        
        row_data.append({
            "host": host,
            "creation_time": ct_str,
            "protocol": rec.get("protocol") or "",
            "user_name": rec.get("user_name") or "",
            "client_ip": cip,
            "server_ip": rec.get("server_ip") or "",
            "cl_bytes_received": cl_recv,
            "cl_bytes_sent": cl_sent,
            "age_seconds": age_val,
            "url": url_full,
            "id": rid_val,
        })

    return {
        "rowData": row_data,
        "rowCount": records_filtered,
    }


@router.get("/session-browser/item/{record_id}")
async def get_session_record(record_id: int, db: Session = Depends(get_db)):
    item = temp_store.read_item_by_id(record_id)
    if not item:
        raise HTTPException(status_code=404, detail="Record not found")
    item = dict(item)
    item["id"] = record_id
    return _ensure_timestamps(item)


@router.get("/session-browser/export")
async def sessions_export(
    db: Session = Depends(get_db),
    search: str | None = Query(None, alias="search[value]"),
    order_col: int | None = Query(None, alias="order[0][column]"),
    order_dir: str | None = Query(None, alias="order[0][dir]"),
    group_id: int | None = Query(None),
    proxy_ids: str | None = Query(None),  # comma-separated
):
    # Create an Excel workbook in memory
    wb = Workbook()
    ws = wb.active
    ws.title = "Sessions"

    # Define headers
    headers = [
        "id", "프록시", "수집시각", "트랜잭션", "생성시각", "프로토콜", "Cust ID", "사용자",
        "클라이언트 IP", "Client-side MWG IP", "Server-side MWG IP", "서버 IP",
        "CL 수신(Bytes)", "CL 송신(Bytes)", "서버 수신(Bytes)", "서버 송신(Bytes)",
        "Trxn Index", "Age(s)", "상태", "In Use", "URL",
    ]
    ws.append(headers)
    for cell in ws[1]:
        cell.font = Font(bold=True)

    # Require explicit selection
    target_ids: List[int] = []
    if proxy_ids:
        try:
            target_ids = [int(x) for x in proxy_ids.split(",") if x.strip()]
        except Exception:
            target_ids = []

    if target_ids:
        # Load rows
        rows = _load_latest_rows_for_proxies(db, target_ids)
        for r in rows:
            pid = int(r.get("proxy_id") or 0)
            idx = int(r.get("__line_index") or 0)
            r["id"] = temp_store.build_record_id(pid, str(r.get("collected_at") or ""), idx)

        # Filter
        filtered = _filter_rows(rows, search)

        # Order similarly to datatables
        reverse = (order_dir or "desc").lower() == "desc"
        try:
            filtered.sort(key=_sort_key_func(order_col), reverse=reverse)
        except Exception:
            pass

        def to_kst_str(val: Any) -> str:
            try:
                if not val: return ""
                dt = val if isinstance(val, datetime) else datetime.fromisoformat(str(val))
                return dt.astimezone(KST_TZ).strftime("%Y-%m-%d %H:%M:%S")
            except (ValueError, TypeError):
                return str(val or "")

        # Write data rows
        for idx, rec in enumerate(filtered, start=1):
            host = rec.get("host") or f"#{rec.get('proxy_id')}"
            collected_str = to_kst_str(rec.get("collected_at"))
            creation_str = to_kst_str(rec.get("creation_time"))

            try:
                cip = rec.get("client_ip") or ""
                if isinstance(cip, str) and re.match(r"^\d+\.\d+\.\d+\.\d+:\d+$", cip.strip()):
                    cip = cip.strip().rsplit(":", 1)[0]
            except Exception:
                cip = rec.get("client_ip") or ""

            row_data = [
                idx, host, collected_str, rec.get("transaction"), creation_str,
                rec.get("protocol"), rec.get("cust_id"), rec.get("user_name"), cip,
                rec.get("client_side_mwg_ip"), rec.get("server_side_mwg_ip"),
                rec.get("server_ip"), rec.get("cl_bytes_received"), rec.get("cl_bytes_sent"),
                rec.get("srv_bytes_received"), rec.get("srv_bytes_sent"),
                rec.get("trxn_index"), rec.get("age_seconds"), rec.get("status"),
                rec.get("in_use"), rec.get("url"),
            ]
            ws.append(row_data)

    # Save to a virtual file
    virtual_workbook = io.BytesIO()
    wb.save(virtual_workbook)
    virtual_workbook.seek(0)

    filename = f"sessions_export_{datetime.now().strftime('%Y%m%d_%H%M%S')}.xlsx"

    return StreamingResponse(
        virtual_workbook,
        media_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        headers={"Content-Disposition": f"attachment; filename=\"{filename}\""}
    )


@router.get("/session-browser/analyze")
async def sessions_analyze(
    db: Session = Depends(get_db),
    proxy_ids: str | None = Query(None, description="comma-separated proxy ids"),
    topN: int = Query(20, ge=1, le=100),
):
    # Parse target proxy ids
    target_ids: List[int] = []
    if proxy_ids:
        try:
            target_ids = [int(x) for x in proxy_ids.split(",") if x.strip()]
        except Exception:
            target_ids = []
    if not target_ids:
        raise HTTPException(status_code=400, detail="proxy_ids required")

    # Load latest batches
    rows: List[Dict[str, Any]] = _load_latest_rows_for_proxies(db, target_ids)

    # Get unique hostnames from the loaded rows
    target_hosts = sorted(list(set([row.get("host") for row in rows if row.get("host")])))

    # Aggregations
    from collections import Counter, defaultdict

    host_counter: Counter[str] = Counter()
    url_counter: Counter[str] = Counter()
    client_req_counter: Counter[str] = Counter()
    client_cl_recv_bytes: defaultdict[str, int] = defaultdict(int)
    client_cl_sent_bytes: defaultdict[str, int] = defaultdict(int)
    host_srv_recv_bytes: defaultdict[str, int] = defaultdict(int)
    host_srv_sent_bytes: defaultdict[str, int] = defaultdict(int)

    total_recv = 0
    total_sent = 0
    unique_clients: set[str] = set()
    unique_hosts: set[str] = set()
    earliest_dt = None
    latest_dt = None

    def _parse_host(url_val: Any) -> str:
        try:
            s = str(url_val or "").strip()
            if not s:
                return ""
            pu = urlparse(s)
            return pu.hostname or ""
        except Exception:
            return ""

    def _strip_port_val(val: Any) -> str:
        try:
            s = str(val or "").strip()
            if re.match(r"^\d+\.\d+\.\d+\.\d+:\d+$", s):
                return s.rsplit(":", 1)[0]
            return s
        except Exception:
            return str(val or "")

    for rec in rows:
        client_ip = _strip_port_val(rec.get("client_ip"))
        url_full = rec.get("url")
        url_host = _parse_host(url_full)
        recv_b = rec.get("cl_bytes_received") or 0
        sent_b = rec.get("cl_bytes_sent") or 0
        srv_recv_b = rec.get("srv_bytes_received") or 0
        srv_sent_b = rec.get("srv_bytes_sent") or 0
        ct = rec.get("creation_time") or rec.get("collected_at")

        if client_ip:
            client_req_counter[client_ip] += 1
            unique_clients.add(client_ip)
        if url_host:
            host_counter[url_host] += 1
            unique_hosts.add(url_host)
        if url_full:
            try:
                key = str(url_full)[:2048]
                url_counter[key] += 1
            except Exception:
                pass

        if client_ip and isinstance(recv_b, int):
            v = max(0, recv_b)
            client_cl_recv_bytes[client_ip] += v
            total_recv += v
        if client_ip and isinstance(sent_b, int):
            v = max(0, sent_b)
            client_cl_sent_bytes[client_ip] += v
            total_sent += v
        if url_host and isinstance(srv_recv_b, int):
            host_srv_recv_bytes[url_host] += max(0, srv_recv_b)
        if url_host and isinstance(srv_sent_b, int):
            host_srv_sent_bytes[url_host] += max(0, srv_sent_b)

        # time range by creation_time if available, else collected_at
        if ct:
            try:
                dt = datetime.fromisoformat(str(ct))
                if earliest_dt is None or dt < earliest_dt:
                    earliest_dt = dt
                if latest_dt is None or dt > latest_dt:
                    latest_dt = dt
            except Exception:
                pass

    def top_n(counter_like, n: int):
        try:
            return counter_like.most_common(n)
        except AttributeError:
            items = list(counter_like.items())
            items.sort(key=lambda kv: kv[1], reverse=True)
            return items[:n]

    # Build top sections with data-centric keys; keep old keys for backward compatibility
    result = {
        "analyzed_at": now_kst().isoformat(),
        "target_hosts": target_hosts,
        "summary": {
            "total_sessions": len(rows),
            "unique_clients": len(unique_clients),
            "unique_hosts": len(unique_hosts),
            "total_recv_bytes": total_recv,
            "total_sent_bytes": total_sent,
            "time_range_start": (earliest_dt.isoformat() if earliest_dt else None),
            "time_range_end": (latest_dt.isoformat() if latest_dt else None),
        },
        "top": {
            "hosts_by_requests": top_n(host_counter, topN),
            "urls_by_requests": top_n(url_counter, topN),
            "clients_by_requests": top_n(client_req_counter, topN),
            # New keys
            "clients_by_cl_recv_bytes": top_n(client_cl_recv_bytes, topN),
            "clients_by_cl_sent_bytes": top_n(client_cl_sent_bytes, topN),
            "hosts_by_srv_recv_bytes": top_n(host_srv_recv_bytes, topN),
            "hosts_by_srv_sent_bytes": top_n(host_srv_sent_bytes, topN),
            # Backward-compat keys
            "clients_by_download_bytes": top_n(client_cl_recv_bytes, topN),
            "clients_by_upload_bytes": top_n(client_cl_sent_bytes, topN),
            "hosts_by_download_bytes": top_n(host_srv_recv_bytes, topN),
            "hosts_by_upload_bytes": top_n(host_srv_sent_bytes, topN),
        },
    }

    return result
