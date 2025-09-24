import paramiko
from typing import Optional, Dict, Any


def ssh_exec(
    host: str,
    port: int,
    username: str,
    password: Optional[str],
    command: str,
    *,
    timeout_sec: int = 10,
    auth_timeout_sec: Optional[int] = None,
    banner_timeout_sec: Optional[int] = None,
    host_key_policy: str = "auto_add",
    disabled_algorithms: Optional[Dict[str, Any]] = None,
    look_for_keys: bool = False,
    allow_agent: bool = False,
) -> str:
    """Execute a remote command over SSH and return stdout.

    Raises RuntimeError on non-zero exit status (when stdout is empty) or on SSH errors.
    """
    client = paramiko.SSHClient()
    if (host_key_policy or "auto_add").lower() == "reject":
        client.set_missing_host_key_policy(paramiko.RejectPolicy())
    else:
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
    except Exception as e:
        raise RuntimeError(str(e))
    finally:
        try:
            client.close()
        except Exception:
            pass

