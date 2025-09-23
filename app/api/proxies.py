from fastapi import APIRouter, Depends, HTTPException, status, Body
from sqlalchemy.orm import Session
from typing import List
from fastapi import Query

from app.database.database import get_db
from app.models.proxy import Proxy
from sqlalchemy.orm import joinedload
from app.schemas.proxy import ProxyCreate, ProxyUpdate, ProxyOut, ProxyBulkCreateResult, ProxyBulkCreateIn
from sqlalchemy import func
from app.utils.crypto import encrypt_string
from pydantic import ValidationError
from app.models.proxy_group import ProxyGroup
from app.models.resource_usage import ResourceUsage
from app.models.traffic_log import TrafficLog

router = APIRouter()

@router.get("/proxies", response_model=List[ProxyOut])
def get_proxies(
    db: Session = Depends(get_db),
    limit: int = Query(50, ge=1, le=500),
    offset: int = Query(0, ge=0),
):
    return (
        db.query(Proxy)
        .options(joinedload(Proxy.group))
        .offset(offset)
        .limit(limit)
        .all()
    )

@router.get("/proxies/{proxy_id}", response_model=ProxyOut)
def get_proxy(proxy_id: int, db: Session = Depends(get_db)):
    proxy = (
        db.query(Proxy)
        .options(joinedload(Proxy.group))
        .filter(Proxy.id == proxy_id)
        .first()
    )
    if not proxy:
        raise HTTPException(status_code=404, detail="Proxy not found")
    return proxy

@router.post("/proxies", response_model=ProxyOut, status_code=status.HTTP_201_CREATED)
def create_proxy(proxy: ProxyCreate, db: Session = Depends(get_db)):
    # Duplicate host guard (case-insensitive)
    existing = (
        db.query(Proxy)
        .filter(func.lower(Proxy.host) == func.lower(proxy.host))
        .first()
    )
    if existing:
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="Proxy host already exists")
    data = proxy.model_dump()
    data["password"] = encrypt_string(data.get("password"))
    db_proxy = Proxy(**data)
    db.add(db_proxy)
    db.commit()
    db.refresh(db_proxy)
    return db_proxy


@router.post("/proxies/bulk", response_model=List[ProxyBulkCreateResult], status_code=status.HTTP_201_CREATED)
def bulk_create_proxies(
    items: List[dict] = Body(..., description="List of proxies to create (supports group_name)"),
    db: Session = Depends(get_db),
):
    results: List[ProxyBulkCreateResult] = []
    for idx, raw in enumerate(items):
        # Validate each item individually to avoid failing the whole request
        try:
            # Accept group_name for lookup; validate base fields first using dedicated schema
            item = ProxyBulkCreateIn(**raw)
        except ValidationError as ve:
            # Collect validation error per item
            host_val = (raw.get("host") if isinstance(raw, dict) else None) or "(invalid)"
            results.append(ProxyBulkCreateResult(index=idx, host=str(host_val), status="error", detail=ve.errors()[0].get("msg", "validation error")))
            continue

        # Resolve group by name if provided
        resolved_group_id = None
        if getattr(item, "group_name", None):
            group = (
                db.query(ProxyGroup)
                .filter(func.lower(ProxyGroup.name) == func.lower(item.group_name))
                .first()
            )
            if not group:
                results.append(ProxyBulkCreateResult(index=idx, host=item.host, status="error", detail=f"Proxy group not found: {item.group_name}"))
                continue
            resolved_group_id = group.id

        # Duplicate host guard (case-insensitive)
        existing = (
            db.query(Proxy)
            .filter(func.lower(Proxy.host) == func.lower(item.host))
            .first()
        )
        if existing:
            results.append(ProxyBulkCreateResult(index=idx, host=item.host, status="duplicate", id=existing.id, detail="Proxy host already exists"))
            continue

        try:
            # Build through ProxyCreate to reuse validation
            create_input = {
                "host": item.host,
                "username": item.username,
                "password": item.password,
                "traffic_log_path": item.traffic_log_path,
                "is_active": item.is_active,
                "group_id": resolved_group_id,
                "description": item.description,
            }
            valid = ProxyCreate(**create_input)
            data = valid.model_dump()
            data["password"] = encrypt_string(data.get("password"))
            db_proxy = Proxy(**data)
            db.add(db_proxy)
            db.commit()
            db.refresh(db_proxy)
            results.append(ProxyBulkCreateResult(index=idx, host=item.host, status="created", id=db_proxy.id))
        except Exception as e:
            db.rollback()
            results.append(ProxyBulkCreateResult(index=idx, host=item.host, status="error", detail=str(e)))

    return results

@router.put("/proxies/{proxy_id}", response_model=ProxyOut)
def update_proxy(proxy_id: int, proxy: ProxyUpdate, db: Session = Depends(get_db)):
    db_proxy = db.query(Proxy).filter(Proxy.id == proxy_id).first()
    if not db_proxy:
        raise HTTPException(status_code=404, detail="Proxy not found")
    
    update_data = proxy.model_dump(exclude_unset=True)
    
    # 비밀번호가 제공되지 않은 경우 업데이트에서 제외하고,
    # 제공된 경우에는 암호화하여 저장
    if not update_data.get('password'):
        update_data.pop('password', None)
    else:
        update_data['password'] = encrypt_string(update_data.get('password'))

    # If host is being updated, enforce uniqueness (case-insensitive)
    if 'host' in update_data and update_data['host']:
        dup = (
            db.query(Proxy)
            .filter(func.lower(Proxy.host) == func.lower(update_data['host']))
            .filter(Proxy.id != proxy_id)
            .first()
        )
        if dup:
            raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="Proxy host already exists")
    
    for key, value in update_data.items():
        setattr(db_proxy, key, value)
    
    db.commit()
    db.refresh(db_proxy)
    return db_proxy

@router.delete("/proxies/{proxy_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_proxy(proxy_id: int, db: Session = Depends(get_db)):
    db_proxy = db.query(Proxy).filter(Proxy.id == proxy_id).first()
    if not db_proxy:
        raise HTTPException(status_code=404, detail="Proxy not found")

    try:
        # Manually delete dependents to support legacy schemas without ON DELETE CASCADE
        db.query(ResourceUsage).filter(ResourceUsage.proxy_id == proxy_id).delete(synchronize_session=False)
        # TrafficLog has no FK constraint but we delete for data hygiene
        db.query(TrafficLog).filter(TrafficLog.proxy_id == proxy_id).delete(synchronize_session=False)

        db.delete(db_proxy)
        db.commit()
    except Exception as e:
        db.rollback()
        raise HTTPException(status_code=400, detail=f"Failed to delete proxy: {str(e)}")
    return None

