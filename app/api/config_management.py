from fastapi import APIRouter, Depends, HTTPException, UploadFile, File
from sqlalchemy.orm import Session
from typing import Dict, Any, List
import json
from datetime import datetime

from app.database.database import get_db
from app.models.proxy import Proxy
from app.models.proxy_group import ProxyGroup
from app.models.resource_config import ResourceConfig
from app.models.session_browser_config import SessionBrowserConfig
from app.utils.crypto import encrypt_string, decrypt_string_if_encrypted

router = APIRouter()

@router.get("/config/export")
async def export_full_config(db: Session = Depends(get_db)):
    """시스템 전체 설정을 JSON으로 내보냅니다. (민감정보 포함)"""
    
    # 1. Groups
    groups = db.query(ProxyGroup).all()
    groups_data = []
    for g in groups:
        groups_data.append({
            "id": g.id,
            "name": g.name,
            "description": g.description
        })
        
    # 2. Proxies
    proxies = db.query(Proxy).all()
    proxies_data = []
    for p in proxies:
        proxies_data.append({
            "host": p.host,
            "username": p.username,
            "password": decrypt_string_if_encrypted(p.password),
            "traffic_log_path": p.traffic_log_path,
            "is_active": p.is_active,
            "group_id": p.group_id,
            "oids_json": p.oids_json,
            "description": p.description,
            "created_at": p.created_at.isoformat() if p.created_at else None
        })
        
    # 3. Resource Config
    res_cfg = db.query(ResourceConfig).first()
    res_cfg_data = None
    if res_cfg:
        res_cfg_data = {
            "community": res_cfg.community,
            "oids_json": res_cfg.oids_json,
            "thresholds_json": res_cfg.thresholds_json,
            "bandwidth_mbps": res_cfg.bandwidth_mbps
        }
        
    # 4. Session Browser Config
    sb_cfg = db.query(SessionBrowserConfig).first()
    sb_cfg_data = None
    if sb_cfg:
        sb_cfg_data = {
            "ssh_port": sb_cfg.ssh_port,
            "timeout_sec": sb_cfg.timeout_sec,
            "host_key_policy": sb_cfg.host_key_policy
        }
        
    full_config = {
        "version": "1.0",
        "exported_at": datetime.now().isoformat(),
        "groups": groups_data,
        "proxies": proxies_data,
        "resource_config": res_cfg_data,
        "session_browser_config": sb_cfg_data
    }
    
    return full_config

@router.post("/config/import")
async def import_full_config(file: UploadFile = File(...), db: Session = Depends(get_db)):
    """시스템 전체 설정을 불러옵니다. (기존 데이터가 덮어씌워질 수 있음)"""
    try:
        content = await file.read()
        data = json.loads(content)
        
        # 1. Import Groups
        group_id_map = {} # Old ID -> New ID
        if "groups" in data:
            for g_data in data["groups"]:
                old_id = g_data.get("id")
                # Check if group exists by name
                existing = db.query(ProxyGroup).filter(ProxyGroup.name == g_data["name"]).first()
                if existing:
                    group_id_map[old_id] = existing.id
                else:
                    new_group = ProxyGroup(name=g_data["name"], description=g_data.get("description"))
                    db.add(new_group)
                    db.commit()
                    db.refresh(new_group)
                    group_id_map[old_id] = new_group.id
                    
        # 2. Import Proxies
        if "proxies" in data:
            for p_data in data["proxies"]:
                # Check if proxy exists by host
                existing = db.query(Proxy).filter(Proxy.host == p_data["host"]).first()
                
                # Resolve group id
                old_gid = p_data.get("group_id")
                new_gid = group_id_map.get(old_gid)
                
                proxy_fields = {
                    "host": p_data["host"],
                    "username": p_data["username"],
                    "password": encrypt_string(p_data["password"]),
                    "traffic_log_path": p_data.get("traffic_log_path"),
                    "is_active": p_data.get("is_active", True),
                    "group_id": new_gid,
                    "oids_json": p_data.get("oids_json"),
                    "description": p_data.get("description")
                }
                
                if existing:
                    # Update
                    for k, v in proxy_fields.items():
                        setattr(existing, k, v)
                else:
                    # Create
                    new_proxy = Proxy(**proxy_fields)
                    db.add(new_proxy)
            db.commit()
            
        # 3. Import Resource Config
        if "resource_config" in data and data["resource_config"]:
            rc = data["resource_config"]
            existing = db.query(ResourceConfig).first()
            if existing:
                existing.community = rc.get("community", "public")
                existing.oids_json = rc.get("oids_json")
                existing.thresholds_json = rc.get("thresholds_json")
                existing.bandwidth_mbps = rc.get("bandwidth_mbps", 1000.0)
            else:
                new_rc = ResourceConfig(
                    community=rc.get("community", "public"),
                    oids_json=rc.get("oids_json"),
                    thresholds_json=rc.get("thresholds_json"),
                    bandwidth_mbps=rc.get("bandwidth_mbps", 1000.0)
                )
                db.add(new_rc)
            db.commit()
            
        # 4. Import Session Browser Config
        if "session_browser_config" in data and data["session_browser_config"]:
            sc = data["session_browser_config"]
            existing = db.query(SessionBrowserConfig).first()
            if existing:
                existing.ssh_port = sc.get("ssh_port", 22)
                existing.timeout_sec = sc.get("timeout_sec", 10)
                existing.host_key_policy = sc.get("host_key_policy", "auto_add")
            else:
                new_sc = SessionBrowserConfig(
                    ssh_port=sc.get("ssh_port", 22),
                    timeout_sec=sc.get("timeout_sec", 10),
                    host_key_policy=sc.get("host_key_policy", "auto_add")
                )
                db.add(new_sc)
            db.commit()
            
        return {"status": "success", "message": "Configuration imported successfully"}
        
    except Exception as e:
        db.rollback()
        raise HTTPException(status_code=400, detail=f"Import failed: {str(e)}")
