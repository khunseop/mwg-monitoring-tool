from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy.orm import Session
from typing import List

from app.database.database import get_db
from app.models.proxy import Proxy
from app.schemas.proxy import ProxyCreate, ProxyUpdate, Proxy as ProxySchema

router = APIRouter()

@router.get("/proxies", response_model=List[ProxySchema])
def get_proxies(db: Session = Depends(get_db)):
    return db.query(Proxy).join(Proxy.group, isouter=True).all()

@router.get("/proxies/{proxy_id}", response_model=ProxySchema)
def get_proxy(proxy_id: int, db: Session = Depends(get_db)):
    proxy = db.query(Proxy).join(Proxy.group, isouter=True).filter(Proxy.id == proxy_id).first()
    if not proxy:
        raise HTTPException(status_code=404, detail="Proxy not found")
    return proxy

@router.post("/proxies", response_model=ProxySchema, status_code=status.HTTP_201_CREATED)
def create_proxy(proxy: ProxyCreate, db: Session = Depends(get_db)):
    db_proxy = Proxy(**proxy.model_dump())
    db.add(db_proxy)
    db.commit()
    db.refresh(db_proxy)
    return db_proxy

@router.put("/proxies/{proxy_id}", response_model=ProxySchema)
def update_proxy(proxy_id: int, proxy: ProxyUpdate, db: Session = Depends(get_db)):
    db_proxy = db.query(Proxy).filter(Proxy.id == proxy_id).first()
    if not db_proxy:
        raise HTTPException(status_code=404, detail="Proxy not found")
    
    update_data = proxy.model_dump(exclude_unset=True)
    
    # 비밀번호가 제공되지 않은 경우 업데이트에서 제외
    if not update_data.get('password'):
        update_data.pop('password', None)
    
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
    
    db.delete(db_proxy)
    db.commit()
    return None

# 테스트 기능 제거됨
