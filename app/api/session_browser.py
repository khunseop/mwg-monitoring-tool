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
import os
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
from app.schemas.session_record import SessionRecord as SessionRecordSchema
from app.services.session_browser_config import get_or_create_config as _get_cfg_service
from app.utils.crypto import decrypt_string_if_encrypted
from app.storage import temp_store
from urllib.parse import urlparse


router = APIRouter()
logger = logging.getLogger(__name__)

def _ensure_timestamps(item: Dict[str, Any]) -> Dict[str, Any]:
    out = dict(item)
    collected = out.get("collected_at")
    try:
        default_dt = now_kst()
        if collected:
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

def _parse_sessions(output: str) -> List[Dict[str, Any]]:
    lines = [line.strip() for line in output.splitlines() if line.strip()]
    if not lines:
        return []

    start_idx = 0
    if lines and lines[0].lower().startswith("there are currently"):
        start_idx = 1
    if len(lines) > start_idx and "Transaction" in lines[start_idx] and "URL" in lines[start_idx]:
        start_idx += 1

    records: List[Dict[str, Any]] = []
    for line in lines[start_idx:]:
        parts = [p.strip() for p in line.split("|")]
        if not parts: continue

        transaction = parts[0] if len(parts) > 0 and parts[0] != "" else None
        dt_regex = re.compile(r"^\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}:\d{2}$")
        creation_time_idx = next((i for i, p in enumerate(parts[1:6], 1) if dt_regex.match(p or "")), None)

        creation_time = None
        if creation_time_idx is not None:
            try:
                creation_time = datetime.strptime(parts[creation_time_idx], "%Y-%m-%d %H:%M:%S").replace(tzinfo=KST_TZ)
            except Exception: pass

        shift_after = (creation_time_idx - 1) if creation_time_idx is not None else 0
        def get_after(expected_index: int):
            idx = expected_index + shift_after
            return parts[idx].strip() if 0 <= idx < len(parts) and parts[idx].strip() else None

        def _to_int(value: Any):
            try: return int(str(value).strip()) if value is not None and str(value).strip() else None
            except Exception: return None

        def _strip_port(ip: Any):
            try:
                s = str(ip or '').strip()
                return s.rsplit(":", 1)[0] if re.match(r"^\d+\.\d+\.\d+\.\d+:\d+$", s) else s
            except Exception: return ip

        record = {
            "transaction": transaction, "creation_time": creation_time, "protocol": get_after(2),
            "cust_id": get_after(3), "user_name": get_after(4), "client_ip": _strip_port(get_after(5)),
            "client_side_mwg_ip": get_after(6), "server_side_mwg_ip": get_after(7), "server_ip": get_after(8),
            "cl_bytes_received": _to_int(get_after(9)), "cl_bytes_sent": _to_int(get_after(10)),
            "srv_bytes_received": _to_int(get_after(11)), "srv_bytes_sent": _to_int(get_after(12)),
            "trxn_index": _to_int(get_after(13)), "age_seconds": _to_int(get_after(14)),
            "status": get_after(15), "in_use": _to_int(get_after(16)), "url": get_after(17) or (parts[-1] if parts and (parts[-1].startswith("http://") or parts[-1].startswith("https://")) else None),
            "raw_line": line,
        }
        records.append(record)
    return records

def _collect_for_proxy(proxy: Proxy, cfg: SessionBrowserConfigModel) -> Tuple[int, List[Dict[str, Any]] | None, str | None]:
    if not proxy.username: return proxy.id, None, "Proxy is missing SSH username"
    command = f"{cfg.command_path} {cfg.command_args}".strip()
    try:
        stdout_str = ssh_exec(
            host=proxy.host, port=cfg.ssh_port or 22, username=proxy.username,
            password=decrypt_string_if_encrypted(proxy.password), command=command,
            timeout_sec=cfg.timeout_sec or 10, auth_timeout_sec=cfg.timeout_sec or 10,
            banner_timeout_sec=cfg.timeout_sec or 10, host_key_policy=cfg.host_key_policy or "auto_add",
            look_for_keys=False, allow_agent=False,
        )
        records = _parse_sessions(stdout_str)
        enriched = [dict(rec, proxy_id=proxy.id, host=proxy.host) for rec in records]
        return proxy.id, enriched, None
    except Exception as e:
        return proxy.id, None, str(e)

