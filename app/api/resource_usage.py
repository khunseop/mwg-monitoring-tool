from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy.orm import Session
from typing import Dict, Any, List, Tuple, Optional
from datetime import timedelta, datetime
import asyncio
from asyncio import Semaphore
from app.utils.time import now_kst
import json
import os
import logging
import paramiko
from time import monotonic
import warnings
try:
    from cryptography.utils import CryptographyDeprecationWarning
    warnings.filterwarnings("ignore", category=CryptographyDeprecationWarning)
except Exception:
    pass

from app.database.database import get_db
from app.models.proxy import Proxy
from app.models.resource_usage import ResourceUsage as ResourceUsageModel
from app.schemas.resource_usage import (
    ResourceUsage as ResourceUsageSchema,
    CollectRequest,
    CollectResponse,
)

# aiosnmp import for SNMP operations
from aiosnmp import Snmp
from app.utils.crypto import decrypt_string_if_encrypted


router = APIRouter()
logger = logging.getLogger(__name__)


SUPPORTED_KEYS = {"cpu", "mem", "cc", "cs", "http", "https", "ftp"}

# Interface MBPS calculation constants
IF_IN_OCTETS_OID = "1.3.6.1.2.1.2.2.1.10"  # ifInOctets
IF_OUT_OCTETS_OID = "1.3.6.1.2.1.2.2.1.16"  # ifOutOctets
IF_DESCR_OID = "1.3.6.1.2.1.2.2.1.2"  # ifDescr
COUNTER32_MAX = 4294967295  # 2^32 - 1

# Cache for previous counter values: {(proxy_id, interface_index): (in_octets, out_octets, timestamp)}
_INTERFACE_COUNTER_CACHE: Dict[Tuple[int, int], Tuple[int, int, float]] = {}


async def _snmp_get(host: str, port: int, community: str, oid: str, timeout_sec: int = 2) -> float | None:
    try:
        async with Snmp(host=host, port=port, community=community, timeout=timeout_sec) as snmp:
            values = await snmp.get(oid)
            if values and len(values) > 0:
                return float(values[0].value)
            return None
    except Exception as exc:
        if logger.isEnabledFor(logging.DEBUG):
            logger.exception(f"[resource_usage] SNMP get failed host={host} oid={oid}: {exc}")
        return None


async def _snmp_walk(host: str, port: int, community: str, oid: str, timeout_sec: int = 5) -> Dict[int, int]:
    """
    Walk SNMP OID and return a dictionary mapping interface index to counter value.
    Returns {interface_index: counter_value}
    """
    result: Dict[int, int] = {}
    try:
        async with Snmp(host=host, port=port, community=community, timeout=timeout_sec) as snmp:
            values = await snmp.walk(oid)
            if values:
                for v in values:
                    try:
                        # OID format: 1.3.6.1.2.1.2.2.1.10.{interface_index}
                        oid_str = str(v.oid)
                        parts = oid_str.split('.')
                        if len(parts) > 0:
                            interface_index = int(parts[-1])
                            counter_value = int(v.value)
                            result[interface_index] = counter_value
                    except (ValueError, IndexError) as e:
                        if logger.isEnabledFor(logging.DEBUG):
                            logger.debug(f"[resource_usage] Failed to parse SNMP walk result oid={oid_str}: {e}")
                        continue
    except Exception as exc:
        if logger.isEnabledFor(logging.DEBUG):
            logger.exception(f"[resource_usage] SNMP walk failed host={host} oid={oid}: {exc}")
    return result


def _calculate_mbps(current: int, previous: int, time_diff_sec: float) -> float:
    """
    Calculate MBPS from counter difference, handling 32-bit counter wraps.
    """
    if time_diff_sec <= 0:
        return 0.0
    
    # Handle counter wrap: if current < previous, counter wrapped
    if current < previous:
        diff = (COUNTER32_MAX + 1 - previous) + current
    else:
        diff = current - previous
    
    # Convert octets to bits, then to megabits per second
    # (diff octets * 8 bits/octet) / (time_diff_sec * 1,000,000 bits/Mbit)
    mbps = (diff * 8.0) / (time_diff_sec * 1_000_000.0)
    return max(0.0, mbps)


