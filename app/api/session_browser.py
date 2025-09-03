from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session
from typing import List, Dict, Any, Tuple
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime
import paramiko

from app.database.database import get_db
from app.models.proxy import Proxy
from app.models.session_record import SessionRecord as SessionRecordModel
from app.models.session_browser_config import SessionBrowserConfig as SessionBrowserConfigModel
from app.schemas.session_record import (
    SessionRecord as SessionRecordSchema,
    CollectRequest,
    CollectResponse,
)
from app.schemas.session_browser_config import (
    SessionBrowserConfig as SessionBrowserConfigSchema,
    SessionBrowserConfigBase,
)


router = APIRouter()


def _get_cfg(db: Session) -> SessionBrowserConfigModel:
    cfg = db.query(SessionBrowserConfigModel).order_by(SessionBrowserConfigModel.id.asc()).first()
    if not cfg:
        cfg = SessionBrowserConfigModel()
        db.add(cfg)
        db.commit()
        db.refresh(cfg)
    return cfg


def _exec_ssh_command(host: str, username: str, password: str | None, port: int, command: str, timeout_sec: int) -> str:
    client = paramiko.SSHClient()
    # Host key policy: auto add per requirement (no verification)
    client.set_missing_host_key_policy(paramiko.AutoAddPolicy())
    try:
        client.connect(
            hostname=host,
            port=port,
            username=username,
            password=password,
            timeout=timeout_sec,
            auth_timeout=timeout_sec,
            banner_timeout=timeout_sec,
        )
        stdin, stdout, stderr = client.exec_command(command, timeout=timeout_sec)
        stdout_str = stdout.read().decode(errors="ignore")
        stderr_str = stderr.read().decode(errors="ignore")
        if stderr_str and not stdout_str:
            # Some commands may print warnings to stderr but still succeed. Prefer stdout when available.
            raise RuntimeError(stderr_str.strip())
        return stdout_str
    finally:
        try:
            client.close()
        except Exception:
            pass


def _parse_sessions(output: str) -> List[Dict[str, Any]]:
    lines = [line.strip() for line in output.splitlines() if line.strip()]
    if not lines:
        return []

    # Skip first summary line and second header line if present
    start_idx = 0
    if lines and lines[0].lower().startswith("there are currently"):
        start_idx = 1
    # Detect header in next line by checking for Transaction and URL presence
    if len(lines) > start_idx and "Transaction" in lines[start_idx] and "URL" in lines[start_idx]:
        start_idx += 1

    records: List[Dict[str, Any]] = []
    for line in lines[start_idx:]:
        # split by pipe and trim cells
        parts = [p.strip() for p in line.split("|")]
        # Some outputs may have empty fields around pipes; normalize length by padding
        # Expected columns count = 19 per user spec
        if len(parts) < 19:
            parts += [None] * (19 - len(parts))

        # Map fields by index per the provided order
        # 0: Transaction
        # 1: Creation Time? (the sample shows blanks; actual date appears at index 2)
        # Adjust: prefer non-empty among 1 and 2 as creation_time
        transaction = parts[0] or None
        creation_time = (parts[1] or parts[2] or None)
        protocol = parts[3] or None
        cust_id = parts[4] or None
        user_name = parts[6] or (parts[5] or None)  # sample shows username at index 6
        client_ip = parts[7] or None
        client_side_mwg_ip = parts[8] or None
        server_side_mwg_ip = parts[9] or None
        server_ip = parts[10] or None

        def _to_int(value: Any) -> int | None:
            try:
                if value is None:
                    return None
                value_str = str(value).strip()
                if value_str == "":
                    return None
                return int(value_str)
            except Exception:
                return None

        cl_bytes_received = _to_int(parts[11])
        cl_bytes_sent = _to_int(parts[12])
        srv_bytes_received = _to_int(parts[13])
        srv_bytes_sent = _to_int(parts[14])
        trxn_index = _to_int(parts[15])
        age_seconds = _to_int(parts[16])
        status = parts[17] or None
        in_use = _to_int(parts[18]) if len(parts) > 18 else None
        url = parts[19] if len(parts) > 19 else (parts[18] if status is None else None)

        # Some outputs may shift columns; if url seems missing but last token looks like URL, use it
        if not url and parts:
            last = parts[-1]
            if isinstance(last, str) and (last.startswith("http://") or last.startswith("https://")):
                url = last

        record = {
            "transaction": transaction,
            "creation_time": creation_time,
            "protocol": protocol,
            "cust_id": cust_id,
            "user_name": user_name,
            "client_ip": client_ip,
            "client_side_mwg_ip": client_side_mwg_ip,
            "server_side_mwg_ip": server_side_mwg_ip,
            "server_ip": server_ip,
            "cl_bytes_received": cl_bytes_received,
            "cl_bytes_sent": cl_bytes_sent,
            "srv_bytes_received": srv_bytes_received,
            "srv_bytes_sent": srv_bytes_sent,
            "trxn_index": trxn_index,
            "age_seconds": age_seconds,
            "status": status,
            "in_use": in_use,
            "url": url,
            "raw_line": line,
        }
        records.append(record)

    return records


