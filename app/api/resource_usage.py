from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy.orm import Session
from typing import Dict, Any, List, Tuple
import asyncio
from asyncio import Semaphore
from app.utils.time import now_kst
import json
import os
import logging
import paramiko
from time import monotonic
import warnings
from datetime import datetime, timedelta
try:
    from cryptography.utils import CryptographyDeprecationWarning
    warnings.filterwarnings("ignore", category=CryptographyDeprecationWarning)
except Exception:
    pass

from app.database.database import get_db, SessionLocal
from app.models.proxy import Proxy
from app.models.resource_usage import ResourceUsage as ResourceUsageModel
from app.schemas.resource_usage import (
    ResourceUsage as ResourceUsageSchema,
    CollectRequest,
    CollectResponse,
    SeriesRequest,
    SeriesResponse,
    SeriesItem,
    SeriesPoint,
)

# aiosnmp import for SNMP operations
from aiosnmp import Snmp


router = APIRouter()
logger = logging.getLogger(__name__)


SUPPORTED_KEYS = {"cpu", "mem", "cc", "cs", "http", "https", "ftp"}


async def _snmp_get(host: str, port: int, community: str, oid: str, timeout_sec: int = 2) -> float | None:
    try:
        async with Snmp(host=host, port=port, community=community, timeout=timeout_sec) as snmp:
            values = await snmp.get(oid)
            if values and len(values) > 0:
                return float(values[0].value)
            return None
    except Exception:
        return None


# =============================
# SSH-based memory collection
# =============================
DEFAULT_MEM_CMD = "awk '/MemTotal/ {total=$2} /MemAvailable/ {available=$2} END {printf \"%.0f\", 100 - (available / total * 100)}' /proc/meminfo"
_MEM_CACHE: dict[tuple[str, int, str, str], tuple[float, float]] = {}
_MEM_CACHE_TTL_SEC = 5.0
_SSH_MAX_CONCURRENCY = max(1, int(os.getenv("RU_SSH_MAX_CONCURRENCY", "8")))
_SSH_SEMAPHORE = Semaphore(_SSH_MAX_CONCURRENCY)
_SSH_TIMEOUT_SEC = max(1, int(os.getenv("RU_SSH_TIMEOUT_SEC", "5")))


def _ssh_exec_and_parse_mem(host: str, port: int, username: str, password: str | None, command: str, timeout_sec: int) -> float | None:
    client = paramiko.SSHClient()
    client.set_missing_host_key_policy(paramiko.AutoAddPolicy())
    try:
        client.connect(
            hostname=host,
            port=port or 22,
            username=username,
            password=password,
            timeout=timeout_sec,
            auth_timeout=timeout_sec,
            banner_timeout=timeout_sec,
            allow_agent=False,
            look_for_keys=False,
            compress=False,
            disabled_algorithms={"cipher": ["3des-cbc", "des-cbc"]},
        )
        stdin, stdout, stderr = client.exec_command(command, timeout=timeout_sec)
        stdout_str = stdout.read().decode(errors="ignore").strip()
        stderr_str = stderr.read().decode(errors="ignore").strip()
        if not stdout_str and stderr_str:
            return None
        # take first numeric token
        first_line = stdout_str.splitlines()[0] if stdout_str else ""
        token = first_line.strip().split()[0] if first_line else ""
        try:
            val = float(token)
            # clamp to [0, 1000] to avoid absurd values
            if val < 0:
                return 0.0
            if val > 1000:
                return 1000.0
            return val
        except Exception:
            return None
    except Exception:
        return None
    finally:
        try:
            client.close()
        except Exception:
            pass


