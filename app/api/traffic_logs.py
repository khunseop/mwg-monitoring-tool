from fastapi import APIRouter, Depends, HTTPException, Query, UploadFile, File
from sqlalchemy.orm import Session
from typing import Optional, List, Dict, Any, Tuple
from datetime import datetime
import shlex
from app.utils.ssh import ssh_exec

from app.database.database import get_db
from app.models.proxy import Proxy
from app.schemas.traffic_log import TrafficLogResponse, TrafficLogRecord, TrafficLogDB, MultiTrafficLogResponse
from app.models.traffic_log import TrafficLog as TrafficLogModel
from app.utils.traffic_log_parser import parse_log_line
from app.utils.crypto import decrypt_string_if_encrypted
from concurrent.futures import ThreadPoolExecutor, as_completed
import logging


router = APIRouter()
logger = logging.getLogger(__name__)


def _validate_query(q: Optional[str]) -> Optional[str]:
	if q is None:
		return None
	if len(q) == 0:
		return None
	if len(q) > 256:
		raise HTTPException(status_code=400, detail="q too long (max 256)")
	for ch in q:
		if ch == "\n" or ch == "\r" or ord(ch) < 32 and ch != "\t":
			raise HTTPException(status_code=400, detail="q contains invalid control characters")
	return q


def _build_remote_command(log_path: str, q: Optional[str], limit: int, direction: str) -> str:
	safe_path = shlex.quote(log_path)
	limit_str = str(limit)
	base_prefix = "timeout 15s nice -n 10 ionice -c2 -n7 "
	# Increased buffer from 1MB to 10MB to accommodate up to 10,000 lines (avg line length ~1KB)
	clean_filter = " | sed -e 's/[^[:print:]\\t]//g' | head -c 10485760 | cat"
	if q:
		safe_q = shlex.quote(q)
		grep_cmd = f"grep -F -- {safe_q} {safe_path}"
		cut_cmd = f"tail -n {limit_str}" if direction == "tail" else f"head -n {limit_str}"
		return base_prefix + grep_cmd + " | " + cut_cmd + clean_filter
	if direction == "tail":
		return base_prefix + f"tail -n {limit_str} {safe_path}" + clean_filter
	else:
		return base_prefix + f"head -n {limit_str} {safe_path}" + clean_filter


def _ssh_exec(host: str, port: int, username: str, password: Optional[str], command: str) -> str:
    try:
        return ssh_exec(
            host=host,
            port=port,
            username=username,
            password=password,
            command=command,
            timeout_sec=7,
            auth_timeout_sec=5,
            banner_timeout_sec=5,
            host_key_policy="auto_add",
        )
    except Exception as e:
        raise HTTPException(status_code=502, detail=f"ssh error: {str(e)}")


def _fetch_and_parse_for_proxy(db_proxy: Proxy, q: Optional[str], limit: int, direction: str, db: Session) -> Tuple[List[TrafficLogRecord], str | None]:
    try:
        command = _build_remote_command(db_proxy.traffic_log_path, q, limit, direction)
        raw = _ssh_exec(db_proxy.host, db_proxy.port or 22, db_proxy.username, decrypt_string_if_encrypted(db_proxy.password), command)
        lines = [ln for ln in raw.split("\n") if ln]
        
        records: List[TrafficLogRecord] = []
        to_insert: List[Dict[str, Any]] = []
        collected_ts = datetime.utcnow()
        
        for ln in lines:
            try:
                rec_dict = parse_log_line(ln)
                # Ensure proxy_id is set in the record
                rec_dict["proxy_id"] = str(db_proxy.id)
                rec_dict["_raw_line_"] = ln  # 원본 로그 보관
                records.append(TrafficLogRecord(**rec_dict))
                row = {
                    "proxy_id": db_proxy.id,
                    "collected_at": collected_ts,
                }
                row.update(rec_dict)
                to_insert.append(row)
            except Exception:
                # Add unparseable line as url_path for some visibility
                records.append(TrafficLogRecord(url_path=ln, proxy_id=str(db_proxy.id)))
        
        if to_insert:
            # We use a separate thread for DB to avoid blocking, but since this is called from ThreadPoolExecutor already, it's fine.
            # But we must be careful with session thread-safety. 
            # In get_multi_proxy_traffic_logs, we'll give each call its own session or a lock.
            try:
                # Delete old snapshot for this proxy
                db.query(TrafficLogModel).filter(TrafficLogModel.proxy_id == db_proxy.id).delete(synchronize_session=False)
                db.bulk_insert_mappings(TrafficLogModel, to_insert)
                db.commit()
            except Exception as e:
                db.rollback()
                logger.error(f"DB insert failed for proxy {db_proxy.id}: {e}")
        
        return records, None
    except Exception as e:
        return [], str(e)


