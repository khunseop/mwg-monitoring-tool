from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy.orm import Session
from typing import Dict, Any, List, Tuple
import asyncio
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

# aiosnmp import for SNMP operations
from aiosnmp import Snmp


router = APIRouter()


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


async def _collect_for_proxy(proxy: Proxy, oids: Dict[str, str], community: str) -> Tuple[int, Dict[str, Any] | None, str | None]:
    result: Dict[str, Any] = {k: None for k in SUPPORTED_KEYS}
    for key, oid in oids.items():
        if key not in SUPPORTED_KEYS:
            continue
        value = await _snmp_get(proxy.host, 161, community, oid)
        result[key] = value
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