@router.post("/session-browser/data")
async def sessions_data(request: Request, db: Session = Depends(get_db)):
    body = await request.json()
    start_row, end_row = body.get("startRow", 0), body.get("endRow", 100)
    sort_model, filter_model = body.get("sortModel", []), body.get("filterModel", {})
    proxy_ids_str, force_refresh = body.get("proxy_ids"), body.get("force", False)

    target_ids = [int(x) for x in proxy_ids_str.split(",") if x.strip()] if proxy_ids_str else []
    if not target_ids: return {"rowCount": 0, "rows": []}

    cfg = _get_cfg(db)
    proxies = {p.id: p for p in db.query(Proxy).filter(Proxy.id.in_(target_ids), Proxy.is_active == True).all()}

    if force_refresh:
        with ThreadPoolExecutor(max_workers=cfg.max_workers or 4) as executor:
            future_map = {executor.submit(_collect_for_proxy, proxies[pid], cfg): pid for pid in target_ids if pid in proxies}
            for future in as_completed(future_map):
                pid = future_map[future]
                try:
                    _, records, err = future.result()
                    if not err and records is not None: temp_store.write_batch(pid, now_kst(), records)
                except Exception as e: logger.error(f"Failed to collect for proxy {pid}: {e}")
        try: temp_store.cleanup_old_batches(retain_per_proxy=1)
        except Exception: pass

    all_rows = []
    for pid in target_ids:
        if pid in proxies:
            batch = temp_store.read_latest(pid)
            for idx, rec in enumerate(batch):
                r = dict(rec)
                r.setdefault("host", proxies[pid].host)
                r["__line_index"] = idx
                all_rows.append(r)

    if filter_model:
        for col, f in filter_model.items():
            query, filter_type = (f.get("filter"), f.get("type"))
            if query is None: continue
            query_str = str(query).lower()
            def check(val):
                s = str(val or "").lower()
                return ( (filter_type == "contains" and query_str in s) or
                         (filter_type == "notContains" and query_str not in s) or
                         (filter_type == "equals" and query_str == s) or
                         (filter_type == "notEqual" and query_str != s) or
                         (filter_type == "startsWith" and s.startswith(query_str)) or
                         (filter_type == "endsWith" and s.endswith(query_str)) or
                         (query_str in s) )
            all_rows = [r for r in all_rows if check(r.get(col))]

    if sort_model:
        for s in reversed(sort_model):
            col, direction = s["colId"], s["sort"]
            all_rows.sort(key=lambda r: (r.get(col) is None, r.get(col)), reverse=(direction == "desc"))

    paginated_rows = all_rows[start_row:end_row]
    for r in paginated_rows:
        r["id"] = temp_store.build_record_id(r["proxy_id"], str(r.get("collected_at") or ""), r["__line_index"])

    return {"rows": paginated_rows, "rowCount": len(all_rows)}

@router.get("/session-browser/item/{record_id}")
async def get_session_record(record_id: int, db: Session = Depends(get_db)):
    item = temp_store.read_item_by_id(record_id)
    if not item: raise HTTPException(status_code=404, detail="Record not found")
    item["id"] = record_id
    return _ensure_timestamps(item)

def _filter_rows(rows: List[Dict[str, Any]], search: str | None) -> List[Dict[str, Any]]:
    if not search: return rows
    s = str(search).lower()
    return [r for r in rows if any(s in str(val).lower() for val in r.values())]

def _sort_key_func(col_idx: int | None):
    col_map = {0: "host", 1: "creation_time", 2: "protocol", 3: "user_name", 4: "client_ip", 5: "server_ip", 6: "cl_bytes_received", 7: "cl_bytes_sent", 8: "age_seconds", 9: "url"}
    key = col_map.get(col_idx or 0, "id")

    def sort_key(r):
        val = r.get(key)
        is_none = val is None
        if isinstance(val, (int, float)): return (is_none, val)
        if isinstance(val, str) and key == "creation_time":
            try: return (is_none, datetime.fromisoformat(val).timestamp())
            except: return (is_none, 0)
        return (is_none, str(val or "").lower())
    return sort_key

@router.get("/session-browser/export")
async def sessions_export(db: Session = Depends(get_db), search: str | None = Query(None, alias="search[value]"), order_col: int | None = Query(None, alias="order[0][column]"), order_dir: str | None = Query(None, alias="order[0][dir]"), proxy_ids: str | None = Query(None)):
    target_ids = [int(x) for x in proxy_ids.split(",") if x.strip()] if proxy_ids else []
    if not target_ids:
        proxies = db.query(Proxy.id).filter(Proxy.is_active == True).all()
        target_ids = [p.id for p in proxies]

    all_rows = []
    proxies_map = {p.id: p for p in db.query(Proxy).filter(Proxy.id.in_(target_ids)).all()}
    for pid in target_ids:
        if pid in proxies_map:
            batch = temp_store.read_latest(pid)
            for rec in batch:
                r = dict(rec)
                r.setdefault("host", proxies_map[pid].host)
                all_rows.append(r)

    filtered_rows = _filter_rows(all_rows, search)
    filtered_rows.sort(key=_sort_key_func(order_col), reverse=((order_dir or "desc") == "desc"))

    wb = Workbook()
    ws = wb.active
    ws.title = "Sessions"
    headers = ["id", "프록시", "수집시각", "트랜잭션", "생성시각", "프로토콜", "Cust ID", "사용자", "클라이언트 IP", "Client-side MWG IP", "Server-side MWG IP", "서버 IP", "CL 수신(Bytes)", "CL 송신(Bytes)", "서버 수신(Bytes)", "서버 송신(Bytes)", "Trxn Index", "Age(s)", "상태", "In Use", "URL"]
    ws.append(headers)
    for cell in ws[1]: cell.font = Font(bold=True)

    def to_kst_str(val: Any) -> str:
        try: return datetime.fromisoformat(str(val)).astimezone(KST_TZ).strftime("%Y-%m-%d %H:%M:%S") if val else ""
        except: return str(val or "")

    for idx, rec in enumerate(filtered_rows, start=1):
        row_data = [
            idx, rec.get("host"), to_kst_str(rec.get("collected_at")), rec.get("transaction"), to_kst_str(rec.get("creation_time")),
            rec.get("protocol"), rec.get("cust_id"), rec.get("user_name"), rec.get("client_ip"),
            rec.get("client_side_mwg_ip"), rec.get("server_side_mwg_ip"), rec.get("server_ip"),
            rec.get("cl_bytes_received"), rec.get("cl_bytes_sent"), rec.get("srv_bytes_received"), rec.get("srv_bytes_sent"),
            rec.get("trxn_index"), rec.get("age_seconds"), rec.get("status"), rec.get("in_use"), rec.get("url"),
        ]
        ws.append(row_data)

    virtual_workbook = io.BytesIO()
    wb.save(virtual_workbook)
    virtual_workbook.seek(0)
    filename = f"sessions_export_{datetime.now().strftime('%Y%m%d_%H%M%S')}.xlsx"
    return StreamingResponse(virtual_workbook, media_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", headers={"Content-Disposition": f"attachment; filename=\"{filename}\""})