from fastapi import BackgroundTasks

@router.post("/traffic-logs/collect")
def collect_traffic_logs_task(
    proxy_ids: str = Query(..., description="Comma-separated list of proxy IDs"),
    background_tasks: BackgroundTasks = None,
    db: Session = Depends(get_db),
    q: Optional[str] = Query(default=None, max_length=256),
    limit: int = Query(default=5000, ge=1, le=50000),
    direction: str = Query(default="tail", pattern=r"^(head|tail)$"),
):
    """프록시에서 로그를 읽어와 DB에 저장하는 작업을 백그라운드에서 실행합니다."""
    try:
        p_ids = [int(x.strip()) for x in proxy_ids.split(",") if x.strip()]
    except ValueError:
        raise HTTPException(status_code=400, detail="Invalid proxy_ids format")

    proxies = db.query(Proxy).filter(Proxy.id.in_(p_ids)).filter(Proxy.is_active == True).all()
    if not proxies:
        raise HTTPException(status_code=404, detail="No active proxies found")

    q_valid = _validate_query(q)

    def background_collect():
        from app.database.database import SessionLocal

        def collect_one(p):
            local_db = SessionLocal()
            try:
                logger.info(f"[traffic_logs] Starting background collection for proxy {p.id}")
                _fetch_and_parse_for_proxy(p, q_valid, limit, direction, local_db)
                logger.info(f"[traffic_logs] Finished background collection for proxy {p.id}")
            except Exception as e:
                logger.error(f"[traffic_logs] Background collection failed for proxy {p.id}: {e}")
            finally:
                local_db.close()

        with ThreadPoolExecutor(max_workers=min(len(proxies), 4)) as executor:
            futures = [executor.submit(collect_one, p) for p in proxies]
            for future in as_completed(futures):
                try:
                    future.result()
                except Exception:
                    pass

    if background_tasks:
        background_tasks.add_task(background_collect)
    
    return {"message": "Collection started in background", "proxies": [p.id for p in proxies]}


@router.get("/traffic-logs", response_model=MultiTrafficLogResponse)
def get_multi_proxy_traffic_logs(
    proxy_ids: str = Query(..., description="Comma-separated list of proxy IDs"),
    db: Session = Depends(get_db),
    offset: int = Query(default=0, ge=0),
    limit: int = Query(default=100, ge=1, le=1000),
    sort_col: Optional[str] = Query(default="id"),
    sort_dir: str = Query(default="desc", pattern=r"^(asc|desc)$"),
    filter_col: Optional[str] = Query(default=None),
    filter_val: Optional[str] = Query(default=None),
):
    """DB에 저장된 로그를 페이징/정렬하여 조회합니다."""
    try:
        p_ids = [int(x.strip()) for x in proxy_ids.split(",") if x.strip()]
    except ValueError:
        raise HTTPException(status_code=400, detail="Invalid proxy_ids format")

    if not p_ids:
        return MultiTrafficLogResponse(requested=0, succeeded=0, failed=0, records=[], count=0, total_count=0)

    query = db.query(TrafficLogModel).filter(TrafficLogModel.proxy_id.in_(p_ids))

    # 필터 적용
    if filter_col and filter_val:
        col_attr = getattr(TrafficLogModel, filter_col, None)
        if col_attr:
            query = query.filter(col_attr.contains(filter_val))

    # 전체 카운트 (페이징 전)
    total_count = query.count()

    # 정렬 적용
    if sort_col:
        col_attr = getattr(TrafficLogModel, sort_col, None)
        if col_attr:
            if sort_dir == "desc":
                query = query.order_by(col_attr.desc())
            else:
                query = query.order_by(col_attr.asc())
    else:
        query = query.order_by(TrafficLogModel.id.desc())

    # 페이징 적용
    rows = query.offset(offset).limit(limit).all()
    
    # ORM 객체를 TrafficLogRecord 스키마로 변환
    records = []
    for row in rows:
        # dict 변환 시 _sa_instance_state 제외
        d = {c.name: getattr(row, c.name) for c in row.__table__.columns}
        records.append(TrafficLogRecord(**d))

    return MultiTrafficLogResponse(
        requested=len(p_ids),
        succeeded=len(p_ids), # DB 조회이므로 성공으로 간주
        failed=0,
        records=records,
        count=len(records),
        total_count=total_count,
        offset=offset,
        limit=limit
    )


