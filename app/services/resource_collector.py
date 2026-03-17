import asyncio
import json
import logging
import os
import time
import paramiko
from datetime import timedelta
from typing import Dict, Any, List, Tuple, Optional
from time import monotonic
from sqlalchemy.orm import Session
from aiosnmp import Snmp

from app.models.proxy import Proxy
from app.models.resource_usage import ResourceUsage as ResourceUsageModel
from app.models.resource_config import ResourceConfig as ResourceConfigModel
from app.utils.time import now_kst, KST_TZ
from app.utils.crypto import decrypt_string_if_encrypted

logger = logging.getLogger(__name__)

SUPPORTED_KEYS = {"cpu", "mem", "cc", "cs", "http", "https", "http2", "blocked", "disk"}

# Interface MBPS calculation constants
IF_IN_OCTETS_OID = "1.3.6.1.2.1.2.2.1.10"  # ifInOctets
IF_OUT_OCTETS_OID = "1.3.6.1.2.1.2.2.1.16"  # ifOutOctets
IF_DESCR_OID = "1.3.6.1.2.1.2.2.1.2"  # ifDescr
COUNTER32_MAX = 4294967295  # 2^32 - 1

# Cache for previous counter values: {(proxy_id, interface_name, direction): (counter_value, timestamp)}
_INTERFACE_COUNTER_CACHE: Dict[Tuple[int, str, str], Tuple[int, float]] = {}

# Cache for global traffic counters: {(proxy_id, metric_key): (counter_value, timestamp)}
_GLOBAL_TRAFFIC_COUNTER_CACHE: Dict[Tuple[int, str], Tuple[int, float]] = {}

# Cache for interface config: (interface_oids, interface_thresholds, interface_bandwidths, config_updated_at)
_INTERFACE_CONFIG_CACHE: Optional[Tuple[Dict[str, Dict[str, str]], Dict[str, float], Dict[str, float], float]] = None
_INTERFACE_CONFIG_CACHE_LOCK = asyncio.Lock()

# SSH-based memory collection
DEFAULT_MEM_CMD = "awk '/MemTotal/ {total=$2} /MemAvailable/ {available=$2} END {printf \"%.0f\", 100 - (available / total * 100)}' /proc/meminfo"
_MEM_CACHE: dict[tuple[str, int, str, str], tuple[float, float]] = {}
_MEM_CACHE_TTL_SEC = 5.0
_SSH_MAX_CONCURRENCY = max(1, int(os.getenv("RU_SSH_MAX_CONCURRENCY", "8")))
_SSH_SEMAPHORE = asyncio.Semaphore(_SSH_MAX_CONCURRENCY)
_SSH_TIMEOUT_SEC = max(1, int(os.getenv("RU_SSH_TIMEOUT_SEC", "5")))


async def snmp_get(host: str, port: int, community: str, oid: str, timeout_sec: int = 2) -> float | None:
    try:
        async with Snmp(host=host, port=port, community=community, timeout=timeout_sec) as snmp:
            values = await snmp.get(oid)
            if values and len(values) > 0:
                value = float(values[0].value)
                logger.debug(f"[resource_collector] SNMP get success host={host} oid={oid} value={value}")
                return value
            logger.warning(f"[resource_collector] SNMP get returned no values host={host} oid={oid}")
            return None
    except Exception as exc:
        logger.warning(f"[resource_collector] SNMP get failed host={host} oid={oid}: {exc}")
        return None


async def snmp_walk(host: str, port: int, community: str, oid: str, timeout_sec: int = 5) -> Dict[int, int]:
    result: Dict[int, int] = {}
    try:
        async with Snmp(host=host, port=port, community=community, timeout=timeout_sec) as snmp:
            values = await snmp.walk(oid)
            if values:
                base_oid_parts = len(oid.split('.'))
                for v in values:
                    try:
                        oid_str = str(v.oid)
                        parts = oid_str.split('.')
                        if len(parts) > base_oid_parts:
                            interface_index = int(parts[-1])
                            counter_value = int(v.value)
                            result[interface_index] = counter_value
                    except (ValueError, IndexError):
                        continue
    except Exception as exc:
        logger.warning(f"[resource_collector] SNMP walk failed host={host} oid={oid}: {exc}")
    return result