async def _ssh_get_mem_percent(proxy: Proxy, spec: str, timeout_sec: int = _SSH_TIMEOUT_SEC) -> float | None:
    # spec formats: 'ssh' or 'ssh:<command>'
    if not proxy or not proxy.host or not proxy.username:
        return None
    cmd = DEFAULT_MEM_CMD
    s = (spec or "").strip()
    if ":" in s:
        _, after = s.split(":", 1)
        after = after.strip()
        if after:
            cmd = after
    key = (proxy.host, getattr(proxy, "port", 22) or 22, proxy.username or "", cmd)
    now = monotonic()
    cached = _MEM_CACHE.get(key)
    if cached and cached[1] > now:
        return cached[0]
    loop = asyncio.get_running_loop()
    async with _SSH_SEMAPHORE:
        t0 = monotonic()
        if logger.isEnabledFor(logging.DEBUG):
            logger.debug(f"[resource_usage] SSH mem start host={proxy.host} port={getattr(proxy, 'port', 22)} user={proxy.username} cmd={cmd}")
        value = await loop.run_in_executor(
            None,
            lambda: _ssh_exec_and_parse_mem(
                proxy.host,
                getattr(proxy, "port", 22) or 22,
                proxy.username,
                getattr(proxy, "password", None),
                cmd,
                timeout_sec,
            ),
        )
        t1 = monotonic()
        if logger.isEnabledFor(logging.DEBUG):
            logger.debug(f"[resource_usage] SSH mem end host={proxy.host} ms={(t1 - t0) * 1000:.1f} value={value}")
    if value is not None:
        _MEM_CACHE[key] = (value, now + _MEM_CACHE_TTL_SEC)
    return value


async def _collect_for_proxy(proxy: Proxy, oids: Dict[str, str], community: str) -> Tuple[int, Dict[str, Any] | None, str | None]:
    result: Dict[str, Any] = {k: None for k in SUPPORTED_KEYS}
    tasks: list = []
    keys: list[str] = []
    for key, oid in oids.items():
        if key not in SUPPORTED_KEYS:
            continue
        # Special handling for memory via SSH
        if key == "mem" and isinstance(oid, str) and oid.lower().strip().startswith("ssh"):
            if logger.isEnabledFor(logging.DEBUG):
                logger.debug(f"[resource_usage] Using SSH mem for host={proxy.host} oidSpec={oid}")
            keys.append(key)
            tasks.append(_ssh_get_mem_percent(proxy, oid))
        else:
            keys.append(key)
            tasks.append(_snmp_get(proxy.host, 161, community, oid))

    if tasks:
        values = await asyncio.gather(*tasks, return_exceptions=True)
        for key, value in zip(keys, values):
            result[key] = None if isinstance(value, Exception) else value

    return proxy.id, result, None


class _MonitorState:
    """Holds state for the background monitoring task."""

    def __init__(self) -> None:
        self.task: asyncio.Task | None = None
        self.stop_event: asyncio.Event | None = None
        self.params: dict[str, Any] | None = None
        self.started_at: datetime | None = None
        self.last_run_at: datetime | None = None
        self.interval_sec: int = 30
        self.last_cleanup_at: datetime | None = None


_monitor = _MonitorState()


def _retention_days() -> int:
    try:
        d = int(os.getenv("RU_RETENTION_DAYS", "30"))
        return max(1, min(365, d))
    except Exception:
        return 30


def _cleanup_old_data(db: Session, *, now_ts: datetime | None = None) -> int:
    """Delete rows older than retention window. Returns number of rows scheduled for deletion.

    With SQLite, rowcount may be -1; we do not rely on it for correctness.
    """
    now_dt = now_ts or now_kst()
    cutoff = now_dt - timedelta(days=_retention_days())
    try:
        deleted = (
            db.query(ResourceUsageModel)
            .filter(ResourceUsageModel.collected_at < cutoff)
            .delete(synchronize_session=False)
        )
        db.commit()
        return int(deleted or 0)
    except Exception:
        db.rollback()
        return 0