def _human_bytes(n: int) -> str:
    n = int(n or 0)
    for unit in ["B", "KB", "MB", "GB", "TB"]:
        if n < 1024:
            return f"{n:.1f}{unit}"
        n //= 1024
    return f"{n:.1f}PB"


def _detect_traffic_anomalies(
    clients: List[Dict[str, Any]],
    client_blocked: Any,
    client_errors: Any,
) -> List[Dict[str, Any]]:
    import math

    if not clients:
        return []

    def _sigma(values: List[float]):
        if not values:
            return 0.0, 0.0
        mean = sum(values) / len(values)
        variance = sum((v - mean) ** 2 for v in values) / len(values)
        return mean, math.sqrt(variance)

    req_mean, req_std = _sigma([float(c["requests"]) for c in clients])
    recv_mean, recv_std = _sigma([float(c["recv_bytes"]) for c in clients])

    anomalies: List[Dict[str, Any]] = []

    for c in clients:
        ip = c["client_ip"]
        reqs = c["requests"]
        recv = c["recv_bytes"]
        blocked_n = client_blocked.get(ip, 0)
        errors_n = client_errors.get(ip, 0)

        # 차단율 이상
        if reqs >= 5 and blocked_n > 0:
            rate = blocked_n / reqs
            if rate >= 0.3:
                anomalies.append({
                    "type": "block_heavy",
                    "severity": "critical" if rate >= 0.6 else "warning",
                    "label": "차단 과다",
                    "subject": ip,
                    "detail": f"{rate:.0%} 차단율 ({blocked_n:,}/{reqs:,}건)",
                    "_sv": rate,
                })

        # HTTP 오류율 이상 (4xx/5xx)
        if reqs >= 5 and errors_n > 0:
            rate = errors_n / reqs
            if rate >= 0.3:
                anomalies.append({
                    "type": "error_heavy",
                    "severity": "critical" if rate >= 0.6 else "warning",
                    "label": "오류 집중",
                    "subject": ip,
                    "detail": f"{rate:.0%} 오류율 ({errors_n:,}/{reqs:,}건, 4xx/5xx)",
                    "_sv": rate,
                })

        # 요청 수 통계적 이상 (> 평균+2σ)
        if req_std > 0:
            z = (reqs - req_mean) / req_std
            if z > 2.0:
                anomalies.append({
                    "type": "request_heavy",
                    "severity": "critical" if z > 3.0 else "warning",
                    "label": "요청 과다",
                    "subject": ip,
                    "detail": f"{reqs:,}건 요청 (평균 대비 {z:.1f}σ)",
                    "_sv": z,
                })

        # 수신 트래픽 통계적 이상 (> 평균+2σ)
        if recv_std > 0:
            z = (recv - recv_mean) / recv_std
            if z > 2.0:
                anomalies.append({
                    "type": "traffic_heavy",
                    "severity": "critical" if z > 3.0 else "warning",
                    "label": "트래픽 과다",
                    "subject": ip,
                    "detail": f"수신 {_human_bytes(recv)} (평균 대비 {z:.1f}σ)",
                    "_sv": z,
                })

    anomalies.sort(key=lambda x: (0 if x["severity"] == "critical" else 1, -x.get("_sv", 0)))
    for a in anomalies:
        a.pop("_sv", None)
    return anomalies


