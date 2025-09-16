from fastapi import APIRouter, Depends, HTTPException, Query, Request
from fastapi.responses import StreamingResponse
from sqlalchemy.orm import Session
from typing import List, Dict, Any, Tuple, Iterable
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime
from app.utils.time import now_kst, KST_TZ
from sqlalchemy import func, or_, asc, desc, String as SAString
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
from app.models.session_record import SessionRecord as SessionRecordModel
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
def _sessions_col_map() -> Dict[int, Any]:
    # DataTables column index -> model column for sorting
    return {
        0: Proxy.host,
        1: SessionRecordModel.creation_time,
        2: SessionRecordModel.user_name,
        3: SessionRecordModel.client_ip,
        4: SessionRecordModel.server_ip,
        5: SessionRecordModel.cl_bytes_received,
        6: SessionRecordModel.cl_bytes_sent,
        7: SessionRecordModel.age_seconds,
        8: SessionRecordModel.url,
        9: SessionRecordModel.id,
    }


def _base_sessions_query(db: Session):
    return db.query(SessionRecordModel, Proxy).join(Proxy, SessionRecordModel.proxy_id == Proxy.id)


def _apply_sessions_filters(base_q, group_id: int | None, proxy_ids_csv: str | None, search: str | None):
    q = base_q
    if group_id is not None:
        q = q.filter(Proxy.group_id == group_id)
    if proxy_ids_csv:
        try:
            id_list = [int(x) for x in proxy_ids_csv.split(",") if x.strip()]
            if id_list:
                q = q.filter(SessionRecordModel.proxy_id.in_(id_list))
        except Exception:
            pass
    if search:
        s = f"%{search}%"
        q = q.filter(
            or_(
                SessionRecordModel.transaction.ilike(s),
                SessionRecordModel.user_name.ilike(s),
                SessionRecordModel.client_ip.ilike(s),
                SessionRecordModel.server_ip.ilike(s),
                SessionRecordModel.protocol.ilike(s),
                SessionRecordModel.status.ilike(s),
                SessionRecordModel.url.ilike(s),
                Proxy.host.ilike(s),
            )
        )
    return q


def _apply_sessions_order(q, order_col: int | None, order_dir: str | None):
    col_map = _sessions_col_map()
    if order_col is not None and order_col in col_map:
        col = col_map[order_col]
        if (order_dir or "").lower() == "desc":
            return q.order_by(desc(col))
        elif (order_dir or "").lower() == "asc":
            return q.order_by(asc(col))
        else:
            return q.order_by(desc(col))
    # default order: newest first
    return q.order_by(SessionRecordModel.collected_at.desc(), SessionRecordModel.id.desc())


