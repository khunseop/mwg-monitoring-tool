from fastapi import APIRouter, Depends, Query
from sqlalchemy.orm import Session
from typing import Optional
from datetime import datetime, timezone

from app.database.database import get_db
from app.utils.time import KST_TZ
from app.services.resource_analysis import (
    METRIC_FIELDS,
    compute_percentiles,
    compute_time_in_band,
    compute_threshold_duration,
    compute_heatmap_weekly,
    compute_top_n,
    compute_smoothed,
)

router = APIRouter()


def _dt(s: Optional[str]) -> Optional[datetime]:
    if not s:
        return None
    dt = datetime.fromisoformat(s.replace('Z', '+00:00'))
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return dt.astimezone(KST_TZ)


def _ids(proxy_ids: str) -> list[int]:
    return [int(x.strip()) for x in proxy_ids.split(',') if x.strip().isdigit()]


@router.get("/resource-usage/analysis/percentiles")
async def analysis_percentiles(
    proxy_ids: str = Query(...),
    start_time: Optional[str] = Query(None),
    end_time: Optional[str] = Query(None),
    business_hours: bool = Query(False),
    metrics: str = Query("cpu,mem,disk"),
    db: Session = Depends(get_db),
):
    metric_list = [m.strip() for m in metrics.split(',') if m.strip() in METRIC_FIELDS]
    return compute_percentiles(db, _ids(proxy_ids), _dt(start_time), _dt(end_time), business_hours, metric_list)


@router.get("/resource-usage/analysis/time-in-band")
async def analysis_time_in_band(
    proxy_ids: str = Query(...),
    start_time: Optional[str] = Query(None),
    end_time: Optional[str] = Query(None),
    business_hours: bool = Query(False),
    metric: str = Query("cpu"),
    db: Session = Depends(get_db),
):
    m = metric if metric in METRIC_FIELDS else 'cpu'
    return compute_time_in_band(db, _ids(proxy_ids), _dt(start_time), _dt(end_time), business_hours, m)


@router.get("/resource-usage/analysis/threshold-duration")
async def analysis_threshold_duration(
    proxy_ids: str = Query(...),
    start_time: Optional[str] = Query(None),
    end_time: Optional[str] = Query(None),
    metric: str = Query("cpu"),
    threshold: float = Query(80.0),
    db: Session = Depends(get_db),
):
    m = metric if metric in METRIC_FIELDS else 'cpu'
    return compute_threshold_duration(db, _ids(proxy_ids), _dt(start_time), _dt(end_time), m, threshold)


@router.get("/resource-usage/analysis/heatmap-weekly")
async def analysis_heatmap_weekly(
    proxy_ids: str = Query(...),
    start_time: Optional[str] = Query(None),
    end_time: Optional[str] = Query(None),
    metric: str = Query("cpu"),
    db: Session = Depends(get_db),
):
    m = metric if metric in METRIC_FIELDS else 'cpu'
    return compute_heatmap_weekly(db, _ids(proxy_ids), _dt(start_time), _dt(end_time), m)


@router.get("/resource-usage/analysis/top-n")
async def analysis_top_n(
    proxy_ids: str = Query(...),
    start_time: Optional[str] = Query(None),
    end_time: Optional[str] = Query(None),
    business_hours: bool = Query(False),
    metric: str = Query("cpu"),
    stat: str = Query("p95"),
    n: int = Query(5, ge=1, le=20),
    db: Session = Depends(get_db),
):
    m = metric if metric in METRIC_FIELDS else 'cpu'
    s = stat if stat in ('p95', 'p99', 'max', 'mean') else 'p95'
    return compute_top_n(db, _ids(proxy_ids), _dt(start_time), _dt(end_time), business_hours, m, s, n)


@router.get("/resource-usage/analysis/smoothed")
async def analysis_smoothed(
    proxy_ids: str = Query(...),
    start_time: Optional[str] = Query(None),
    end_time: Optional[str] = Query(None),
    metric: str = Query("cpu"),
    window_min: int = Query(5, ge=1, le=60),
    db: Session = Depends(get_db),
):
    m = metric if metric in METRIC_FIELDS else 'cpu'
    return compute_smoothed(db, _ids(proxy_ids), _dt(start_time), _dt(end_time), m, window_min)
