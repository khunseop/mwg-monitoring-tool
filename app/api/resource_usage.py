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
    SeriesRequest,
    SeriesResponse,
    SeriesPoint,
    SeriesItem,
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
    tasks: list = []
    keys: list[str] = []
    for key, oid in oids.items():
        if key not in SUPPORTED_KEYS:
            continue
        keys.append(key)
        tasks.append(_snmp_get(proxy.host, 161, community, oid))

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


def _floor_dt(dt: datetime, interval: str) -> datetime:
    if interval == "minute":
        return dt.replace(second=0, microsecond=0)
    if interval == "hour":
        return dt.replace(minute=0, second=0, microsecond=0)
    if interval == "day":
        return dt.replace(hour=0, minute=0, second=0, microsecond=0)
    return dt


@router.post("/resource-usage/series", response_model=SeriesResponse)
async def series_resource_usage(payload: SeriesRequest, db: Session = Depends(get_db)):
    if not payload.proxy_ids:
        raise HTTPException(status_code=400, detail="proxy_ids is required")
    if payload.start >= payload.end:
        raise HTTPException(status_code=400, detail="start must be before end")

    # Query rows in range for requested proxies
    rows = (
        db.query(ResourceUsageModel)
        .filter(ResourceUsageModel.proxy_id.in_(payload.proxy_ids))
        .filter(ResourceUsageModel.collected_at >= payload.start)
        .filter(ResourceUsageModel.collected_at < payload.end)
        .order_by(ResourceUsageModel.proxy_id.asc(), ResourceUsageModel.collected_at.asc())
        .all()
    )

    # Group into buckets per proxy
    by_proxy: Dict[int, List[ResourceUsageModel]] = {}
    for r in rows:
        by_proxy.setdefault(r.proxy_id, []).append(r)

    def avg(values: List[Optional[float]]) -> Optional[float]:
        nums = [v for v in values if isinstance(v, (int, float))]
        return (sum(nums) / len(nums)) if nums else None

    metric_keys = ["cpu", "mem", "cc", "cs", "http", "https", "ftp"]

    items: List[SeriesItem] = []
    for proxy_id, records in by_proxy.items():
        # bucket map: ts -> list of rows
        buckets: Dict[datetime, List[ResourceUsageModel]] = {}
        for r in records:
            ts = _floor_dt(r.collected_at, payload.interval)
            buckets.setdefault(ts, []).append(r)

        # sorted bucket timestamps
        sorted_ts = sorted(buckets.keys())

        points: List[SeriesPoint] = []
        window = payload.ma_window
        # rolling storage for moving average
        window_values: Dict[str, List[Optional[float]]] = {k: [] for k in metric_keys}
        # cumulative totals
        cumsum: Dict[str, float] = {k: 0.0 for k in metric_keys}
        ccount: Dict[str, int] = {k: 0 for k in metric_keys}

        for ts in sorted_ts:
            bucket_rows = buckets[ts]
            # compute per-metric averages for bucket
            bucket_avg: Dict[str, Optional[float]] = {}
            for k in metric_keys:
                bucket_avg[k] = avg([getattr(r, k) for r in bucket_rows])

            # update rolling window
            for k in metric_keys:
                window_values[k].append(bucket_avg[k])
                if len(window_values[k]) > window:
                    window_values[k].pop(0)

            # moving average
            ma: Dict[str, Optional[float]] = {}
            for k in metric_keys:
                ma[k] = avg(window_values[k])

            # cumulative average
            cma: Dict[str, Optional[float]] = {}
            for k in metric_keys:
                v = bucket_avg[k]
                if v is None:
                    cma[k] = (cumsum[k] / ccount[k]) if ccount[k] > 0 else None
                else:
                    cumsum[k] += float(v)
                    ccount[k] += 1
                    cma[k] = cumsum[k] / ccount[k]

            points.append(SeriesPoint(ts=ts, avg=bucket_avg, ma=ma, cma=cma))

        items.append(SeriesItem(proxy_id=proxy_id, points=points))

    return SeriesResponse(items=items)