def _apply_column_searches(q, col_searches: Dict[int, str]):
    if not col_searches:
        return q
    conds = []
    for idx, term in col_searches.items():
        if not term:
            continue
        s = f"%{term}%"
        try:
            if idx == 0:
                conds.append(Proxy.host.ilike(s))
            elif idx == 1:
                conds.append(func.cast(SessionRecordModel.creation_time, SAString).ilike(s))
            elif idx == 2:
                conds.append(SessionRecordModel.user_name.ilike(s))
            elif idx == 3:
                conds.append(SessionRecordModel.client_ip.ilike(s))
            elif idx == 4:
                conds.append(SessionRecordModel.server_ip.ilike(s))
            elif idx == 5:
                conds.append(func.cast(SessionRecordModel.cl_bytes_received, SAString).ilike(s))
            elif idx == 6:
                conds.append(func.cast(SessionRecordModel.cl_bytes_sent, SAString).ilike(s))
            elif idx == 7:
                conds.append(func.cast(SessionRecordModel.age_seconds, SAString).ilike(s))
            elif idx == 8:
                conds.append(SessionRecordModel.url.ilike(s))
        except Exception:
            pass
    if conds:
        q = q.filter(*conds)
    return q



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

    # Replacement semantics: clear existing session records for TARGETED proxies only
    t_overall_start = time.perf_counter()
    proxy_ids_selected = [p.id for p in proxies]
    t_delete_start = time.perf_counter()
    try:
        if proxy_ids_selected:
            db.query(SessionRecordModel).filter(SessionRecordModel.proxy_id.in_(proxy_ids_selected)).delete(synchronize_session=False)
    except Exception as e:
        logger.exception("Failed to clear previous session records for selected proxies before collect: %s", e)
        # proceed anyway to attempt fresh insert
    t_delete_end = time.perf_counter()

    collected_at_ts = now_kst()
    insert_mappings: List[Dict[str, Any]] = []

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
                for rec in records or []:
                    insert_mappings.append({
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
                        "collected_at": collected_at_ts,
                    })
            except Exception as e:
                errors[proxy.id] = str(e)

    t_fetch_parse_end = time.perf_counter()

    # Bulk insert for speed
    t_db_insert_start = time.perf_counter()
    if insert_mappings:
        try:
            db.bulk_insert_mappings(SessionRecordModel, insert_mappings)
        except Exception as e:
            logger.exception("Bulk insert failed; falling back to row-by-row: %s", e)
            for row in insert_mappings:
                db.add(SessionRecordModel(**row))
    db.commit()
    t_db_insert_end = time.perf_counter()

    logger.info(
        "session-collect: proxies=%d ok=%d fail=%d records=%d delete_ms=%.1f fetch_parse_ms=%.1f db_insert_ms=%.1f total_ms=%.1f",
        len(proxies),
        len(proxies) - len(errors),
        len(errors),
        len(insert_mappings),
        (t_delete_end - t_delete_start) * 1000.0,
        (t_fetch_parse_end - t_fetch_parse_start) * 1000.0,
        (t_db_insert_end - t_db_insert_start) * 1000.0,
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
    rows = (
        db.query(SessionRecordModel)
        .order_by(SessionRecordModel.collected_at.desc())
        .offset(offset)
        .limit(limit)
        .all()
    )
    return rows


@router.get("/session-browser/latest/{proxy_id}", response_model=List[SessionRecordSchema])
async def latest_sessions(proxy_id: int, db: Session = Depends(get_db)):
    # Return latest batch for a proxy: we approximate by taking latest collected_at and returning those rows
    subq = (
        db.query(SessionRecordModel.collected_at)
        .filter(SessionRecordModel.proxy_id == proxy_id)
        .order_by(SessionRecordModel.collected_at.desc())
        .limit(1)
        .subquery()
    )
    rows = (
        db.query(SessionRecordModel)
        .filter(SessionRecordModel.proxy_id == proxy_id)
        .filter(SessionRecordModel.collected_at == subq.c.collected_at)
        .order_by(SessionRecordModel.id.asc())
        .all()
    )
    return rows


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
    # Mapping DataTables column index -> (model column, default sort direction)
    # Base query with join to proxy for filtering/sorting by host/group
    base_q = _base_sessions_query(db)

    # Total records (before filters)
    records_total = db.query(func.count(SessionRecordModel.id)).scalar() or 0

    # Apply filters
    base_q = _apply_sessions_filters(base_q, group_id, proxy_ids, search)
    # Per-column filters from DataTables
    col_searches: Dict[int, str] = {}
    try:
        # Expect up to 10 columns (including hidden id)
        for i in range(0, 10):
            key = f"columns[{i}][search][value]"
            val = request.query_params.get(key)
            if val:
                col_searches[i] = val
    except Exception:
        pass
    base_q = _apply_column_searches(base_q, col_searches)

    # records after filtering
    records_filtered = base_q.with_entities(func.count(SessionRecordModel.id)).scalar() or 0

    # Ordering
    base_q = _apply_sessions_order(base_q, order_col, order_dir)

    # Pagination
    rows = base_q.offset(start).limit(length).all()

    # Build DataTables row arrays matching UI columns
    data: List[List[Any]] = []
    for rec, proxy in rows:
        host = proxy.host if proxy else f"#{rec.proxy_id}"
        ct_str = rec.creation_time.astimezone(KST_TZ).strftime("%Y-%m-%d %H:%M:%S") if rec.creation_time else ""
        cl_recv = rec.cl_bytes_received if rec.cl_bytes_received is not None else ""
        cl_sent = rec.cl_bytes_sent if rec.cl_bytes_sent is not None else ""
        age_str = rec.age_seconds if rec.age_seconds is not None and rec.age_seconds >= 0 else ""
        url_full = rec.url or ""
        url_short = url_full[:100] + ("…" if len(url_full) > 100 else "")
        data.append([
            host,
            ct_str,
            rec.user_name or "",
            rec.client_ip or "",
            rec.server_ip or "",
            str(cl_recv) if cl_recv != "" else "",
            str(cl_sent) if cl_sent != "" else "",
            str(age_str) if age_str != "" else "",
            url_short,
            rec.id,
        ])

    # DataTables draw counter (echo)
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
    row = db.query(SessionRecordModel).filter(SessionRecordModel.id == record_id).first()
    if not row:
        raise HTTPException(status_code=404, detail="Record not found")
    return row


@router.get("/session-browser/export")
async def sessions_export(
    db: Session = Depends(get_db),
    search: str | None = Query(None, alias="search[value]"),
    order_col: int | None = Query(None, alias="order[0][column]"),
    order_dir: str | None = Query(None, alias="order[0][dir]"),
    group_id: int | None = Query(None),
    proxy_ids: str | None = Query(None),  # comma-separated
):
    base_q = _base_sessions_query(db)
    base_q = _apply_sessions_filters(base_q, group_id, proxy_ids, search)
    base_q = _apply_sessions_order(base_q, order_col, order_dir)

    def row_iter() -> Iterable[str]:
        # Write UTF-8 BOM for Excel compatibility
        yield "\ufeff"
        # Header (Korean labels to match UI)
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

        chunk = 2000
        offset = 0
        while True:
            batch = base_q.offset(offset).limit(chunk).all()
            if not batch:
                break
            for rec, proxy in batch:
                host = proxy.host if proxy else f"#{rec.proxy_id}"
                collected_str = rec.collected_at.astimezone(KST_TZ).strftime("%Y-%m-%d %H:%M:%S") if rec.collected_at else ""
                creation_str = rec.creation_time.astimezone(KST_TZ).strftime("%Y-%m-%d %H:%M:%S") if rec.creation_time else ""
                # simple CSV escaping
                def esc(v: Any) -> str:
                    s = "" if v is None else str(v)
                    if '"' in s or "," in s or "\n" in s or "\r" in s:
                        s = '"' + s.replace('"', '""') + '"'
                    return s
                row = [
                    esc(rec.id),
                    esc(host),
                    esc(collected_str),
                    esc(rec.transaction or ""),
                    esc(creation_str),
                    esc(rec.protocol or ""),
                    esc(rec.cust_id or ""),
                    esc(rec.user_name or ""),
                    esc(rec.client_ip or ""),
                    esc(rec.client_side_mwg_ip or ""),
                    esc(rec.server_side_mwg_ip or ""),
                    esc(rec.server_ip or ""),
                    esc(rec.cl_bytes_received),
                    esc(rec.cl_bytes_sent),
                    esc(rec.srv_bytes_received),
                    esc(rec.srv_bytes_sent),
                    esc(rec.trxn_index),
                    esc(rec.age_seconds),
                    esc(rec.status or ""),
                    esc(rec.in_use),
                    esc(rec.url or ""),
                ]
                yield ",".join(row) + "\n"
            offset += chunk

    filename = f"sessions_export_{datetime.now().strftime('%Y%m%d_%H%M%S')}\.csv"
    return StreamingResponse(row_iter(), media_type="text/csv", headers={
        "Content-Disposition": f"attachment; filename={filename}"
    })