@router.get("/traffic-logs/analyze")
def analyze_db_traffic_logs(
    proxy_ids: str = Query(..., description="Comma-separated proxy IDs"),
    db: Session = Depends(get_db),
):
    """DB에 저장된 전체 트래픽 로그를 분석합니다 (Top N 제한 없음)."""
    try:
        p_ids = [int(x.strip()) for x in proxy_ids.split(",") if x.strip()]
    except ValueError:
        raise HTTPException(status_code=400, detail="Invalid proxy_ids format")

    if not p_ids:
        raise HTTPException(status_code=400, detail="proxy_ids required")

    from collections import Counter, defaultdict

    rows = db.query(TrafficLogModel).filter(TrafficLogModel.proxy_id.in_(p_ids)).all()

    host_counter: Counter = Counter()
    client_req_counter: Counter = Counter()
    status_counter: Counter = Counter()
    proxy_counter: Counter = Counter()
    client_recv: defaultdict = defaultdict(int)
    client_sent: defaultdict = defaultdict(int)
    client_blocked: defaultdict = defaultdict(int)
    client_errors: defaultdict = defaultdict(int)
    host_recv: defaultdict = defaultdict(int)
    host_sent: defaultdict = defaultdict(int)

    blocked = 0
    total_recv = 0
    total_sent = 0
    unique_clients: set = set()
    unique_hosts: set = set()

    proxy_map: Dict[int, str] = {}
    for p in db.query(Proxy).filter(Proxy.id.in_(p_ids)).all():
        proxy_map[p.id] = p.host

    for row in rows:
        client_ip = str(row.client_ip or "")
        url_host = str(row.url_host or "")
        status = str(row.response_statuscode or "Unknown")
        recv_b = int(row.recv_byte or 0)
        sent_b = int(row.sent_byte or 0)
        action = str(row.action_names or "")
        proxy_label = proxy_map.get(row.proxy_id, f"#{row.proxy_id}")

        if client_ip:
            client_req_counter[client_ip] += 1
            unique_clients.add(client_ip)
            client_recv[client_ip] += max(0, recv_b)
            client_sent[client_ip] += max(0, sent_b)
            if action.strip().lower() == "block":
                client_blocked[client_ip] += 1
            try:
                sc = int(row.response_statuscode or 0)
                if 400 <= sc < 600:
                    client_errors[client_ip] += 1
            except Exception:
                pass
        if url_host:
            host_counter[url_host] += 1
            unique_hosts.add(url_host)
            host_recv[url_host] += max(0, recv_b)
            host_sent[url_host] += max(0, sent_b)

        status_counter[status] += 1
        proxy_counter[proxy_label] += 1

        if action.strip().lower() == "block":
            blocked += 1
        total_recv += max(0, recv_b)
        total_sent += max(0, sent_b)

    hosts = [
        {"host": h, "requests": c, "recv_bytes": host_recv[h], "sent_bytes": host_sent[h]}
        for h, c in host_counter.most_common()
    ]
    clients = [
        {"client_ip": ip, "requests": c, "recv_bytes": client_recv[ip], "sent_bytes": client_sent[ip]}
        for ip, c in client_req_counter.most_common()
    ]
    statuses = [{"status": s, "count": c} for s, c in status_counter.most_common()]
    proxies_dist = [{"proxy": p, "count": c} for p, c in proxy_counter.most_common()]
    anomalies = _detect_traffic_anomalies(clients, client_blocked, client_errors)

    return {
        "summary": {
            "total": len(rows),
            "blocked": blocked,
            "unique_clients": len(unique_clients),
            "unique_hosts": len(unique_hosts),
            "total_recv_bytes": total_recv,
            "total_sent_bytes": total_sent,
        },
        "hosts": hosts,
        "clients": clients,
        "statuses": statuses,
        "proxies": proxies_dist,
        "anomalies": anomalies,
    }


