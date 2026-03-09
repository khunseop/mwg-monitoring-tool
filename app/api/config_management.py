from fastapi import APIRouter, Depends, HTTPException, UploadFile, File
from fastapi.responses import StreamingResponse
from sqlalchemy.orm import Session
from typing import Dict, Any, List
import json
import io
from datetime import datetime
from openpyxl import Workbook, load_workbook
from openpyxl.styles import Font, PatternFill, Alignment

from app.database.database import get_db
from app.models.proxy import Proxy
from app.models.proxy_group import ProxyGroup
from app.models.resource_config import ResourceConfig
from app.models.session_browser_config import SessionBrowserConfig
from app.utils.crypto import encrypt_string, decrypt_string_if_encrypted

router = APIRouter()

def _apply_header_style(sheet):
    header_fill = PatternFill(start_color="F2F2F2", end_color="F2F2F2", fill_type="solid")
    header_font = Font(bold=True)
    for cell in sheet[1]:
        cell.fill = header_fill
        cell.font = header_font
        cell.alignment = Alignment(horizontal="center")

@router.get("/config/export")
async def export_full_config_excel(db: Session = Depends(get_db)):
    """시스템 전체 설정을 Excel로 내보냅니다."""
    wb = Workbook()
    
    # 1. Groups Sheet
    ws_groups = wb.active
    ws_groups.title = "Groups"
    ws_groups.append(["ID", "Name", "Description"])
    groups = db.query(ProxyGroup).all()
    for g in groups:
        ws_groups.append([g.id, g.name, g.description])
    _apply_header_style(ws_groups)

    # 2. Proxies Sheet
    ws_proxies = wb.create_sheet("Proxies")
    ws_proxies.append(["Host", "Username", "Password", "Group Name", "Log Path", "Is Active", "Description", "OIDs JSON"])
    proxies = db.query(Proxy).all()
    for p in proxies:
        group_name = p.group.name if p.group else ""
        ws_proxies.append([
            p.host, 
            p.username, 
            decrypt_string_if_encrypted(p.password), 
            group_name,
            p.traffic_log_path,
            "TRUE" if p.is_active else "FALSE",
            p.description,
            p.oids_json
        ])
    _apply_header_style(ws_proxies)

    # 3. System Config Sheet
    ws_sys = wb.create_sheet("SystemConfig")
    ws_sys.append(["Category", "Key", "Value", "Description"])
    
    # Resource Config
    res_cfg = db.query(ResourceConfig).first()
    if res_cfg:
        ws_sys.append(["Resource", "Community", res_cfg.community, "SNMP Community String"])
        ws_sys.append(["Resource", "OIDs_JSON", res_cfg.oids_json, "Common OIDs"])
        ws_sys.append(["Resource", "Thresholds_JSON", res_cfg.thresholds_json, "Alert Thresholds"])
        ws_sys.append(["Resource", "Bandwidth_Mbps", res_cfg.bandwidth_mbps, "Default Bandwidth"])
    
    # Session Browser Config
    sb_cfg = db.query(SessionBrowserConfig).first()
    if sb_cfg:
        ws_sys.append(["Session", "SSH_Port", sb_cfg.ssh_port, "SSH Port"])
        ws_sys.append(["Session", "Timeout_Sec", sb_cfg.timeout_sec, "SSH Timeout"])
        ws_sys.append(["Session", "Host_Key_Policy", sb_cfg.host_key_policy, "SSH Host Key Policy"])
    
    _apply_header_style(ws_sys)

    # Save to stream
    output = io.BytesIO()
    wb.save(output)
    output.seek(0)
    
    filename = f"PMT_Config_Backup_{datetime.now().strftime('%Y%m%d_%H%M%S')}.xlsx"
    
    return StreamingResponse(
        output,
        media_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        headers={"Content-Disposition": f"attachment; filename={filename}"}
    )

