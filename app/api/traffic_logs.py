from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy.orm import Session
from typing import Optional, List, Dict, Any
from datetime import datetime
import shlex
import paramiko

from app.database.database import get_db
from app.models.proxy import Proxy
from app.schemas.traffic_log import TrafficLogResponse, TrafficLogRecord, TrafficLogDB
from app.models.traffic_log import TrafficLog as TrafficLogModel
from app.utils.traffic_log_parser import parse_log_line
from app.utils.crypto import decrypt_string_if_encrypted


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
	client = paramiko.SSHClient()
	client.set_missing_host_key_policy(paramiko.AutoAddPolicy())
	try:
		client.connect(
			hostname=host,
			port=port,
			username=username,
			password=password,
			timeout=5.0,
			auth_timeout=5.0,
			banner_timeout=5.0,
		)
		stdin, stdout, stderr = client.exec_command(command, timeout=7.0)
		output = stdout.read().decode("utf-8", errors="replace")
		err = stderr.read().decode("utf-8", errors="replace")
		exit_status = stdout.channel.recv_exit_status()
		if exit_status != 0:
			raise HTTPException(status_code=502, detail=f"remote command failed: {err.strip() or exit_status}")
		return output
	except HTTPException:
		raise
	except Exception as e:
		raise HTTPException(status_code=502, detail=f"ssh error: {str(e)}")
	finally:
		try:
			client.close()
		except Exception:
			pass


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
	if not db_proxy.is_active:
		raise HTTPException(status_code=400, detail="Proxy is inactive")
	if not db_proxy.traffic_log_path:
		raise HTTPException(status_code=400, detail="traffic_log_path not configured for this proxy")
	if not db_proxy.host or not db_proxy.username:
		raise HTTPException(status_code=400, detail="proxy host/username not configured")

	q_valid = _validate_query(q)

	command = _build_remote_command(db_proxy.traffic_log_path, q_valid, limit, direction)
	raw = _ssh_exec(db_proxy.host, db_proxy.port or 22, db_proxy.username, decrypt_string_if_encrypted(db_proxy.password), command)
	lines = [ln for ln in raw.split("\n") if ln]
	truncated = len(lines) >= min(limit, len(lines)) and len(lines) == limit

	if not parsed:
		return TrafficLogResponse(proxy_id=proxy_id, lines=lines, records=None, truncated=truncated, count=len(lines))

	records: List[TrafficLogRecord] = []
	to_insert: List[Dict[str, Any]] = []
	collected_ts = datetime.utcnow()
	for ln in lines:
		try:
			rec_dict = parse_log_line(ln)
			records.append(TrafficLogRecord(**rec_dict))
			row = {
				"proxy_id": proxy_id,
				"collected_at": collected_ts,
			}
			row.update(rec_dict)
			to_insert.append(row)
		except Exception:
			records.append(TrafficLogRecord(url_path=ln))
	# Optional replacement semantics per request scope: if head/tail fetch is used, we choose to append current snapshot.
	# For analysis and detail view, we persist snapshot rows.
	if to_insert:
		try:
			# Use bulk insert for performance
			db.bulk_insert_mappings(TrafficLogModel, to_insert)
			db.commit()
		except Exception:
			# Fallback to row-by-row on error
			for r in to_insert:
				db.add(TrafficLogModel(**r))
			db.commit()
	return TrafficLogResponse(proxy_id=proxy_id, lines=None, records=records, truncated=truncated, count=len(records))


@router.get("/traffic-logs/item/{record_id}", response_model=TrafficLogDB)
def get_traffic_log_detail(record_id: int, db: Session = Depends(get_db)):
    row = db.query(TrafficLogModel).filter(TrafficLogModel.id == record_id).first()
    if not row:
        raise HTTPException(status_code=404, detail="Record not found")
    return row

