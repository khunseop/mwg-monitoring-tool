from typing import List, Optional, Dict, Any, Tuple
from datetime import datetime, timedelta
from sqlalchemy.orm import Session
from app.models.resource_usage import ResourceUsage as ResourceUsageModel
from app.models.proxy import Proxy
from app.utils.time import KST_TZ
import bisect

METRIC_FIELDS = ['cpu', 'mem', 'disk', 'cc', 'cs', 'http', 'https', 'http2', 'blocked']

WEEKDAY_NAMES = ['월', '화', '수', '목', '금', '토', '일']

TIME_BANDS = [
    {'label': '0~30%',  'min': 0,   'max': 30},
    {'label': '30~60%', 'min': 30,  'max': 60},
    {'label': '60~80%', 'min': 60,  'max': 80},
    {'label': '80~100%','min': 80,  'max': 100},
    {'label': '100%+',  'min': 100, 'max': float('inf')},
]


def _is_business_hour(dt: datetime) -> bool:
    local = dt.astimezone(KST_TZ)
    return local.weekday() < 5 and 9 <= local.hour < 18


def _get_val(row: ResourceUsageModel, metric: str) -> Optional[float]:
    return getattr(row, metric, None)


def _percentile(sorted_vals: List[float], p: float) -> float:
    if not sorted_vals:
        return 0.0
    rank = (p / 100) * (len(sorted_vals) - 1)
    lower = int(rank)
    upper = min(lower + 1, len(sorted_vals) - 1)
    return sorted_vals[lower] + (sorted_vals[upper] - sorted_vals[lower]) * (rank - lower)


def _base_query(db: Session, proxy_ids: List[int], start_time, end_time):
    q = db.query(ResourceUsageModel)
    if proxy_ids:
        q = q.filter(ResourceUsageModel.proxy_id.in_(proxy_ids))
    if start_time:
        q = q.filter(ResourceUsageModel.collected_at >= start_time)
    if end_time:
        q = q.filter(ResourceUsageModel.collected_at <= end_time)
    return q


def _proxy_map(db: Session, proxy_ids: List[int]) -> Dict[int, str]:
    return {p.id: p.host for p in db.query(Proxy).filter(Proxy.id.in_(proxy_ids)).all()}


def compute_percentiles(
    db: Session,
    proxy_ids: List[int],
    start_time: Optional[datetime],
    end_time: Optional[datetime],
    business_hours: bool,
    metrics: List[str],
) -> List[Dict[str, Any]]:
    pmap = _proxy_map(db, proxy_ids)
    grouped: Dict[int, List[ResourceUsageModel]] = {}
    for row in _base_query(db, proxy_ids, start_time, end_time).all():
        if business_hours and not _is_business_hour(row.collected_at):
            continue
        grouped.setdefault(row.proxy_id, []).append(row)

    results = []
    for pid in proxy_ids:
        rows = grouped.get(pid, [])
        host = pmap.get(pid, f'#{pid}')
        for m in metrics:
            vals = sorted(v for row in rows if (v := _get_val(row, m)) is not None)
            if not vals:
                results.append({'proxy_id': pid, 'host': host, 'metric': m, 'count': 0,
                                'p50': None, 'p95': None, 'p99': None, 'mean': None, 'max': None})
                continue
            results.append({
                'proxy_id': pid, 'host': host, 'metric': m, 'count': len(vals),
                'p50':  round(_percentile(vals, 50), 2),
                'p95':  round(_percentile(vals, 95), 2),
                'p99':  round(_percentile(vals, 99), 2),
                'mean': round(sum(vals) / len(vals), 2),
                'max':  round(max(vals), 2),
            })
    return results


def compute_time_in_band(
    db: Session,
    proxy_ids: List[int],
    start_time: Optional[datetime],
    end_time: Optional[datetime],
    business_hours: bool,
    metric: str,
) -> List[Dict[str, Any]]:
    pmap = _proxy_map(db, proxy_ids)
    grouped: Dict[int, List[float]] = {}
    for row in _base_query(db, proxy_ids, start_time, end_time).all():
        if business_hours and not _is_business_hour(row.collected_at):
            continue
        val = _get_val(row, metric)
        if val is not None:
            grouped.setdefault(row.proxy_id, []).append(val)

    results = []
    for pid in proxy_ids:
        vals = grouped.get(pid, [])
        total = len(vals)
        bands = []
        for b in TIME_BANDS:
            cnt = sum(1 for v in vals if b['min'] <= v < b['max'])
            bands.append({
                'label': b['label'],
                'count': cnt,
                'pct': round(cnt / total * 100, 1) if total else 0.0,
                'duration_min': round(cnt * 30 / 60, 1),  # 30초 단위 수집 기준
            })
        results.append({
            'proxy_id': pid, 'host': pmap.get(pid, f'#{pid}'),
            'metric': metric, 'total_samples': total, 'bands': bands,
        })
    return results


