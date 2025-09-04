from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy.orm import Session
from typing import List
from fastapi import Query

from app.database.database import get_db
from app.models.proxy_group import ProxyGroup
from sqlalchemy.orm import selectinload
from app.schemas.proxy_group import ProxyGroupCreate, ProxyGroupUpdate, ProxyGroup as ProxyGroupSchema

router = APIRouter()

@router.get("/proxy-groups", response_model=List[ProxyGroupSchema])
def get_proxy_groups(
    db: Session = Depends(get_db),
    limit: int = Query(50, ge=1, le=500),
    offset: int = Query(0, ge=0),
):
    return (
        db.query(ProxyGroup)
        .options(selectinload(ProxyGroup.proxies))
        .offset(offset)
        .limit(limit)
        .all()
    )

@router.get("/proxy-groups/{group_id}", response_model=ProxyGroupSchema)
def get_proxy_group(group_id: int, db: Session = Depends(get_db)):
    group = (
        db.query(ProxyGroup)
        .options(selectinload(ProxyGroup.proxies))
        .filter(ProxyGroup.id == group_id)
        .first()
    )
    if not group:
        raise HTTPException(status_code=404, detail="Proxy group not found")
    return group

@router.post("/proxy-groups", response_model=ProxyGroupSchema, status_code=status.HTTP_201_CREATED)
def create_proxy_group(group: ProxyGroupCreate, db: Session = Depends(get_db)):
    db_group = ProxyGroup(**group.model_dump())
    db.add(db_group)
    db.commit()
    db.refresh(db_group)
    return db_group

@router.put("/proxy-groups/{group_id}", response_model=ProxyGroupSchema)
def update_proxy_group(group_id: int, group: ProxyGroupUpdate, db: Session = Depends(get_db)):
    db_group = db.query(ProxyGroup).filter(ProxyGroup.id == group_id).first()
    if not db_group:
        raise HTTPException(status_code=404, detail="Proxy group not found")
    
    for key, value in group.model_dump().items():
        setattr(db_group, key, value)
    
    db.commit()
    db.refresh(db_group)
    return db_group

@router.delete("/proxy-groups/{group_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_proxy_group(group_id: int, db: Session = Depends(get_db)):
    db_group = db.query(ProxyGroup).filter(ProxyGroup.id == group_id).first()
    if not db_group:
        raise HTTPException(status_code=404, detail="Proxy group not found")
    
    db.delete(db_group)
    db.commit()
    return None
