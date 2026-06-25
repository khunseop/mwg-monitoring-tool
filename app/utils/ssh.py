import paramiko
import threading
import time
import logging
import socket
from typing import Optional, Dict, Any, Tuple

logger = logging.getLogger(__name__)

class SSHPool:
    """
    SSH Connection Pool to reuse sessions and keep them alive.
    """
    _instance = None
    _lock = threading.Lock()

    def __new__(cls):
        with cls._lock:
            if cls._instance is None:
                cls._instance = super(SSHPool, cls).__new__(cls)
                cls._instance.connections = {}  # (host, port, username): (client, last_used)
                cls._instance.pool_lock = threading.Lock()
        return cls._instance

    def get_client(
        self,
        host: str,
        port: int,
        username: str,
        password: Optional[str],
        timeout_sec: int = 10,
        auth_timeout_sec: Optional[int] = None,
        banner_timeout_sec: Optional[int] = None,
        disabled_algorithms: Optional[Dict[str, Any]] = None,
        look_for_keys: bool = False,
        allow_agent: bool = False,
    ) -> paramiko.SSHClient:
        key = (host, port, username)
        
        with self.pool_lock:
            if key in self.connections:
                client, _ = self.connections[key]
                if client.get_transport() and client.get_transport().is_active():
                    # Update last used time
                    self.connections[key] = (client, time.time())
                    return client
                else:
                    # Clean up broken connection
                    logger.info(f"[SSHPool] Connection to {host}:{port} is inactive. Reconnecting...")
                    try:
                        client.close()
                    except:
                        pass
                    del self.connections[key]

            # Create new connection
            client = paramiko.SSHClient()
            client.set_missing_host_key_policy(paramiko.AutoAddPolicy())
            
            client.connect(
                hostname=host,
                port=port,
                username=username,
                password=password,
                timeout=timeout_sec,
                auth_timeout=auth_timeout_sec or timeout_sec,
                banner_timeout=banner_timeout_sec or timeout_sec,
                look_for_keys=look_for_keys,
                allow_agent=allow_agent,
                disabled_algorithms=disabled_algorithms or {"cipher": ["3des-cbc", "des-cbc"]},
            )
            
            # Set keepalive (sends global request every 60s)
            transport = client.get_transport()
            if transport:
                transport.set_keepalive(60)
            
            self.connections[key] = (client, time.time())
            logger.info(f"[SSHPool] New connection established to {host}:{port}")
            return client

    def close_all(self):
        with self.pool_lock:
            for key, (client, _) in self.connections.items():
                try:
                    client.close()
                except:
                    pass
            self.connections.clear()
            logger.info("[SSHPool] All connections closed")

ssh_pool = SSHPool()

# 재시도 불가 예외 — 인증 실패, 알 수 없는 호스트 등은 재시도해도 무의미
_NO_RETRY_EXCEPTIONS = (
    paramiko.AuthenticationException,
    paramiko.BadHostKeyException,
)


def ssh_exec(
    host: str,
    port: int,
    username: str,
    password: Optional[str],
    command: str,
    *,
    timeout_sec: int = 15,
    auth_timeout_sec: Optional[int] = None,
    banner_timeout_sec: Optional[int] = None,
    host_key_policy: str = "auto_add",
    disabled_algorithms: Optional[Dict[str, Any]] = None,
    look_for_keys: bool = False,
    allow_agent: bool = False,
    use_pool: bool = True,
    max_retries: int = 3,
) -> str:
    """Execute a remote command over SSH and return stdout.

    타임아웃·연결 끊김 등 일시적 에러는 exponential backoff 후 최대 max_retries회 재시도한다.
    인증 실패(AuthenticationException) 등은 즉시 실패 처리한다.
    """
    last_exc: Exception = RuntimeError("SSH exec failed")

    for attempt in range(max_retries):
        try:
            if not use_pool:
                result = _ssh_exec_oneshot(
                    host, port, username, password, command,
                    timeout_sec, auth_timeout_sec, banner_timeout_sec,
                    disabled_algorithms, look_for_keys, allow_agent,
                )
            else:
                result = _ssh_exec_pooled(
                    host, port, username, password, command,
                    timeout_sec, auth_timeout_sec, banner_timeout_sec,
                    disabled_algorithms, look_for_keys, allow_agent,
                )
            return result
        except _NO_RETRY_EXCEPTIONS:
            raise
        except Exception as e:
            last_exc = e
            if attempt < max_retries - 1:
                wait = 2 ** attempt  # 1s, 2s, 4s …
                logger.warning(
                    "[SSHPool] %s:%s 연결 실패 (시도 %d/%d), %ds 후 재시도: %s",
                    host, port, attempt + 1, max_retries, wait, e,
                )
                time.sleep(wait)

    logger.error("[SSHPool] %s:%s 최대 재시도 초과: %s", host, port, last_exc)
    raise RuntimeError(str(last_exc))


def _ssh_exec_oneshot(
    host: str, port: int, username: str, password: Optional[str], command: str,
    timeout_sec: int, auth_timeout_sec: Optional[int], banner_timeout_sec: Optional[int],
    disabled_algorithms: Optional[Dict[str, Any]], look_for_keys: bool, allow_agent: bool,
) -> str:
    client = paramiko.SSHClient()
    client.set_missing_host_key_policy(paramiko.AutoAddPolicy())
    try:
        client.connect(
            hostname=host,
            port=port,
            username=username,
            password=password,
            timeout=timeout_sec,
            auth_timeout=auth_timeout_sec or timeout_sec,
            banner_timeout=banner_timeout_sec or timeout_sec,
            look_for_keys=look_for_keys,
            allow_agent=allow_agent,
            disabled_algorithms=disabled_algorithms or {"cipher": ["3des-cbc", "des-cbc"]},
        )
        stdin, stdout, stderr = client.exec_command(command, timeout=timeout_sec)
        stdout_str = stdout.read().decode(errors="ignore")
        stderr_str = stderr.read().decode(errors="ignore")
        exit_status = stdout.channel.recv_exit_status()
        if exit_status != 0 and not stdout_str:
            raise RuntimeError(stderr_str.strip() or f"exit status {exit_status}")
        return stdout_str
    finally:
        client.close()


def _ssh_exec_pooled(
    host: str, port: int, username: str, password: Optional[str], command: str,
    timeout_sec: int, auth_timeout_sec: Optional[int], banner_timeout_sec: Optional[int],
    disabled_algorithms: Optional[Dict[str, Any]], look_for_keys: bool, allow_agent: bool,
) -> str:
    client = ssh_pool.get_client(
        host=host,
        port=port,
        username=username,
        password=password,
        timeout_sec=timeout_sec,
        auth_timeout_sec=auth_timeout_sec,
        banner_timeout_sec=banner_timeout_sec,
        disabled_algorithms=disabled_algorithms,
        look_for_keys=look_for_keys,
        allow_agent=allow_agent,
    )
    stdin, stdout, stderr = client.exec_command(command, timeout=timeout_sec)
    stdout_str = stdout.read().decode(errors="ignore")
    stderr_str = stderr.read().decode(errors="ignore")
    exit_status = stdout.channel.recv_exit_status()
    if exit_status != 0 and not stdout_str:
        raise RuntimeError(stderr_str.strip() or f"exit status {exit_status}")
    return stdout_str