@router.get("/traffic-logs/{proxy_id}", response_model=TrafficLogResponse)
def get_proxy_traffic_logs(
	proxy_id: int,
	db: Session = Depends(get_db),
	q: Optional[str] = Query(default=None, max_length=256, description="Fixed-string search (grep -F)"),
	limit: int = Query(default=200, ge=1, le=10000),
	direction: str = Query(default="tail", pattern=r"^(head|tail)$"),
	parsed: bool = Query(default=False),
):
	db_proxy = db.query(Proxy).filter(Proxy.id == proxy_id).first()
	if not db_proxy:
		raise HTTPException(status_code=404, detail="Proxy not found")

	q_valid = _validate_query(q)

	if not parsed:
		# Raw mode: fetch once via SSH and return lines without parsing or DB insert
		command = _build_remote_command(db_proxy.traffic_log_path, q_valid, limit, direction)
		raw = _ssh_exec(db_proxy.host, db_proxy.port or 22, db_proxy.username, decrypt_string_if_encrypted(db_proxy.password), command)
		lines = [ln for ln in raw.split("\n") if ln]
		return TrafficLogResponse(proxy_id=proxy_id, lines=lines, records=None, truncated=len(lines) == limit, count=len(lines))

	records, err = _fetch_and_parse_for_proxy(db_proxy, q_valid, limit, direction, db)
	if err:
		raise HTTPException(status_code=502, detail=err)
	return TrafficLogResponse(proxy_id=proxy_id, lines=None, records=records, truncated=len(records) == limit, count=len(records))


@router.get("/traffic-logs/item/{record_id}", response_model=TrafficLogDB)
def get_traffic_log_detail(record_id: int, db: Session = Depends(get_db)):
    row = db.query(TrafficLogModel).filter(TrafficLogModel.id == record_id).first()
    if not row:
        raise HTTPException(status_code=404, detail="Record not found")
    return row