async def snmp_walk_string(host: str, port: int, community: str, oid: str, timeout_sec: int = 5) -> Dict[int, str]:
    result: Dict[int, str] = {}
    try:
        async with Snmp(host=host, port=port, community=community, timeout=timeout_sec) as snmp:
            values = await snmp.walk(oid)
            if values:
                base_oid_parts = len(oid.split('.'))
                for v in values:
                    try:
                        oid_str = str(v.oid)
                        parts = oid_str.split('.')
                        if len(parts) > base_oid_parts:
                            interface_index = int(parts[-1])
                            string_value = str(v.value).strip()
                            result[interface_index] = string_value
                    except (ValueError, IndexError):
                        continue
    except Exception as exc:
        logger.warning(f"[resource_collector] SNMP walk string failed host={host} oid={oid}: {exc}")
    return result


def calculate_mbps(current: int, previous: int, time_diff_sec: float) -> float:
    if time_diff_sec <= 0:
        return 0.0
    if current < previous:
        diff = (COUNTER32_MAX + 1 - previous) + current
    else:
        diff = current - previous
    mbps = (diff * 8.0) / (time_diff_sec * 1_000_000.0)
    return max(0.0, mbps)


def is_system_interface(if_name: str) -> bool:
    if not if_name:
        return False
    if_name_lower = if_name.lower()
    if if_name_lower.startswith('lo') or if_name_lower.startswith('loopback'):
        return True
    if any(prefix in if_name_lower for prefix in ['veth', 'docker', 'br-', 'virbr']):
        return True
    return False


def ssh_exec_and_parse_mem(host: str, port: int, username: str, password: str | None, command: str, timeout_sec: int) -> float | None:
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
        if not stdout_str:
            return None
        first_line = stdout_str.splitlines()[0] if stdout_str else ""
        token = first_line.strip().split()[0] if first_line else ""
        try:
            val = float(token)
            return max(0.0, min(1000.0, val))
        except Exception:
            return None
    except Exception as exc:
        logger.warning(f"[resource_collector] SSH mem failed host={host}: {exc}")
        return None
    finally:
        try:
            client.close()
        except Exception:
            pass


def ssh_exec_and_parse_disk(host: str, port: int, user: str, password: str | None, path: str, timeout_sec: int) -> float | None:
    client = paramiko.SSHClient()
    client.set_missing_host_key_policy(paramiko.AutoAddPolicy())
    try:
        client.connect(host, port=port, username=user, password=password, timeout=timeout_sec)
        command = f"df -k {path} | awk 'END{{print $(NF-1)}}' | sed 's/%//'"
        _, stdout, stderr = client.exec_command(command, timeout=timeout_sec)
        stdout_str = stdout.read().decode().strip()
        if stdout_str:
            try:
                return float(stdout_str)
            except (ValueError, TypeError):
                return None
        return None
    except Exception as exc:
        logger.warning(f"[resource_collector] SSH disk failed host={host}: {exc}")
        return None
    finally:
        try:
            client.close()
        except Exception:
            pass


async def ssh_get_disk_usage(proxy: Proxy, timeout_sec: int = _SSH_TIMEOUT_SEC) -> float | None:
    if not proxy or not proxy.host or not proxy.username:
        return None
    path = "/opt"
    loop = asyncio.get_running_loop()
    async with _SSH_SEMAPHORE:
        return await loop.run_in_executor(
            None,
            lambda: ssh_exec_and_parse_disk(
                proxy.host,
                getattr(proxy, "port", 22) or 22,
                proxy.username,
                decrypt_string_if_encrypted(getattr(proxy, "password", None)),
                path,
                timeout_sec,
            ),
        )


async def ssh_get_mem_percent(proxy: Proxy, spec: str, timeout_sec: int = _SSH_TIMEOUT_SEC) -> float | None:
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
        value = await loop.run_in_executor(
            None,
            lambda: ssh_exec_and_parse_mem(
                proxy.host,
                getattr(proxy, "port", 22) or 22,
                proxy.username,
                decrypt_string_if_encrypted(getattr(proxy, "password", None)),
                cmd,
                timeout_sec,
            ),
        )
    if value is not None:
        _MEM_CACHE[key] = (value, now + _MEM_CACHE_TTL_SEC)
    return value


def invalidate_interface_config_cache():
    global _INTERFACE_CONFIG_CACHE
    _INTERFACE_CONFIG_CACHE = None


