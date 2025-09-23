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
try:
    from cryptography.utils import CryptographyDeprecationWarning
    warnings.filterwarnings("ignore", category=CryptographyDeprecationWarning)
except Exception:
    pass
import paramiko

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
    SessionBrowserConfigUpdateSafe,
)
from app.utils.crypto import decrypt_string_if_encrypted
from app.storage import temp_store


router = APIRouter()
logger = logging.getLogger(__name__)


def _get_cfg(db: Session) -> SessionBrowserConfigModel:
    cfg = db.query(SessionBrowserConfigModel).order_by(SessionBrowserConfigModel.id.asc()).first()
    if not cfg:
        cfg = SessionBrowserConfigModel()
        db.add(cfg)
        db.commit()
        db.refresh(cfg)
    return cfg
# Removed DB session query helpers; temp-store mode doesn't use them



def _exec_ssh_command(host: str, username: str, password: str | None, port: int, command: str, timeout_sec: int) -> str:
    client = paramiko.SSHClient()
    # Host key policy will be set by caller
    try:
        client.connect(
            hostname=host,
            port=port,
            username=username,
            password=password,
            timeout=timeout_sec,
            auth_timeout=timeout_sec,
            banner_timeout=timeout_sec,
            disabled_algorithms={"cipher": ["3des-cbc", "des-cbc"]},
        )
        stdin, stdout, stderr = client.exec_command(command, timeout=timeout_sec)
        stdout_str = stdout.read().decode(errors="ignore")
        stderr_str = stderr.read().decode(errors="ignore")
        if stderr_str and not stdout_str:
            # Some commands may print warnings to stderr but still succeed. Prefer stdout when available.
            raise RuntimeError(stderr_str.strip())
        return stdout_str
    finally:
        try:
            client.close()
        except Exception:
            pass


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
        client_side_mwg_ip = get_after(6)
        server_side_mwg_ip = get_after(7)
        server_ip = get_after(8)

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
        client = paramiko.SSHClient()
        if (cfg.host_key_policy or "auto_add").lower() == "reject":
            client.set_missing_host_key_policy(paramiko.RejectPolicy())
        else:
            client.set_missing_host_key_policy(paramiko.AutoAddPolicy())
        try:
            client.connect(
                hostname=proxy.host,
                port=cfg.ssh_port or 22,
                username=proxy.username,
                password=decrypt_string_if_encrypted(proxy.password),
                timeout=cfg.timeout_sec or 10,
                auth_timeout=cfg.timeout_sec or 10,
                banner_timeout=cfg.timeout_sec or 10,
                look_for_keys=False,
                allow_agent=False,
                disabled_algorithms={"cipher": ["3des-cbc", "des-cbc"]},
            )
            stdin, stdout, stderr = client.exec_command(command, timeout=cfg.timeout_sec or 10)
            stdout_str = stdout.read().decode(errors="ignore")
            stderr_str = stderr.read().decode(errors="ignore")
            if stderr_str and not stdout_str:
                raise RuntimeError(stderr_str.strip())
        finally:
            try:
                client.close()
            except Exception:
                pass
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
            rows.append(item)
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
        out.append(SessionRecordSchema(**r))
    return out


@router.get("/session-browser/config", response_model=SessionBrowserConfigSchema)
def get_session_browser_config(db: Session = Depends(get_db)):
    cfg = _get_cfg(db)
    return SessionBrowserConfigSchema(
        id=cfg.id,
        ssh_port=cfg.ssh_port,
        command_path=cfg.command_path,
        command_args=cfg.command_args,
        timeout_sec=cfg.timeout_sec,
        host_key_policy=cfg.host_key_policy,
        max_workers=cfg.max_workers,
        created_at=cfg.created_at,
        updated_at=cfg.updated_at,
    )


@router.put("/session-browser/config", response_model=SessionBrowserConfigSchema)
def update_session_browser_config(payload: SessionBrowserConfigUpdateSafe, db: Session = Depends(get_db)):
    cfg = _get_cfg(db)
    # Only allow safe fields to update; prevent command_path/command_args modifications
    cfg.ssh_port = payload.ssh_port
    cfg.timeout_sec = payload.timeout_sec
    cfg.host_key_policy = payload.host_key_policy
    cfg.max_workers = payload.max_workers
    db.commit()
    db.refresh(cfg)
    return SessionBrowserConfigSchema(
        id=cfg.id,
        ssh_port=cfg.ssh_port,
        command_path=cfg.command_path,
        command_args=cfg.command_args,
        timeout_sec=cfg.timeout_sec,
        host_key_policy=cfg.host_key_policy,
        max_workers=cfg.max_workers,
        created_at=cfg.created_at,
        updated_at=cfg.updated_at,
    )