def compute_threshold_duration(
    db: Session,
    proxy_ids: List[int],
    start_time: Optional[datetime],
    end_time: Optional[datetime],
    metric: str,
    threshold: float,
) -> List[Dict[str, Any]]:
    pmap = _proxy_map(db, proxy_ids)
    q = _base_query(db, proxy_ids, start_time, end_time)
    q = q.order_by(ResourceUsageModel.proxy_id, ResourceUsageModel.collected_at)

    grouped: Dict[int, List[Tuple[datetime, float]]] = {}
    for row in q.all():
        val = _get_val(row, metric)
        if val is not None:
            grouped.setdefault(row.proxy_id, []).append((row.collected_at, val))

    results = []
    for pid in proxy_ids:
        points = grouped.get(pid, [])
        episodes = []
        total_min = 0.0
        in_ep = False
        ep_start = None
        ep_vals = []

        for i, (ts, val) in enumerate(points):
            if val >= threshold:
                if not in_ep:
                    in_ep = True
                    ep_start = ts
                    ep_vals = [val]
                else:
                    ep_vals.append(val)
            else:
                if in_ep:
                    ep_end = points[i - 1][0]
                    dur = round((ep_end - ep_start).total_seconds() / 60, 1)
                    episodes.append({
                        'start': ep_start.isoformat(), 'end': ep_end.isoformat(),
                        'duration_min': dur,
                        'max_value': round(max(ep_vals), 2),
                        'mean_value': round(sum(ep_vals) / len(ep_vals), 2),
                        'sample_count': len(ep_vals),
                    })
                    total_min += dur
                    in_ep = False
                    ep_vals = []

        if in_ep and ep_vals:
            ep_end = points[-1][0]
            dur = round((ep_end - ep_start).total_seconds() / 60, 1)
            episodes.append({
                'start': ep_start.isoformat(), 'end': ep_end.isoformat(),
                'duration_min': dur,
                'max_value': round(max(ep_vals), 2),
                'mean_value': round(sum(ep_vals) / len(ep_vals), 2),
                'sample_count': len(ep_vals),
            })
            total_min += dur

        results.append({
            'proxy_id': pid, 'host': pmap.get(pid, f'#{pid}'),
            'metric': metric, 'threshold': threshold,
            'episode_count': len(episodes),
            'total_duration_min': round(total_min, 1),
            'episodes': episodes,
        })
    return results


def compute_heatmap_weekly(
    db: Session,
    proxy_ids: List[int],
    start_time: Optional[datetime],
    end_time: Optional[datetime],
    metric: str,
) -> List[Dict[str, Any]]:
    pmap = _proxy_map(db, proxy_ids)
    # {proxy_id: {weekday: {hour: [values]}}}
    grouped: Dict[int, Dict[int, Dict[int, List[float]]]] = {}

    for row in _base_query(db, proxy_ids, start_time, end_time).all():
        val = _get_val(row, metric)
        if val is None:
            continue
        local = row.collected_at.astimezone(KST_TZ)
        wd, hr = local.weekday(), local.hour
        grouped.setdefault(row.proxy_id, {}).setdefault(wd, {}).setdefault(hr, []).append(val)

    results = []
    for pid in proxy_ids:
        data = {}
        for wd, hours in grouped.get(pid, {}).items():
            data[wd] = {hr: round(sum(v) / len(v), 2) for hr, v in hours.items()}
        results.append({
            'proxy_id': pid, 'host': pmap.get(pid, f'#{pid}'),
            'metric': metric, 'data': data,
        })
    return results


def compute_top_n(
    db: Session,
    proxy_ids: List[int],
    start_time: Optional[datetime],
    end_time: Optional[datetime],
    business_hours: bool,
    metric: str,
    stat: str,
    n: int,
) -> List[Dict[str, Any]]:
    rows = compute_percentiles(db, proxy_ids, start_time, end_time, business_hours, [metric])
    valid = [r for r in rows if r.get(stat) is not None]
    valid.sort(key=lambda x: x[stat], reverse=True)
    return [{'proxy_id': r['proxy_id'], 'host': r['host'], 'value': r[stat],
             'stat': stat, 'metric': metric} for r in valid[:n]]


def compute_smoothed(
    db: Session,
    proxy_ids: List[int],
    start_time: Optional[datetime],
    end_time: Optional[datetime],
    metric: str,
    window_min: int,
    max_points: int = 2000,
) -> List[Dict[str, Any]]:
    pmap = _proxy_map(db, proxy_ids)
    q = _base_query(db, proxy_ids, start_time, end_time)
    q = q.order_by(ResourceUsageModel.proxy_id, ResourceUsageModel.collected_at)

    grouped: Dict[int, List[Tuple[datetime, float]]] = {}
    for row in q.all():
        val = _get_val(row, metric)
        if val is not None:
            grouped.setdefault(row.proxy_id, []).append((row.collected_at, val))

    half_sec = window_min * 30  # half-window in seconds

    results = []
    for pid in proxy_ids:
        points = grouped.get(pid, [])
        if not points:
            results.append({'proxy_id': pid, 'host': pmap.get(pid, f'#{pid}'),
                            'metric': metric, 'points': []})
            continue

        # O(n log n): prefix sum + binary search
        ts_epoch = [p[0].timestamp() for p in points]
        values = [p[1] for p in points]
        n = len(values)
        prefix = [0.0] * (n + 1)
        for i, v in enumerate(values):
            prefix[i + 1] = prefix[i] + v

        # Downsample: pick evenly spaced indices to keep ≤ max_points
        step = max(1, n // max_points)
        indices = range(0, n, step)

        smoothed = []
        for i in indices:
            t = ts_epoch[i]
            lo = bisect.bisect_left(ts_epoch, t - half_sec)
            hi = bisect.bisect_right(ts_epoch, t + half_sec)
            count = hi - lo
            avg = (prefix[hi] - prefix[lo]) / count if count else values[i]
            smoothed.append({'ts': points[i][0].isoformat(), 'value': round(avg, 2)})

        results.append({'proxy_id': pid, 'host': pmap.get(pid, f'#{pid}'),
                        'metric': metric, 'points': smoothed})
    return results