def get_interface_config_from_db(db: Session) -> Tuple[Dict[str, Dict[str, str]], Dict[str, float], Dict[str, float]]:
    global _INTERFACE_CONFIG_CACHE
    try:
        if _INTERFACE_CONFIG_CACHE is not None:
            interface_oids, interface_thresholds, interface_bandwidths, cached_at = _INTERFACE_CONFIG_CACHE
            cfg = db.query(ResourceConfigModel).order_by(ResourceConfigModel.id.asc()).first()
            if cfg and cfg.updated_at:
                cfg_updated_ts = cfg.updated_at.timestamp() if hasattr(cfg.updated_at, 'timestamp') else time.mktime(cfg.updated_at.timetuple())
                if cfg_updated_ts <= cached_at:
                    return interface_oids, interface_thresholds, interface_bandwidths
        
        cfg = db.query(ResourceConfigModel).order_by(ResourceConfigModel.id.asc()).first()
        if not cfg:
            return {}, {}, {}
        
        oids = json.loads(cfg.oids_json or '{}')
        interface_oids = {}
        interface_thresholds = {}
        interface_bandwidths = {}
        if isinstance(oids, dict):
            if isinstance(oids.get('__interface_oids__'), dict):
                interface_oids_raw = oids.get('__interface_oids__') or {}
                for if_name, oid_value in interface_oids_raw.items():
                    if isinstance(oid_value, str):
                        interface_oids[if_name] = {'in_oid': oid_value, 'out_oid': ''}
                    elif isinstance(oid_value, dict):
                        interface_oids[if_name] = oid_value
            if isinstance(oids.get('__interface_thresholds__'), dict):
                interface_thresholds = oids.get('__interface_thresholds__') or {}
            if isinstance(oids.get('__interface_bandwidths__'), dict):
                interface_bandwidths = oids.get('__interface_bandwidths__') or {}
        
        cache_timestamp = cfg.updated_at.timestamp() if cfg.updated_at and hasattr(cfg.updated_at, 'timestamp') else time.time()
        _INTERFACE_CONFIG_CACHE = (interface_oids, interface_thresholds, interface_bandwidths, cache_timestamp)
        return interface_oids, interface_thresholds, interface_bandwidths
    except Exception:
        return {}, {}, {}


async def collect_interface_mbps_from_oids(proxy: Proxy, community: str, interface_oids: Dict[str, Dict[str, str]]) -> Optional[Dict[str, Dict[str, Any]]]:
    if not interface_oids:
        return None
    try:
        current_time = monotonic()
        result: Dict[str, Dict[str, Any]] = {}
        tasks = []
        task_metadata = []
        for if_name, oids in interface_oids.items():
            in_oid = oids.get('in_oid', '').strip() if isinstance(oids, dict) else ''
            out_oid = oids.get('out_oid', '').strip() if isinstance(oids, dict) else ''
            if isinstance(oids, str): in_oid = oids.strip()
            
            if in_oid:
                tasks.append(snmp_get(proxy.host, 161, community, in_oid))
                task_metadata.append((if_name, 'in'))
            if out_oid:
                tasks.append(snmp_get(proxy.host, 161, community, out_oid))
                task_metadata.append((if_name, 'out'))
        
        if not tasks: return None
        counter_values = await asyncio.gather(*tasks, return_exceptions=True)
        
        for (if_name, direction), counter_value in zip(task_metadata, counter_values):
            if isinstance(counter_value, Exception) or counter_value is None: continue
            try:
                current_counter = int(counter_value)
            except (ValueError, TypeError): continue
            
            cache_key = (proxy.id, if_name, direction)
            cached = _INTERFACE_COUNTER_CACHE.get(cache_key)
            if if_name not in result:
                result[if_name] = {"in_mbps": 0.0, "out_mbps": 0.0, "name": if_name}
            
            if cached:
                prev_counter, prev_time = cached
                time_diff = current_time - prev_time
                if time_diff >= 1.0:
                    mbps = calculate_mbps(current_counter, prev_counter, time_diff)
                    if direction == 'in': result[if_name]["in_mbps"] = round(mbps, 3)
                    else: result[if_name]["out_mbps"] = round(mbps, 3)
            _INTERFACE_COUNTER_CACHE[cache_key] = (current_counter, current_time)
        return result if result else None
    except Exception:
        return None