# DataTables server-side endpoint for large datasets
@router.get("/session-browser/datatables")
async def sessions_datatables(
    request: Request,
    db: Session = Depends(get_db),
    start: int = Query(0, ge=0),
    length: int = Query(25, ge=1, le=1000),
    search: str | None = Query(None, alias="search[value]"),
    order_col: int | None = Query(None, alias="order[0][column]"),
    order_dir: str | None = Query(None, alias="order[0][dir]"),
    group_id: int | None = Query(None),
    proxy_ids: str | None = Query(None),  # comma-separated
):
    # Determine target proxies
    target_ids: List[int] = []
    if proxy_ids:
        try:
            target_ids = [int(x) for x in proxy_ids.split(",") if x.strip()]
        except Exception:
            target_ids = []
    else:
        q = db.query(Proxy).filter(Proxy.is_active == True)
        if group_id is not None:
            q = q.filter(Proxy.group_id == group_id)
        target_ids = [p.id for p in q.all()]

    # Build proxy_id -> host mapping for display
    host_map: Dict[int, str] = {}
    if target_ids:
        for p in db.query(Proxy).filter(Proxy.id.in_(target_ids)).all():
            host_map[p.id] = p.host

    # Load latest rows from temp store
    rows: List[Dict[str, Any]] = []
    for pid in target_ids:
        for rec in temp_store.read_latest(pid):
            r = dict(rec)
            r.setdefault("proxy_id", pid)
            r.setdefault("host", host_map.get(pid, f"#{pid}"))
            # include stable id
            collected = str(r.get("collected_at") or "")
            # we don't have the line index here cheaply; rebuild after sort/pagination below
            rows.append(r)

    records_total = len(rows)

    # Apply simple search filter
    def include(row: Dict[str, Any]) -> bool:
        if not search:
            return True
        s = str(search).lower()
        for key in ("transaction", "user_name", "client_ip", "server_ip", "protocol", "status", "url", "host"):
            val = row.get(key)
            if val is not None and s in str(val).lower():
                return True
        return False

    filtered = [r for r in rows if include(r)]
    records_filtered = len(filtered)

    # Ordering
    def sort_key(row: Dict[str, Any]):
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
            9: 0,
        }
        return mapping.get(order_col or 1)

    reverse = (order_dir or "desc").lower() == "desc"
    try:
        filtered.sort(key=sort_key, reverse=reverse)
    except Exception:
        pass

    # Pagination and build DataTables rows
    # Rebuild page and assign stable ids using original order within each proxy batch
    page = filtered[start:start + length]
    data: List[List[Any]] = []
    for rec in page:
        host = rec.get("host") or f"#{rec.get('proxy_id')}"
        ct_str = rec.get("creation_time") or ""
        cl_recv = rec.get("cl_bytes_received")
        cl_sent = rec.get("cl_bytes_sent")
        age_val = rec.get("age_seconds")
        url_full = rec.get("url") or ""
        url_short = url_full[:100] + ("…" if len(url_full) > 100 else "")
        # Determine line index by scanning the proxy's latest batch until match; fallback 0
        rid_val = 0
        try:
            pid = int(rec.get("proxy_id") or 0)
            batch = temp_store.read_latest(pid)
            collected_iso = str(rec.get("collected_at") or "")
            line_index = 0
            for i, obj in enumerate(batch):
                if obj is rec:
                    line_index = i
                    break
            rid_val = temp_store.build_record_id(pid, collected_iso, line_index)
        except Exception:
            rid_val = 0
        data.append([
            host,
            ct_str,
            rec.get("user_name") or "",
            rec.get("client_ip") or "",
            rec.get("server_ip") or "",
            str(cl_recv) if cl_recv is not None else "",
            str(cl_sent) if cl_sent is not None else "",
            str(age_val) if isinstance(age_val, int) and age_val >= 0 else "",
            url_short,
            rid_val,
        ])

    try:
        draw = int(request.query_params.get("draw", "0"))
    except Exception:
        draw = 0

    return {
        "draw": draw,
        "recordsTotal": records_total,
        "recordsFiltered": records_filtered,
        "data": data,
    }


@router.get("/session-browser/item/{record_id}", response_model=SessionRecordSchema)
async def get_session_record(record_id: int, db: Session = Depends(get_db)):
    item = temp_store.read_item_by_id(record_id)
    if not item:
        raise HTTPException(status_code=404, detail="Record not found")
    return SessionRecordSchema(**item)