async def _monitor_loop(params: dict[str, Any]) -> None:
    """Background loop to collect resource usage at fixed intervals.

    params keys: proxy_ids: List[int], community: str, oids: Dict[str,str], interval_sec: int
    """
    global _monitor
    interval_sec: int = int(params.get("interval_sec") or 30)
    proxy_ids: List[int] = list(params.get("proxy_ids") or [])
    community: str = str(params.get("community") or "public")
    oids: Dict[str, str] = dict(params.get("oids") or {})
    if not proxy_ids or not oids:
        return

    # basic guardrail
    interval_sec = max(5, min(3600, interval_sec))

    while _monitor.stop_event and not _monitor.stop_event.is_set():
        t_start = monotonic()
        try:
            db = SessionLocal()
            try:
                proxies: List[Proxy] = (
                    db.query(Proxy)
                    .filter(Proxy.is_active == True)
                    .filter(Proxy.id.in_(proxy_ids))
                    .all()
                )
                errors: Dict[int, str] = {}
                collected_models: List[ResourceUsageModel] = []

                tasks = [_collect_for_proxy(p, oids, community) for p in proxies]
                results = await asyncio.gather(*tasks, return_exceptions=True)
                for proxy, result in zip(proxies, results):
                    try:
                        if isinstance(result, Exception):
                            errors[proxy.id] = str(result)
                            continue
                        proxy_id, metrics, err = result
                        if err:
                            errors[proxy_id] = err
                            continue
                        model = ResourceUsageModel(
                            proxy_id=proxy_id,
                            cpu=metrics.get("cpu"),
                            mem=metrics.get("mem"),
                            cc=metrics.get("cc"),
                            cs=metrics.get("cs"),
                            http=metrics.get("http"),
                            https=metrics.get("https"),
                            ftp=metrics.get("ftp"),
                            community=community,
                            oids_raw=json.dumps(oids),
                            collected_at=now_kst(),
                        )
                        db.add(model)
                        collected_models.append(model)
                    except Exception as e:
                        errors[proxy.id] = str(e)

                db.commit()
                for m in collected_models:
                    try:
                        db.refresh(m)
                    except Exception:
                        pass

                # retention cleanup at most once per hour
                now_dt = now_kst()
                if (
                    _monitor.last_cleanup_at is None
                    or (now_dt - _monitor.last_cleanup_at) >= timedelta(hours=1)
                ):
                    _cleanup_old_data(db, now_ts=now_dt)
                    _monitor.last_cleanup_at = now_dt

                _monitor.last_run_at = now_dt
            finally:
                db.close()
        except Exception as e:
            if logger.isEnabledFor(logging.ERROR):
                logger.error(f"[resource_usage] monitor loop error: {e}")

        # sleep respecting stop_event
        t_elapsed = monotonic() - t_start
        remaining = max(0.0, float(interval_sec) - t_elapsed)
        try:
            await asyncio.wait_for(_monitor.stop_event.wait(), timeout=remaining)
        except asyncio.TimeoutError:
            pass


@router.post("/resource-usage/monitor/start")
async def start_monitor(payload: CollectRequest = None, interval_sec: int = Query(30, ge=5, le=3600)):
    """Start background monitoring with provided selection and interval.

    Body payload follows CollectRequest (proxy_ids, community, oids).
    """
    global _monitor
    if _monitor.task and not _monitor.task.done():
        raise HTTPException(status_code=409, detail="Monitor already running")
    if not payload or not payload.proxy_ids or not payload.oids or not payload.community:
        raise HTTPException(status_code=400, detail="proxy_ids, community and oids are required")

    _monitor.stop_event = asyncio.Event()
    _monitor.params = {
        "proxy_ids": payload.proxy_ids,
        "community": payload.community,
        "oids": payload.oids,
        "interval_sec": int(interval_sec),
    }
    _monitor.interval_sec = int(interval_sec)
    _monitor.started_at = now_kst()
    _monitor.last_run_at = None
    _monitor.task = asyncio.create_task(_monitor_loop(dict(_monitor.params)))
    return {
        "status": "started",
        "interval_sec": _monitor.interval_sec,
        "proxy_count": len(payload.proxy_ids),
        "started_at": _monitor.started_at,
    }


@router.post("/resource-usage/monitor/stop")
async def stop_monitor():
    global _monitor
    if not _monitor.task or _monitor.task.done():
        return {"status": "stopped"}
    if _monitor.stop_event:
        _monitor.stop_event.set()
    try:
        await asyncio.wait_for(_monitor.task, timeout=10)
    except Exception:
        pass
    finally:
        _monitor.task = None
        _monitor.stop_event = None
        _monitor.params = None
    return {"status": "stopped"}


@router.get("/resource-usage/monitor/status")
async def monitor_status():
    global _monitor
    running = bool(_monitor.task and not _monitor.task.done())
    return {
        "running": running,
        "interval_sec": _monitor.interval_sec if running else None,
        "started_at": _monitor.started_at,
        "last_run_at": _monitor.last_run_at,
        "params": _monitor.params or {},
        "retention_days": _retention_days(),
    }