async def _collect_interface_mbps(proxy: Proxy, community: str) -> Optional[Dict[str, Dict[str, float]]]:
    """
    Collect interface MBPS for all interfaces using SNMP 32-bit counters.
    Returns {interface_index: {"in_mbps": float, "out_mbps": float}} or None if failed.
    """
    try:
        # Walk to get all interface counters
        in_octets_task = _snmp_walk(proxy.host, 161, community, IF_IN_OCTETS_OID)
        out_octets_task = _snmp_walk(proxy.host, 161, community, IF_OUT_OCTETS_OID)
        
        in_octets_dict, out_octets_dict = await asyncio.gather(in_octets_task, out_octets_task)
        
        if not in_octets_dict and not out_octets_dict:
            return None
        
        # Get all interface indices
        all_indices = set(in_octets_dict.keys()) | set(out_octets_dict.keys())
        if not all_indices:
            return None
        
        current_time = monotonic()
        result: Dict[str, Dict[str, float]] = {}
        
        for if_index in all_indices:
            current_in = in_octets_dict.get(if_index, 0)
            current_out = out_octets_dict.get(if_index, 0)
            
            cache_key = (proxy.id, if_index)
            cached = _INTERFACE_COUNTER_CACHE.get(cache_key)
            
            if cached:
                prev_in, prev_out, prev_time = cached
                time_diff = current_time - prev_time
                
                # Only calculate if we have valid time difference (at least 1 second)
                if time_diff >= 1.0:
                    in_mbps = _calculate_mbps(current_in, prev_in, time_diff)
                    out_mbps = _calculate_mbps(current_out, prev_out, time_diff)
                    result[str(if_index)] = {
                        "in_mbps": round(in_mbps, 3),
                        "out_mbps": round(out_mbps, 3)
                    }
                    # Update cache only when we have valid time difference and calculated MBPS
                    _INTERFACE_COUNTER_CACHE[cache_key] = (current_in, current_out, current_time)
                else:
                    # Too soon, don't update cache to allow time to accumulate
                    # Return None or 0.0 to indicate insufficient time has passed
                    result[str(if_index)] = {
                        "in_mbps": 0.0,
                        "out_mbps": 0.0
                    }
            else:
                # First collection, no previous data - initialize cache
                result[str(if_index)] = {
                    "in_mbps": 0.0,
                    "out_mbps": 0.0
                }
                # Initialize cache for next collection
                _INTERFACE_COUNTER_CACHE[cache_key] = (current_in, current_out, current_time)
        
        return result if result else None
        
    except Exception as exc:
        if logger.isEnabledFor(logging.DEBUG):
            logger.exception(f"[resource_usage] Interface MBPS collection failed host={proxy.host}: {exc}")
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
    except Exception as exc:
        if logger.isEnabledFor(logging.DEBUG):
            logger.exception(f"[resource_usage] SSH exec failed host={host} cmd={command}: {exc}")
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
                decrypt_string_if_encrypted(getattr(proxy, "password", None)),
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
    result["interface_mbps"] = None
    
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

    # Always collect interface MBPS
    interface_mbps_task = _collect_interface_mbps(proxy, community)
    tasks.append(interface_mbps_task)
    keys.append("interface_mbps")

    if tasks:
        values = await asyncio.gather(*tasks, return_exceptions=True)
        for key, value in zip(keys, values):
            result[key] = None if isinstance(value, Exception) else value

    return proxy.id, result, None


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
            
            interface_mbps_data = metrics.get("interface_mbps")
            interface_mbps_json = json.dumps(interface_mbps_data) if interface_mbps_data else None
            
            model = ResourceUsageModel(
                proxy_id=proxy_id,
                cpu=metrics.get("cpu"),
                mem=metrics.get("mem"),
                cc=metrics.get("cc"),
                cs=metrics.get("cs"),
                http=metrics.get("http"),
                https=metrics.get("https"),
                ftp=metrics.get("ftp"),
                interface_mbps=interface_mbps_json,
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

    # Enforce 30-day retention after successful commit
    _enforce_resource_usage_retention(db, days=30)

    return CollectResponse(
        requested=len(proxies),
        succeeded=len(collected_models),
        failed=len(errors),
        errors=errors,
        items=collected_models,  # Pydantic will convert with from_attributes
    )

    # enforce 30-day retention after successful commit
    # Note: placed after return would be unreachable, so we move to just before returning if needed


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


# series endpoint removed; UI uses collect + latest buffering

def _enforce_resource_usage_retention(db: Session, days: int = 30) -> None:
    cutoff = now_kst() - timedelta(days=days)
    try:
        db.query(ResourceUsageModel).filter(ResourceUsageModel.collected_at < cutoff).delete(synchronize_session=False)
        db.commit()
    except Exception:
        try:
            db.rollback()
        except Exception:
            pass
        return

