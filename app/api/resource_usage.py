from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session
from typing import Dict, Any, List, Tuple
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime
import json

from app.database.database import get_db
from app.models.proxy import Proxy
from app.models.resource_usage import ResourceUsage as ResourceUsageModel
from app.schemas.resource_usage import (
    ResourceUsage as ResourceUsageSchema,
    CollectRequest,
    CollectResponse,
)

# pysnmp imports kept local to avoid import cost on app startup
from pysnmp.hlapi import (
    SnmpEngine,
    CommunityData,
    UdpTransportTarget,
    ContextData,
    ObjectType,
    ObjectIdentity,
    getCmd,
)


router = APIRouter()


SUPPORTED_KEYS = {"cpu", "mem", "cc", "cs", "http", "https", "ftp"}


def _snmp_get(host: str, port: int, community: str, oid: str, timeout_sec: int = 2) -> float | None:
    iterator = getCmd(
        SnmpEngine(),
        CommunityData(community, mpModel=1),  # SNMPv2c
        UdpTransportTarget((host, 161), timeout=timeout_sec, retries=1),
        ContextData(),
        ObjectType(ObjectIdentity(oid)),
    )
    error_indication, error_status, error_index, var_binds = next(iterator)
    if error_indication or error_status:
        return None
    try:
        value = var_binds[0][1]
        return float(value)
    except Exception:
        return None


def _collect_for_proxy(proxy: Proxy, oids: Dict[str, str], community: str) -> Tuple[int, Dict[str, Any] | None, str | None]:
    result: Dict[str, Any] = {k: None for k in SUPPORTED_KEYS}
    for key, oid in oids.items():
        if key not in SUPPORTED_KEYS:
            continue
        value = _snmp_get(proxy.host, proxy.port or 161, community, oid)
        result[key] = value
    return proxy.id, result, None


@router.post("/resource-usage/collect", response_model=CollectResponse)
async def collect_resource_usage(payload: CollectRequest, db: Session = Depends(get_db)):
    if not payload.oids:
        raise HTTPException(status_code=400, detail="oids mapping is required")

    query = db.query(Proxy).filter(Proxy.is_active == True)
    if payload.proxy_ids:
        query = query.filter(Proxy.id.in_(payload.proxy_ids))
    proxies: List[Proxy] = query.all()

    if not proxies:
        return CollectResponse(requested=0, succeeded=0, failed=0, errors={}, items=[])

    errors: Dict[int, str] = {}
    collected_models: List[ResourceUsageModel] = []

    with ThreadPoolExecutor(max_workers=4) as executor:
        future_to_proxy = {
            executor.submit(_collect_for_proxy, p, payload.oids, payload.community or "public"): p
            for p in proxies
        }
        for future in as_completed(future_to_proxy):
            proxy = future_to_proxy[future]
            try:
                proxy_id, metrics, err = future.result()
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
        items=collected_models,  # Pydantic will convert with from_attributes
    )


@router.get("/resource-usage", response_model=List[ResourceUsageSchema])
async def list_resource_usage(db: Session = Depends(get_db)):
    rows = (
        db.query(ResourceUsageModel)
        .order_by(ResourceUsageModel.created_at.desc())
        .limit(500)
        .all()
    )
    return rows


@router.get("/resource-usage/latest/{proxy_id}", response_model=ResourceUsageSchema)
async def latest_resource_usage(proxy_id: int, db: Session = Depends(get_db)):
    row = (
        db.query(ResourceUsageModel)
        .filter(ResourceUsageModel.proxy_id == proxy_id)
        .order_by(ResourceUsageModel.created_at.desc())
        .first()
    )
    if not row:
        raise HTTPException(status_code=404, detail="No resource usage found for proxy")
    return row

