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
import json
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
    if not lines: return []
    start_idx = 1 if lines and lines[0].lower().startswith("there are currently") else 0
    if len(lines) > start_idx and "Transaction" in lines[start_idx] and "URL" in lines[start_idx]: start_idx += 1

    records: List[Dict[str, Any]] = []
    for line in lines[start_idx:]:
        parts = [p.strip() for p in line.split("|")]
        if not parts: continue
        transaction = parts[0] if len(parts) > 0 and parts[0] != "" else None
        dt_regex = re.compile(r"^\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}:\d{2}$")
        creation_time_idx = next((i for i, p in enumerate(parts[1:6], 1) if dt_regex.match(p or "")), None)
        creation_time = None
        if creation_time_idx:
            try: creation_time = datetime.strptime(parts[creation_time_idx], "%Y-%m-%d %H:%M:%S").replace(tzinfo=KST_TZ)
            except Exception: pass
        shift = (creation_time_idx - 1) if creation_time_idx else 0
        def get_part(i): return parts[i + shift].strip() if 0 <= i + shift < len(parts) and parts[i + shift].strip() else None
        def to_int(v): return int(str(v).strip()) if v is not None and str(v).strip() != "" else None
        def strip_port(ip): return str(ip or '').rsplit(":", 1)[0] if isinstance(ip, str) and re.match(r"^\d+\.\d+\.\d+\.\d+:\d+$", ip) else ip
        records.append({
            "transaction": transaction, "creation_time": creation_time, "protocol": get_part(2),
            "cust_id": get_part(3), "user_name": get_part(4), "client_ip": strip_port(get_part(5)),
            "client_side_mwg_ip": get_part(6), "server_side_mwg_ip": get_part(7), "server_ip": get_part(8),
            "cl_bytes_received": to_int(get_part(9)), "cl_bytes_sent": to_int(get_part(10)),
            "srv_bytes_received": to_int(get_part(11)), "srv_bytes_sent": to_int(get_part(12)),
            "trxn_index": to_int(get_part(13)), "age_seconds": to_int(get_part(14)),
            "status": get_part(15), "in_use": to_int(get_part(16)),
            "url": get_part(17) or (parts[-1] if parts and (parts[-1].startswith("http://") or parts[-1].startswith("https://")) else None),
            "raw_line": line
        })
    return records

def _collect_for_proxy(proxy: Proxy, cfg: SessionBrowserConfigModel) -> Tuple[int, List[Dict[str, Any]] | None, str | None]:
    if not proxy.username: return proxy.id, None, "Proxy is missing SSH username"
    command = f"{cfg.command_path} {cfg.command_args}".strip()
    try:
        stdout = ssh_exec(host=proxy.host, port=cfg.ssh_port or 22, username=proxy.username, password=decrypt_string_if_encrypted(proxy.password), command=command, timeout_sec=cfg.timeout_sec or 10)
        records = _parse_sessions(stdout)
        enriched = [dict(rec, proxy_id=proxy.id, host=proxy.host) for rec in records]
        return proxy.id, enriched, None
    except Exception as e:
        return proxy.id, None, str(e)

def _apply_filters(rows: List[Dict[str, Any]], filter_model: Dict[str, Any]) -> List[Dict[str, Any]]:
    if not filter_model: return rows
    filtered_rows = rows
    for col, f in filter_model.items():
        query, filter_type = f.get("filter"), f.get("type")
        if query is None: continue
        query_str = str(query).lower()
        def check(val):
            s = str(val or "").lower()
            if filter_type == "contains": return query_str in s
            if filter_type == "notContains": return query_str not in s
            if filter_type == "equals": return query_str == s
            if filter_type == "notEqual": return query_str != s
            if filter_type == "startsWith": return s.startswith(query_str)
            if filter_type == "endsWith": return s.endswith(query_str)
            return query_str in s
        filtered_rows = [r for r in filtered_rows if check(r.get(col))]
    return filtered_rows

def _apply_sorting(rows: List[Dict[str, Any]], sort_model: List[Dict[str, str]]):
    if not sort_model: return
    for s in reversed(sort_model):
        col, direction = s["colId"], s["sort"]
        rows.sort(key=lambda r: (r.get(col) is None, r.get(col)), reverse=(direction == "desc"))

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

    filtered_rows = _apply_filters(all_rows, filter_model)
    _apply_sorting(filtered_rows, sort_model)

    paginated_rows = filtered_rows[start_row:end_row]
    for r in paginated_rows:
        r["id"] = temp_store.build_record_id(r["proxy_id"], str(r.get("collected_at") or ""), r["__line_index"])
    return {"rows": paginated_rows, "rowCount": len(filtered_rows)}