async def collect_for_proxy(proxy: Proxy, oids: Dict[str, str], community: str, db: Optional[Session] = None, interface_oids: Optional[Dict[str, Dict[str, str]]] = None) -> Tuple[int, Dict[str, Any] | None, str | None]:
    result: Dict[str, Any] = {k: None for k in SUPPORTED_KEYS}
    result["interface_mbps"] = None
    
    proxy_oids_config = {}
    if proxy.oids_json:
        try:
            proxy_oids_config = json.loads(proxy.oids_json)
        except Exception: pass

    final_oids = dict(oids)
    for key, val in proxy_oids_config.items():
        if key in SUPPORTED_KEYS and val: final_oids[key] = val

    final_interface_oids = {}
    if "__interface_oids__" in proxy_oids_config and isinstance(proxy_oids_config["__interface_oids__"], dict):
        for if_name, oid_value in proxy_oids_config["__interface_oids__"].items():
            if isinstance(oid_value, str): final_interface_oids[if_name] = {'in_oid': oid_value, 'out_oid': ''}
            elif isinstance(oid_value, dict): final_interface_oids[if_name] = oid_value
    
    if not final_interface_oids:
        if interface_oids is not None: final_interface_oids = interface_oids
        elif db is not None: final_interface_oids, _, _ = get_interface_config_from_db(db)
    
    tasks: list = []
    keys: list[str] = []
    for key, oid in final_oids.items():
        if key not in SUPPORTED_KEYS: continue
        if key == "mem" and isinstance(oid, str) and oid.lower().strip().startswith("ssh"):
            keys.append(key); tasks.append(ssh_get_mem_percent(proxy, oid))
        elif key == "disk" and isinstance(oid, str) and oid.lower().strip().startswith("ssh"):
            keys.append(key); tasks.append(ssh_get_disk_usage(proxy))
        else:
            keys.append(key); tasks.append(snmp_get(proxy.host, 161, community, oid))

    if final_interface_oids:
        tasks.append(collect_interface_mbps_from_oids(proxy, community, final_interface_oids))
        keys.append("interface_mbps")

    if tasks:
        current_time = monotonic()
        values = await asyncio.gather(*tasks, return_exceptions=True)
        for key, value in zip(keys, values):
            if isinstance(value, Exception) or value is None:
                result[key] = None
                continue
            
            if key in ["http", "https", "http2", "blocked"]:
                try:
                    current_counter = int(value)
                    cache_key = (proxy.id, key)
                    cached = _GLOBAL_TRAFFIC_COUNTER_CACHE.get(cache_key)
                    if cached:
                        prev_counter, prev_time = cached
                        time_diff = current_time - prev_time
                        if time_diff >= 1.0:
                            if key == "blocked":
                                result[key] = float(current_counter - prev_counter) if current_counter >= prev_counter else 0.0
                            else:
                                result[key] = round(calculate_mbps(current_counter, prev_counter, time_diff), 3)
                            _GLOBAL_TRAFFIC_COUNTER_CACHE[cache_key] = (current_counter, current_time)
                        else: result[key] = 0.0
                    else:
                        result[key] = 0.0
                        _GLOBAL_TRAFFIC_COUNTER_CACHE[cache_key] = (current_counter, current_time)
                except (ValueError, TypeError): result[key] = 0.0
            else: result[key] = value
    
    log_parts = [f"host={proxy.host}", f"proxy_id={proxy.id}"]
    for key in SUPPORTED_KEYS:
        val = result.get(key)
        if val is not None:
            if key in ['cpu', 'mem', 'disk']: log_parts.append(f"{key}={val:.2f}%")
            else: log_parts.append(f"{key}={val}")
    
    if result.get("interface_mbps"):
        if_logs = [f"{n}(in={d.get('in_mbps',0):.2f},out={d.get('out_mbps',0):.2f})" for n, d in result["interface_mbps"].items()]
        log_parts.append(f"interfaces=[{','.join(if_logs)}]")
    
    logger.info(f"[resource_collector] Collected: {' '.join(log_parts)}")
    return proxy.id, result, None


def enforce_resource_usage_retention(db: Session, days: int = 90) -> None:
    cutoff = now_kst() - timedelta(days=days)
    try:
        db.query(ResourceUsageModel).filter(ResourceUsageModel.collected_at < cutoff).delete(synchronize_session=False)
        db.commit()
        logger.info(f"[resource_collector] Enforced retention policy: {days} days.")
    except Exception as e:
        logger.error(f"[resource_collector] Retention failed: {e}")
        db.rollback()