@router.get("/session-browser/export")
async def sessions_export(
    db: Session = Depends(get_db),
    search: str | None = Query(None, alias="search[value]"),
    order_col: int | None = Query(None, alias="order[0][column]"),
    order_dir: str | None = Query(None, alias="order[0][dir]"),
    group_id: int | None = Query(None),
    proxy_ids: str | None = Query(None),  # comma-separated
):
    # Determine proxies
    target_ids: List[int] = []
    if proxy_ids:
        try:
            target_ids = [int(x) for x in proxy_ids.split(",") if x.strip()]
        except Exception:
            target_ids = []
    else:
        q = db.query(Proxy).filter(Proxy.is_active == True)
        if group_id is not None:
            q = q.filter(Proxy.group_id == group_id)
        target_ids = [p.id for p in q.all()]

    host_map: Dict[int, str] = {}
    if target_ids:
        for p in db.query(Proxy).filter(Proxy.id.in_(target_ids)).all():
            host_map[p.id] = p.host

    # Load rows
    rows: List[Dict[str, Any]] = []
    for pid in target_ids:
        batch = temp_store.read_latest(pid)
        for idx, rec in enumerate(batch):
            r = dict(rec)
            r.setdefault("proxy_id", pid)
            r.setdefault("host", host_map.get(pid, f"#{pid}"))
            r["id"] = temp_store.build_record_id(pid, str(r.get("collected_at") or ""), idx)
            rows.append(r)

    # Filter
    def include(row: Dict[str, Any]) -> bool:
        if not search:
            return True
        s = str(search).lower()
        for key in ("transaction", "user_name", "client_ip", "server_ip", "protocol", "status", "url", "host"):
            val = row.get(key)
            if val is not None and s in str(val).lower():
                return True
        return False
    filtered = [r for r in rows if include(r)]

    # Order similarly to datatables
    def sort_key(row: Dict[str, Any]):
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
        }
        return mapping.get(order_col or 1)
    reverse = (order_dir or "desc").lower() == "desc"
    try:
        filtered.sort(key=sort_key, reverse=reverse)
    except Exception:
        pass

    def row_iter() -> Iterable[str]:
        # Write UTF-8 BOM for Excel compatibility
        yield "\ufeff"
        headers = [
            "id",
            "프록시",
            "수집시각",
            "트랜잭션",
            "생성시각",
            "프로토콜",
            "Cust ID",
            "사용자",
            "클라이언트 IP",
            "Client-side MWG IP",
            "Server-side MWG IP",
            "서버 IP",
            "CL 수신(Bytes)",
            "CL 송신(Bytes)",
            "서버 수신(Bytes)",
            "서버 송신(Bytes)",
            "Trxn Index",
            "Age(s)",
            "상태",
            "In Use",
            "URL",
        ]
        yield ",".join(headers) + "\n"

        for idx, rec in enumerate(filtered, start=1):
            host = rec.get("host") or f"#{rec.get('proxy_id')}"
            def to_kst_str(val: Any) -> str:
                try:
                    if not val:
                        return ""
                    dt = datetime.fromisoformat(str(val))
                    return dt.astimezone(KST_TZ).strftime("%Y-%m-%d %H:%M:%S")
                except Exception:
                    return ""
            collected_str = to_kst_str(rec.get("collected_at"))
            creation_str = to_kst_str(rec.get("creation_time"))
            def esc(v: Any) -> str:
                s = "" if v is None else str(v)
                if '"' in s or "," in s or "\n" in s or "\r" in s:
                    s = '"' + s.replace('"', '""') + '"'
                return s
            row = [
                esc(idx),
                esc(host),
                esc(collected_str),
                esc(rec.get("transaction") or ""),
                esc(creation_str),
                esc(rec.get("protocol") or ""),
                esc(rec.get("cust_id") or ""),
                esc(rec.get("user_name") or ""),
                esc(rec.get("client_ip") or ""),
                esc(rec.get("client_side_mwg_ip") or ""),
                esc(rec.get("server_side_mwg_ip") or ""),
                esc(rec.get("server_ip") or ""),
                esc(rec.get("cl_bytes_received")),
                esc(rec.get("cl_bytes_sent")),
                esc(rec.get("srv_bytes_received")),
                esc(rec.get("srv_bytes_sent")),
                esc(rec.get("trxn_index")),
                esc(rec.get("age_seconds")),
                esc(rec.get("status") or ""),
                esc(rec.get("in_use")),
                esc(rec.get("url") or ""),
            ]
            yield ",".join(row) + "\n"

    filename = f"sessions_export_{datetime.now().strftime('%Y%m%d_%H%M%S')}\.csv"
    return StreamingResponse(row_iter(), media_type="text/csv", headers={
        "Content-Disposition": f"attachment; filename={filename}"
    })