def _collect_for_proxy(proxy: Proxy, cfg: SessionBrowserConfigModel) -> Tuple[int, List[Dict[str, Any]] | None, str | None]:
    if not proxy.username:
        return proxy.id, None, "Proxy is missing SSH username"
    command = f"{cfg.command_path} {cfg.command_args}".strip()
    try:
        output = _exec_ssh_command(
            host=proxy.host,
            username=proxy.username,
            password=proxy.password,
            port=cfg.ssh_port or 22,
            command=command,
            timeout_sec=cfg.timeout_sec or 10,
        )
        records = _parse_sessions(output)
        return proxy.id, records, None
    except Exception as e:
        return proxy.id, None, str(e)


@router.post("/session-browser/collect", response_model=CollectResponse)
async def collect_sessions(payload: CollectRequest, db: Session = Depends(get_db)):
    if not payload.proxy_ids or len(payload.proxy_ids) == 0:
        raise HTTPException(status_code=400, detail="proxy_ids is required and cannot be empty")

    cfg = _get_cfg(db)

    query = db.query(Proxy).filter(Proxy.is_active == True).filter(Proxy.id.in_(payload.proxy_ids))
    proxies: List[Proxy] = query.all()
    if not proxies:
        return CollectResponse(requested=0, succeeded=0, failed=0, errors={}, items=[])

    errors: Dict[int, str] = {}
    collected_models: List[SessionRecordModel] = []

    with ThreadPoolExecutor(max_workers=4) as executor:
        future_to_proxy = {executor.submit(_collect_for_proxy, p, cfg): p for p in proxies}
        for future in as_completed(future_to_proxy):
            proxy = future_to_proxy[future]
            try:
                proxy_id, records, err = future.result()
                if err:
                    errors[proxy_id] = err
                    continue
                for rec in records or []:
                    model = SessionRecordModel(
                        proxy_id=proxy_id,
                        transaction=rec.get("transaction"),
                        creation_time=rec.get("creation_time"),
                        protocol=rec.get("protocol"),
                        cust_id=rec.get("cust_id"),
                        user_name=rec.get("user_name"),
                        client_ip=rec.get("client_ip"),
                        client_side_mwg_ip=rec.get("client_side_mwg_ip"),
                        server_side_mwg_ip=rec.get("server_side_mwg_ip"),
                        server_ip=rec.get("server_ip"),
                        cl_bytes_received=rec.get("cl_bytes_received"),
                        cl_bytes_sent=rec.get("cl_bytes_sent"),
                        srv_bytes_received=rec.get("srv_bytes_received"),
                        srv_bytes_sent=rec.get("srv_bytes_sent"),
                        trxn_index=rec.get("trxn_index"),
                        age_seconds=rec.get("age_seconds"),
                        status=rec.get("status"),
                        in_use=rec.get("in_use"),
                        url=rec.get("url"),
                        raw_line=rec.get("raw_line"),
                        collected_at=datetime.utcnow(),
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
        items=collected_models,  # Pydantic converts with from_attributes
    )


@router.get("/session-browser", response_model=List[SessionRecordSchema])
async def list_sessions(db: Session = Depends(get_db)):
    rows = (
        db.query(SessionRecordModel)
        .order_by(SessionRecordModel.collected_at.desc())
        .limit(500)
        .all()
    )
    return rows


@router.get("/session-browser/latest/{proxy_id}", response_model=List[SessionRecordSchema])
async def latest_sessions(proxy_id: int, db: Session = Depends(get_db)):
    # Return latest batch for a proxy: we approximate by taking latest collected_at and returning those rows
    subq = (
        db.query(SessionRecordModel.collected_at)
        .filter(SessionRecordModel.proxy_id == proxy_id)
        .order_by(SessionRecordModel.collected_at.desc())
        .limit(1)
        .subquery()
    )
    rows = (
        db.query(SessionRecordModel)
        .filter(SessionRecordModel.proxy_id == proxy_id)
        .filter(SessionRecordModel.collected_at == subq.c.collected_at)
        .order_by(SessionRecordModel.id.asc())
        .all()
    )
    return rows


@router.get("/session-browser/config", response_model=SessionBrowserConfigSchema)
def get_session_browser_config(db: Session = Depends(get_db)):
    cfg = _get_cfg(db)
    return SessionBrowserConfigSchema(
        id=cfg.id,
        ssh_port=cfg.ssh_port,
        command_path=cfg.command_path,
        command_args=cfg.command_args,
        timeout_sec=cfg.timeout_sec,
        host_key_policy=cfg.host_key_policy,
        created_at=cfg.created_at,
        updated_at=cfg.updated_at,
    )


@router.put("/session-browser/config", response_model=SessionBrowserConfigSchema)
def update_session_browser_config(payload: SessionBrowserConfigBase, db: Session = Depends(get_db)):
    cfg = _get_cfg(db)
    cfg.ssh_port = payload.ssh_port
    cfg.command_path = payload.command_path
    cfg.command_args = payload.command_args
    cfg.timeout_sec = payload.timeout_sec
    cfg.host_key_policy = payload.host_key_policy
    db.commit()
    db.refresh(cfg)
    return SessionBrowserConfigSchema(
        id=cfg.id,
        ssh_port=cfg.ssh_port,
        command_path=cfg.command_path,
        command_args=cfg.command_args,
        timeout_sec=cfg.timeout_sec,
        host_key_policy=cfg.host_key_policy,
        created_at=cfg.created_at,
        updated_at=cfg.updated_at,
    )