@router.post("/traffic-logs/analyze-upload")
async def analyze_traffic_log_upload(
	logfile: UploadFile = File(..., description="Traffic log file to analyze"),
	topN: int = Query(default=20, ge=1, le=100),
):
	"""Analyze an uploaded traffic-log file in a streaming manner and return summary data.

	This endpoint does not persist any data. It parses the uploaded file line-by-line and
	computes aggregates helpful for detecting proxy overload causes (heavy downloads/uploads,
	request spikes, blocks, hot URLs/hosts/clients, status distribution).
	"""

	# Defensive: restrict unbounded filenames/content-types
	if not logfile:
		raise HTTPException(status_code=400, detail="file is required")

	from collections import Counter, defaultdict

	host_counter: Counter[str] = Counter()
	url_counter: Counter[str] = Counter()
	client_req_counter: Counter[str] = Counter()
	# Data-centric counters: proxy perspective (recv/sent)
	client_recv_bytes: defaultdict[str, int] = defaultdict(int)
	client_sent_bytes: defaultdict[str, int] = defaultdict(int)
	host_recv_bytes: defaultdict[str, int] = defaultdict(int)
	host_sent_bytes: defaultdict[str, int] = defaultdict(int)
	blocked_count = 0
	total_recv = 0
	total_sent = 0
	parsed_lines = 0
	unparsed_lines = 0
	unique_clients: set[str] = set()
	unique_hosts: set[str] = set()
	earliest_dt = None
	latest_dt = None
	parsed_records: List[Dict[str, Any]] = []  # 파싱된 레코드 저장

	# Stream decode lines from the uploaded file without additional wrappers
	try:
		for bline in logfile.file:
			if not bline:
				continue
			line = bline.decode("utf-8", "ignore").rstrip("\n")
			if not line:
				continue
			try:
				rec = parse_log_line(line)
				parsed_lines += 1
				# 파싱된 레코드 저장 (그리드 표시용)
				parsed_records.append(rec)
			except Exception:
				unparsed_lines += 1
				continue

			client_ip = str(rec.get("client_ip") or "")
			url_host = str(rec.get("url_host") or "")
			url_path = str(rec.get("url_path") or "")
			status = rec.get("response_statuscode")
			recv_b = rec.get("recv_byte") or 0
			sent_b = rec.get("sent_byte") or 0
			action_names = str(rec.get("action_names") or "")
			block_id = str(rec.get("block_id") or "")
			dt_str = rec.get("datetime")

			# Counters
			if client_ip:
				client_req_counter[client_ip] += 1
				unique_clients.add(client_ip)
			if url_host:
				host_counter[url_host] += 1
				unique_hosts.add(url_host)
			# Join host and path for URL hotness (truncate key length reasonably)
			if url_host or url_path:
				url_key = (url_host + url_path)[:2048]
				url_counter[url_key] += 1

			# Byte aggregations per client
			if client_ip and isinstance(recv_b, int):
				v = max(0, recv_b)
				client_recv_bytes[client_ip] += v
				total_recv += v
			if client_ip and isinstance(sent_b, int):
				v = max(0, sent_b)
				client_sent_bytes[client_ip] += v
				total_sent += v
			if url_host and isinstance(recv_b, int):
				host_recv_bytes[url_host] += max(0, recv_b)
			if url_host and isinstance(sent_b, int):
				host_sent_bytes[url_host] += max(0, sent_b)

			# Blocked detection: action includes 'block' or block_id present
			act_eq_block = action_names.strip().lower() == "block"
			if act_eq_block:
				blocked_count += 1

			# Track time range if datetime present
			if dt_str:
				try:
					s = str(dt_str).strip()
					if s.startswith("[") and s.endswith("]"):
						s = s[1:-1]
					from datetime import datetime as _dt
					dt_val = _dt.strptime(s, "%d/%b/%Y:%H:%M:%S %z")
					if earliest_dt is None or dt_val < earliest_dt:
						earliest_dt = dt_val
					if latest_dt is None or dt_val > latest_dt:
						latest_dt = dt_val
				except Exception:
					pass

	except Exception as e:
		raise HTTPException(status_code=400, detail=f"failed to read file: {str(e)}")

	def top_n(counter_like, n: int):
		try:
			return counter_like.most_common(n)
		except AttributeError:
			# for dict-like totals
			items = list(counter_like.items())
			items.sort(key=lambda kv: kv[1], reverse=True)
			return items[:n]

	result = {
		"summary": {
			"total_lines": parsed_lines + unparsed_lines,
			"parsed_lines": parsed_lines,
			"unparsed_lines": unparsed_lines,
			"unique_clients": len(unique_clients),
			"unique_hosts": len(unique_hosts),
			"total_recv_bytes": total_recv,
			"total_sent_bytes": total_sent,
			"blocked_requests": blocked_count,
			"time_range_start": (earliest_dt.isoformat() if earliest_dt else None),
			"time_range_end": (latest_dt.isoformat() if latest_dt else None),
		},
		"top": {
			"hosts_by_requests": top_n(host_counter, topN),
			"urls_by_requests": top_n(url_counter, topN),
			"clients_by_requests": top_n(client_req_counter, topN),
			# New data-centric keys
			"clients_by_recv_bytes": top_n(client_recv_bytes, topN),
			"clients_by_sent_bytes": top_n(client_sent_bytes, topN),
			"hosts_by_recv_bytes": top_n(host_recv_bytes, topN),
			"hosts_by_sent_bytes": top_n(host_sent_bytes, topN),
			# Backward compatibility
			"clients_by_download_bytes": top_n(client_recv_bytes, topN),
			"clients_by_upload_bytes": top_n(client_sent_bytes, topN),
			"hosts_by_download_bytes": top_n(host_recv_bytes, topN),
			"hosts_by_upload_bytes": top_n(host_sent_bytes, topN),
		},
		"records": parsed_records,  # 파싱된 레코드 배열 추가
	}

	return result

