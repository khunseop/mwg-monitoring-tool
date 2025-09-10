from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy.orm import Session
from typing import List, Optional
from fastapi import Query
import shlex
import paramiko
from app.schemas.traffic_log import TrafficLogResponse, TrafficLogRecord
from app.utils.traffic_log_parser import parse_log_line

from app.database.database import get_db
from app.models.proxy import Proxy
from sqlalchemy.orm import joinedload
from app.schemas.proxy import ProxyCreate, ProxyUpdate, ProxyOut
from sqlalchemy import func

router = APIRouter()

@router.get("/proxies", response_model=List[ProxyOut])
def get_proxies(
    db: Session = Depends(get_db),
    limit: int = Query(50, ge=1, le=500),
    offset: int = Query(0, ge=0),
):
    return (
        db.query(Proxy)
        .options(joinedload(Proxy.group))
        .offset(offset)
        .limit(limit)
        .all()
    )

@router.get("/proxies/{proxy_id}", response_model=ProxyOut)
def get_proxy(proxy_id: int, db: Session = Depends(get_db)):
    proxy = (
        db.query(Proxy)
        .options(joinedload(Proxy.group))
        .filter(Proxy.id == proxy_id)
        .first()
    )
    if not proxy:
        raise HTTPException(status_code=404, detail="Proxy not found")
    return proxy

@router.post("/proxies", response_model=ProxyOut, status_code=status.HTTP_201_CREATED)
def create_proxy(proxy: ProxyCreate, db: Session = Depends(get_db)):
    # Duplicate host guard (case-insensitive)
    existing = (
        db.query(Proxy)
        .filter(func.lower(Proxy.host) == func.lower(proxy.host))
        .first()
    )
    if existing:
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="Proxy host already exists")
    db_proxy = Proxy(**proxy.model_dump())
    db.add(db_proxy)
    db.commit()
    db.refresh(db_proxy)
    return db_proxy

@router.put("/proxies/{proxy_id}", response_model=ProxyOut)
def update_proxy(proxy_id: int, proxy: ProxyUpdate, db: Session = Depends(get_db)):
    db_proxy = db.query(Proxy).filter(Proxy.id == proxy_id).first()
    if not db_proxy:
        raise HTTPException(status_code=404, detail="Proxy not found")
    
    update_data = proxy.model_dump(exclude_unset=True)
    
    # 비밀번호가 제공되지 않은 경우 업데이트에서 제외
    if not update_data.get('password'):
        update_data.pop('password', None)

    # If host is being updated, enforce uniqueness (case-insensitive)
    if 'host' in update_data and update_data['host']:
        dup = (
            db.query(Proxy)
            .filter(func.lower(Proxy.host) == func.lower(update_data['host']))
            .filter(Proxy.id != proxy_id)
            .first()
        )
        if dup:
            raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="Proxy host already exists")
    
    for key, value in update_data.items():
        setattr(db_proxy, key, value)
    
    db.commit()
    db.refresh(db_proxy)
    return db_proxy

@router.delete("/proxies/{proxy_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_proxy(proxy_id: int, db: Session = Depends(get_db)):
    db_proxy = db.query(Proxy).filter(Proxy.id == proxy_id).first()
    if not db_proxy:
        raise HTTPException(status_code=404, detail="Proxy not found")
    
    db.delete(db_proxy)
    db.commit()
    return None

def _validate_query(q: Optional[str]) -> Optional[str]:
    if q is None:
        return None
    if len(q) == 0:
        return None
    if len(q) > 256:
        raise HTTPException(status_code=400, detail="q too long (max 256)")
    # forbid control chars (except tab), and forbid newlines
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
    # no query: just head/tail file
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
        # Read with a hard cap as well
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


@router.get("/proxies/{proxy_id}/logs/traffic", response_model=TrafficLogResponse)
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
    raw = _ssh_exec(db_proxy.host, db_proxy.port or 22, db_proxy.username, db_proxy.password, command)
    # Split into lines, discard trailing empty
    lines = [ln for ln in raw.split("\n") if ln]
    truncated = len(lines) >= min(limit, len(lines)) and len(lines) == limit

    if not parsed:
        return TrafficLogResponse(proxy_id=proxy_id, lines=lines, records=None, truncated=truncated, count=len(lines))

    records: List[TrafficLogRecord] = []
    for ln in lines:
        try:
            rec_dict = parse_log_line(ln)
            records.append(TrafficLogRecord(**rec_dict))
        except Exception:
            # On parse error, include minimal record with raw line mapped to url_path for visibility
            records.append(TrafficLogRecord(url_path=ln))
    return TrafficLogResponse(proxy_id=proxy_id, lines=None, records=records, truncated=truncated, count=len(records))

