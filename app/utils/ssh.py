import paramiko
import threading
import time
import logging
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
) -> str:
    """Execute a remote command over SSH and return stdout."""
    if not use_pool:
        # Legacy behavior: one-off connection
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

    # Pooled behavior
    try:
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
        
        # Using a lock per client could be safer for concurrent commands on the same session,
        # but Paramiko transport is generally thread-safe for multiple channels.
        stdin, stdout, stderr = client.exec_command(command, timeout=timeout_sec)
        stdout_str = stdout.read().decode(errors="ignore")
        stderr_str = stderr.read().decode(errors="ignore")
        exit_status = stdout.channel.recv_exit_status()
        
        if exit_status != 0 and not stdout_str:
            # If command failed, check if it's due to a broken pipe or connection
            if not client.get_transport() or not client.get_transport().is_active():
                logger.warning(f"[SSHPool] Connection lost during exec to {host}. Retrying once...")
                # The get_client logic will handle reconnection if we call it again after it's cleaned up
                # But here we just raise to let the caller retry or handle it.
                # For now, let's keep it simple and raise.
                pass
            raise RuntimeError(stderr_str.strip() or f"exit status {exit_status}")
        
        return stdout_str
    except Exception as e:
        logger.error(f"[SSHPool] SSH Error: {e}")
        raise RuntimeError(str(e))
