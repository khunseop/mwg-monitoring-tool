from fastapi import APIRouter, Depends, HTTPException, Query, UploadFile, File
from sqlalchemy.orm import Session
from typing import Optional, List, Dict, Any
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


router = APIRouter()


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
	base_prefix = "timeout 5s nice -n 10 ionice -c2 -n7 "
	clean_filter = " | sed -e 's/[^[:print:]\t]//g' | head -c 1048576 | cat"
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


@router.get("/traffic-logs", response_model=MultiTrafficLogResponse)
def get_multi_proxy_traffic_logs(
    proxy_ids: str = Query(..., description="Comma-separated list of proxy IDs"),
    db: Session = Depends(get_db),
    q: Optional[str] = Query(default=None, max_length=256, description="Fixed-string search (grep -F)"),
    limit: int = Query(default=200, ge=1, le=1000),
    direction: str = Query(default="tail", pattern=r"^(head|tail)$"),
):
    """여러 프록시의 로그를 동시에 조회합니다."""
    try:
        p_ids = [int(x.strip()) for x in proxy_ids.split(",") if x.strip()]
    except ValueError:
        raise HTTPException(status_code=400, detail="Invalid proxy_ids format")

    if not p_ids:
        raise HTTPException(status_code=400, detail="No proxy IDs provided")

    proxies = db.query(Proxy).filter(Proxy.id.in_(p_ids)).filter(Proxy.is_active == True).all()
    if not proxies:
        return MultiTrafficLogResponse(requested=len(p_ids), succeeded=0, failed=len(p_ids), records=[], count=0)

    q_valid = _validate_query(q)
    
    all_records: List[TrafficLogRecord] = []
    errors: Dict[int, str] = {}
    succeeded = 0
    
    # Use ThreadPoolExecutor for parallel SSH
    from app.database.database import SessionLocal
    
    with ThreadPoolExecutor(max_workers=min(10, len(proxies))) as executor:
        # Each thread gets its own DB session
        def task(p):
            local_db = SessionLocal()
            try:
                return _fetch_and_parse_for_proxy(p, q_valid, limit, direction, local_db)
            finally:
                local_db.close()
                
        future_to_proxy = {executor.submit(task, p): p for p in proxies}
        
        for future in as_completed(future_to_proxy):
            proxy = future_to_proxy[future]
            try:
                records, err = future.result()
                if err:
                    errors[proxy.id] = err
                else:
                    all_records.extend(records)
                    succeeded += 1
            except Exception as e:
                errors[proxy.id] = str(e)

    # Sort all records by datetime if possible (most recent first)
    # Note: datetime format is "dd/MMM/yyyy:HH:mm:ss Z" or similar
    def parse_ts(r):
        if not r.datetime: return 0
        try:
            s = r.datetime.strip("[]")
            return datetime.strptime(s, "%d/%b/%Y:%H:%M:%S %z").timestamp()
        except: return 0

    all_records.sort(key=parse_ts, reverse=True)

    return MultiTrafficLogResponse(
        requested=len(p_ids),
        succeeded=succeeded,
        failed=len(p_ids) - succeeded,
        errors=errors,
        records=all_records,
        count=len(all_records)
    )


@router.get("/traffic-logs/{proxy_id}", response_model=TrafficLogResponse)
def get_proxy_traffic_logs(
	proxy_id: int,
	db: Session = Depends(get_db),
	q: Optional[str] = Query(default=None, max_length=256, description="Fixed-string search (grep -F)"),
	limit: int = Query(default=200, ge=1, le=1000),
	direction: str = Query(default="tail", pattern=r"^(head|tail)$"),
	parsed: bool = Query(default=False),
):
	db_proxy = db.query(Proxy).filter(Proxy.id == proxy_id).first()
	if not db_proxy:
		raise HTTPException(status_code=404, detail="Proxy not found")
	
    # Single proxy fetch using the helper
	records, err = _fetch_and_parse_for_proxy(db_proxy, _validate_query(q), limit, direction, db)
	if err:
		raise HTTPException(status_code=502, detail=err)
        
	if not parsed:
		# Compatibility: return lines if requested (raw)
		command = _build_remote_command(db_proxy.traffic_log_path, q, limit, direction)
		raw = _ssh_exec(db_proxy.host, db_proxy.port or 22, db_proxy.username, decrypt_string_if_encrypted(db_proxy.password), command)
		lines = [ln for ln in raw.split("\n") if ln]
		return TrafficLogResponse(proxy_id=proxy_id, lines=lines, records=None, truncated=len(lines) == limit, count=len(lines))

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