@router.get("/session-browser/analyze")
async def sessions_analyze(db: Session = Depends(get_db), proxy_ids: str | None = Query(None, description="comma-separated proxy ids"), topN: int = Query(20, ge=1, le=100)):
    target_ids = [int(x) for x in proxy_ids.split(",") if x.strip()] if proxy_ids else []
    if not target_ids: raise HTTPException(status_code=400, detail="proxy_ids required")

    all_rows = []
    proxies_map = {p.id: p for p in db.query(Proxy).filter(Proxy.id.in_(target_ids)).all()}
    for pid in target_ids:
        if pid in proxies_map:
            batch = temp_store.read_latest(pid)
            all_rows.extend(batch)

    from collections import Counter, defaultdict
    host_counter, url_counter, client_req_counter = Counter(), Counter(), Counter()
    client_cl_recv_bytes, client_cl_sent_bytes = defaultdict(int), defaultdict(int)
    host_srv_recv_bytes, host_srv_sent_bytes = defaultdict(int), defaultdict(int)
    total_recv, total_sent = 0, 0
    unique_clients, unique_hosts = set(), set()
    earliest_dt, latest_dt = None, None

    def _parse_host(url): return urlparse(str(url or "")).hostname or ""
    def _strip_port(ip): return str(ip or "").rsplit(":", 1)[0] if isinstance(ip, str) and re.match(r"^\d+\.\d+\.\d+\.\d+:\d+$", ip) else str(ip or "")

    for rec in all_rows:
        client_ip, url_full = _strip_port(rec.get("client_ip")), rec.get("url")
        url_host, recv_b, sent_b = _parse_host(url_full), rec.get("cl_bytes_received", 0) or 0, rec.get("cl_bytes_sent", 0) or 0
        srv_recv_b, srv_sent_b = rec.get("srv_bytes_received", 0) or 0, rec.get("srv_bytes_sent", 0) or 0

        if client_ip:
            client_req_counter[client_ip] += 1
            unique_clients.add(client_ip)
            client_cl_recv_bytes[client_ip] += recv_b
            client_cl_sent_bytes[client_ip] += sent_b
            total_recv += recv_b
            total_sent += sent_b
        if url_host:
            host_counter[url_host] += 1
            unique_hosts.add(url_host)
            host_srv_recv_bytes[url_host] += srv_recv_b
            host_srv_sent_bytes[url_host] += srv_sent_b
        if url_full:
            url_counter[str(url_full)[:2048]] += 1

        ct = rec.get("creation_time") or rec.get("collected_at")
        if ct:
            dt = datetime.fromisoformat(str(ct))
            if earliest_dt is None or dt < earliest_dt: earliest_dt = dt
            if latest_dt is None or dt > latest_dt: latest_dt = dt

    def top_n(counter, n): return Counter(counter).most_common(n)

    return {
        "summary": { "total_sessions": len(all_rows), "unique_clients": len(unique_clients), "unique_hosts": len(unique_hosts), "total_recv_bytes": total_recv, "total_sent_bytes": total_sent, "time_range_start": earliest_dt.isoformat() if earliest_dt else None, "time_range_end": latest_dt.isoformat() if latest_dt else None },
        "top": { "hosts_by_requests": top_n(host_counter, topN), "urls_by_requests": top_n(url_counter, topN), "clients_by_requests": top_n(client_req_counter, topN), "clients_by_cl_recv_bytes": top_n(client_cl_recv_bytes, topN), "clients_by_cl_sent_bytes": top_n(client_cl_sent_bytes, topN), "hosts_by_srv_recv_bytes": top_n(host_srv_recv_bytes, topN), "hosts_by_srv_sent_bytes": top_n(host_srv_sent_bytes, topN) }
    }