@router.get("/session-browser/item/{record_id}")
async def get_session_record(record_id: int, db: Session = Depends(get_db)):
    item = temp_store.read_item_by_id(record_id)
    if not item: raise HTTPException(status_code=404, detail="Record not found")
    item["id"] = record_id
    return _ensure_timestamps(item)

@router.post("/session-browser/export")
async def sessions_export(request: Request, db: Session = Depends(get_db)):
    body = await request.json()
    proxy_ids_str = body.get("proxy_ids")
    sort_model = body.get("sortModel", [])
    filter_model = body.get("filterModel", {})

    target_ids = [int(x) for x in proxy_ids_str.split(",") if x.strip()] if proxy_ids_str else []
    if not target_ids:
        proxies_q = db.query(Proxy.id).filter(Proxy.is_active == True).all()
        target_ids = [p.id for p in proxies_q]

    all_rows = []
    proxies_map = {p.id: p for p in db.query(Proxy).filter(Proxy.id.in_(target_ids)).all()}
    for pid in target_ids:
        if pid in proxies_map:
            batch = temp_store.read_latest(pid)
            for rec in batch:
                r = dict(rec)
                r.setdefault("host", proxies_map[pid].host)
                all_rows.append(r)

    filtered_rows = _apply_filters(all_rows, filter_model)
    _apply_sorting(filtered_rows, sort_model)

    wb = Workbook()
    ws = wb.active
    ws.title = "Sessions"
    headers = ["ID", "프록시", "수집시각", "트랜잭션", "생성시각", "프로토콜", "Cust ID", "사용자", "클라이언트 IP", "Client-side MWG IP", "Server-side MWG IP", "서버 IP", "CL 수신(Bytes)", "CL 송신(Bytes)", "서버 수신(Bytes)", "서버 송신(Bytes)", "Trxn Index", "Age(s)", "상태", "In Use", "URL"]
    ws.append(headers)
    for cell in ws[1]: cell.font = Font(bold=True)

    def to_kst_str(val: Any) -> str:
        try: return datetime.fromisoformat(str(val)).astimezone(KST_TZ).strftime("%Y-%m-%d %H:%M:%S") if val else ""
        except: return str(val or "")

    for idx, rec in enumerate(filtered_rows, start=1):
        ws.append([
            idx, rec.get("host"), to_kst_str(rec.get("collected_at")), rec.get("transaction"), to_kst_str(rec.get("creation_time")),
            rec.get("protocol"), rec.get("cust_id"), rec.get("user_name"), rec.get("client_ip"),
            rec.get("client_side_mwg_ip"), rec.get("server_side_mwg_ip"), rec.get("server_ip"),
            rec.get("cl_bytes_received"), rec.get("cl_bytes_sent"), rec.get("srv_bytes_received"), rec.get("srv_bytes_sent"),
            rec.get("trxn_index"), rec.get("age_seconds"), rec.get("status"), rec.get("in_use"), rec.get("url"),
        ])

    virtual_workbook = io.BytesIO()
    wb.save(virtual_workbook)
    virtual_workbook.seek(0)
    filename = f"sessions_export_{now_kst().strftime('%Y%m%d_%H%M%S')}.xlsx"
    return StreamingResponse(virtual_workbook, media_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", headers={"Content-Disposition": f"attachment; filename=\"{filename}\""})

@router.get("/session-browser/analyze")
async def sessions_analyze(db: Session = Depends(get_db), proxy_ids: str | None = Query(None, description="comma-separated proxy ids"), topN: int = Query(20, ge=1, le=100)):
    target_ids = [int(x) for x in proxy_ids.split(",") if x.strip()] if proxy_ids else []
    if not target_ids: raise HTTPException(status_code=400, detail="proxy_ids required")

    all_rows = []
    proxies_map = {p.id: p for p in db.query(Proxy).filter(Proxy.id.in_(target_ids)).all()}
    for pid in target_ids:
        if pid in proxies_map:
            all_rows.extend(temp_store.read_latest(pid))

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