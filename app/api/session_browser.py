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


@router.post("/session-browser/data")
async def sessions_data(
    request: Request,
    db: Session = Depends(get_db),
):
    body = await request.json()
    start_row = body.get("startRow", 0)
    end_row = body.get("endRow", 100)
    sort_model = body.get("sortModel", [])
    filter_model = body.get("filterModel", {})
    proxy_ids_str = body.get("proxy_ids")
    force_refresh = body.get("force", False)

    target_ids: List[int] = []
    if proxy_ids_str:
        try:
            target_ids = [int(x) for x in proxy_ids_str.split(",") if x.strip()]
        except Exception:
            target_ids = []

    if not target_ids:
        return {"rowCount": 0, "rows": []}

    cfg = _get_cfg(db)
    proxies = db.query(Proxy).filter(Proxy.id.in_(target_ids), Proxy.is_active == True).all()
    proxy_map = {p.id: p for p in proxies}

    # --- Integrated Collect Logic ---
    if force_refresh:
        with ThreadPoolExecutor(max_workers=cfg.max_workers or 4) as executor:
            future_to_proxy_id = {executor.submit(_collect_for_proxy, proxy_map[pid], cfg): pid for pid in target_ids if pid in proxy_map}

            for future in as_completed(future_to_proxy_id):
                proxy_id = future_to_proxy_id[future]
                try:
                    _, records, err = future.result()
                    if not err and records is not None:
                        temp_store.write_batch(proxy_id, now_kst(), records)
                except Exception as e:
                    logger.error(f"Failed to collect session for proxy {proxy_id}: {e}")
        try:
            temp_store.cleanup_old_batches(retain_per_proxy=1)
        except Exception:
            pass
    # --- End Integrated Collect ---

    # Load latest rows from temp_store
    rows = _load_latest_rows_for_proxies(db, target_ids)

    # Filtering
    if filter_model:
        for col, f in filter_model.items():
            query = f.get("filter")
            filter_type = f.get("type")
            if query is None: continue
            query_str = str(query).lower()
            def check(row_val):
                row_val_str = str(row_val or "").lower()
                if filter_type == "contains": return query_str in row_val_str
                elif filter_type == "notContains": return query_str not in row_val_str
                elif filter_type == "equals": return query_str == row_val_str
                elif filter_type == "notEqual": return query_str != row_val_str
                elif filter_type == "startsWith": return row_val_str.startswith(query_str)
                elif filter_type == "endsWith": return row_val_str.endswith(query_str)
                return query_str in row_val_str
            rows = [r for r in rows if check(r.get(col))]

    # Sorting
    if sort_model:
        for s in reversed(sort_model):
            col = s["colId"]
            direction = s["sort"]
            rows.sort(key=lambda r: (r.get(col) is None, r.get(col)), reverse=(direction == "desc"))

    # Pagination
    paginated_rows = rows[start_row:end_row]

    # Assign stable IDs
    for r in paginated_rows:
        pid = int(r.get("proxy_id") or 0)
        collected_iso = str(r.get("collected_at") or "")
        line_index = int(r.get("__line_index") or 0)
        r["id"] = temp_store.build_record_id(pid, collected_iso, line_index)

    return {
        "rows": paginated_rows,
        "rowCount": len(rows),
    }


def _sort_key_func(col_idx: int | None):
    # Mirrors the col_to_key from _filter_rows_by_columns for consistency
    col_to_key = {
        0: "host", 1: "creation_time", 2: "protocol", 3: "user_name",
        4: "client_ip", 5: "server_ip", 6: "cl_bytes_received",
        7: "cl_bytes_sent", 8: "age_seconds", 9: "url",
    }
    key = col_to_key.get(col_idx or 0)
    if not key:
        return lambda r: r.get("id") or 0

    # Handle numeric and date sorting correctly
    if key in ("cl_bytes_received", "cl_bytes_sent", "age_seconds"):
        return lambda r: (r.get(key) is None, r.get(key) or 0)
    elif key == "creation_time":
        def to_ts(v: Any) -> float:
            try:
                return datetime.fromisoformat(str(v)).timestamp() if v else 0
            except (ValueError, TypeError):
                return 0
        return lambda r: (r.get(key) is None, to_ts(r.get(key)))

    # Default to case-insensitive string sort
    return lambda r: (r.get(key) is None, str(r.get(key) or "").lower())


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