@router.post("/resource-usage/collect", response_model=CollectResponse)
async def collect_resource_usage(payload: CollectRequest, db: Session = Depends(get_db)):
    if not payload.oids:
        raise HTTPException(status_code=400, detail="oids mapping is required")
    if not payload.proxy_ids or len(payload.proxy_ids) == 0:
        raise HTTPException(status_code=400, detail="proxy_ids is required and cannot be empty")
    if not payload.community:
        raise HTTPException(status_code=400, detail="community is required")

    query = db.query(Proxy).filter(Proxy.is_active == True).filter(Proxy.id.in_(payload.proxy_ids))
    proxies: List[Proxy] = query.all()

    if not proxies:
        return CollectResponse(requested=0, succeeded=0, failed=0, errors={}, items=[])

    errors: Dict[int, str] = {}
    collected_models: List[ResourceUsageModel] = []

    # Gather all SNMP collection tasks
    tasks = [_collect_for_proxy(p, payload.oids, payload.community) for p in proxies]
    results = await asyncio.gather(*tasks, return_exceptions=True)
    
    for proxy, result in zip(proxies, results):
        try:
            if isinstance(result, Exception):
                errors[proxy.id] = str(result)
                continue
            proxy_id, metrics, err = result
            if err:
                errors[proxy_id] = err
                continue
            
            model = ResourceUsageModel(
                proxy_id=proxy_id,
                cpu=metrics.get("cpu"),
                mem=metrics.get("mem"),
                cc=metrics.get("cc"),
                cs=metrics.get("cs"),
                http=metrics.get("http"),
                https=metrics.get("https"),
                ftp=metrics.get("ftp"),
                community=payload.community,
                oids_raw=json.dumps(payload.oids),
                collected_at=now_kst(),
            )
            db.add(model)
            collected_models.append(model)
        except Exception as e:
            errors[proxy.id] = str(e)

    db.commit()
    for model in collected_models:
        db.refresh(model)

    return CollectResponse(
        requested=len(proxies),
        succeeded=len(collected_models),
        failed=len(errors),
        errors=errors,
        items=collected_models,  # Pydantic will convert with from_attributes
    )


@router.get("/resource-usage", response_model=List[ResourceUsageSchema])
async def list_resource_usage(
    db: Session = Depends(get_db),
    limit: int = Query(100, ge=1, le=1000),
    offset: int = Query(0, ge=0),
):
    rows = (
        db.query(ResourceUsageModel)
        .order_by(ResourceUsageModel.collected_at.desc())
        .offset(offset)
        .limit(limit)
        .all()
    )
    return rows


@router.get("/resource-usage/latest/{proxy_id}", response_model=ResourceUsageSchema)
async def latest_resource_usage(proxy_id: int, db: Session = Depends(get_db)):
    row = (
        db.query(ResourceUsageModel)
        .filter(ResourceUsageModel.proxy_id == proxy_id)
        .order_by(ResourceUsageModel.collected_at.desc())
        .first()
    )
    if not row:
        raise HTTPException(status_code=404, detail="No resource usage found for proxy")
    return row


@router.get("/resource-usage/series", response_model=SeriesResponse)
async def series_resource_usage(
    db: Session = Depends(get_db),
    proxy_ids: List[int] = Query(..., alias="proxy_ids"),
    start: datetime | None = Query(None),
    end: datetime | None = Query(None),
):
    if not proxy_ids:
        raise HTTPException(status_code=400, detail="proxy_ids is required")
    # default to last retention window
    now_dt = now_kst()
    cutoff = now_dt - timedelta(days=_retention_days())
    if start is None:
        start_dt = cutoff
    else:
        start_dt = start if start.tzinfo else start.replace(tzinfo=now_dt.tzinfo)
        if start_dt < cutoff:
            start_dt = cutoff
    if end is None:
        end_dt = now_dt
    else:
        end_dt = end if end.tzinfo else end.replace(tzinfo=now_dt.tzinfo)
    if end_dt < start_dt:
        raise HTTPException(status_code=400, detail="end must be >= start")

    rows = (
        db.query(ResourceUsageModel)
        .filter(ResourceUsageModel.proxy_id.in_(proxy_ids))
        .filter(ResourceUsageModel.collected_at >= start_dt)
        .filter(ResourceUsageModel.collected_at <= end_dt)
        .order_by(ResourceUsageModel.collected_at.asc())
        .all()
    )
    by_proxy: Dict[int, List[SeriesPoint]] = {pid: [] for pid in proxy_ids}
    for r in rows:
        by_proxy.setdefault(r.proxy_id, []).append(
            SeriesPoint(
                ts=r.collected_at,
                cpu=r.cpu,
                mem=r.mem,
                cc=r.cc,
                cs=r.cs,
                http=r.http,
                https=r.https,
                ftp=r.ftp,
            )
        )
    items = [SeriesItem(proxy_id=pid, points=by_proxy.get(pid, [])) for pid in proxy_ids]
    return SeriesResponse(items=items)