@router.post("/config/import")
async def import_full_config_excel(file: UploadFile = File(...), db: Session = Depends(get_db)):
    """Excel 설정을 불러옵니다."""
    try:
        content = await file.read()
        wb = load_workbook(io.BytesIO(content))
        
        # 1. Import Groups
        group_id_map = {} # Name -> New ID
        if "Groups" in wb.sheetnames:
            ws = wb["Groups"]
            for row in ws.iter_rows(min_row=2, values_only=True):
                if not row[1]: continue
                name = str(row[1])
                desc = str(row[2]) if row[2] else None
                
                existing = db.query(ProxyGroup).filter(ProxyGroup.name == name).first()
                if existing:
                    group_id_map[name] = existing.id
                else:
                    new_group = ProxyGroup(name=name, description=desc)
                    db.add(new_group)
                    db.commit()
                    db.refresh(new_group)
                    group_id_map[name] = new_group.id

        # 2. Import Proxies
        if "Proxies" in wb.sheetnames:
            ws = wb["Proxies"]
            for row in ws.iter_rows(min_row=2, values_only=True):
                host = str(row[0]) if row[0] else None
                if not host: continue
                
                username = str(row[1]) if row[1] else ""
                password = str(row[2]) if row[2] else ""
                group_name = str(row[3]) if row[3] else None
                log_path = str(row[4]) if row[4] else None
                is_active = str(row[5]).upper() == "TRUE"
                description = str(row[6]) if row[6] else None
                oids_json = str(row[7]) if row[7] else None
                
                new_gid = group_id_map.get(group_name) if group_name else None
                
                proxy_fields = {
                    "host": host,
                    "username": username,
                    "password": encrypt_string(password) if password else None,
                    "traffic_log_path": log_path,
                    "is_active": is_active,
                    "group_id": new_gid,
                    "oids_json": oids_json,
                    "description": description
                }
                
                existing = db.query(Proxy).filter(Proxy.host == host).first()
                if existing:
                    for k, v in proxy_fields.items():
                        if k == "password" and v is None: continue
                        setattr(existing, k, v)
                else:
                    new_proxy = Proxy(**proxy_fields)
                    db.add(new_proxy)
            db.commit()

        # 3. Import System Config
        if "SystemConfig" in wb.sheetnames:
            ws = wb["SystemConfig"]
            res_data = {}
            sb_data = {}
            for row in ws.iter_rows(min_row=2, values_only=True):
                cat, key, val = row[0], row[1], row[2]
                if cat == "Resource": res_data[key] = val
                elif cat == "Session": sb_data[key] = val
            
            if res_data:
                existing = db.query(ResourceConfig).first()
                if not existing:
                    existing = ResourceConfig()
                    db.add(existing)
                
                if "Community" in res_data: existing.community = str(res_data["Community"])
                if "OIDs_JSON" in res_data: existing.oids_json = str(res_data["OIDs_JSON"]) if res_data["OIDs_JSON"] else None
                if "Thresholds_JSON" in res_data: existing.thresholds_json = str(res_data["Thresholds_JSON"]) if res_data["Thresholds_JSON"] else None
                if "Bandwidth_Mbps" in res_data: existing.bandwidth_mbps = float(res_data["Bandwidth_Mbps"])
                db.commit()
                
            if sb_data:
                existing = db.query(SessionBrowserConfig).first()
                if not existing:
                    existing = SessionBrowserConfig()
                    db.add(existing)
                
                if "SSH_Port" in sb_data: existing.ssh_port = int(sb_data["SSH_Port"])
                if "Timeout_Sec" in sb_data: existing.timeout_sec = int(sb_data["Timeout_Sec"])
                if "Host_Key_Policy" in sb_data: existing.host_key_policy = str(sb_data["Host_Key_Policy"])
                db.commit()

        return {"status": "success", "message": "Configuration imported successfully from Excel"}
        
    except Exception as e:
        db.rollback()
        raise HTTPException(status_code=400, detail=f"Import failed: {str(e)}")
