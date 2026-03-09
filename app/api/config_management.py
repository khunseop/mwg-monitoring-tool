from fastapi import APIRouter, Depends, HTTPException, UploadFile, File
from fastapi.responses import StreamingResponse
from sqlalchemy.orm import Session
from typing import Dict, Any, List
import json
import io
import re
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
    header_fill = PatternFill(start_color="E7E6E6", end_color="E7E6E6", fill_type="solid")
    header_font = Font(bold=True)
    for cell in sheet[1]:
        cell.fill = header_fill
        cell.font = header_font
        cell.alignment = Alignment(horizontal="center")

@router.get("/config/export")
async def export_full_config_excel(db: Session = Depends(get_db)):
    """시스템 전체 설정을 비개발자 친화적인 Excel 포맷으로 내보냅니다."""
    wb = Workbook()
    
    # 1. 시트: Groups (그룹 관리)
    ws_groups = wb.active
    ws_groups.title = "1.Groups"
    ws_groups.append(["GroupName", "Description"])
    groups = db.query(ProxyGroup).all()
    for g in groups:
        ws_groups.append([g.name, g.description])
    _apply_header_style(ws_groups)

    # 2. 시트: Proxies (장비 기본 정보)
    ws_proxies = wb.create_sheet("2.Proxies")
    ws_proxies.append(["Host", "Username", "Password", "GroupName", "TrafficLogPath", "IsActive", "Description"])
    proxies = db.query(Proxy).all()
    for p in proxies:
        group_name = p.group.name if p.group else ""
        ws_proxies.append([
            p.host, p.username, decrypt_string_if_encrypted(p.password), 
            group_name, p.traffic_log_path, "TRUE" if p.is_active else "FALSE", p.description
        ])
    _apply_header_style(ws_proxies)

    # 3. 시트: ProxyInterfaces (장비별 개별 인터페이스 OID)
    ws_p_if = wb.create_sheet("3.ProxyInterfaces")
    ws_p_if.append(["Host", "InterfaceName", "In_OID", "Out_OID"])
    for p in proxies:
        if p.oids_json:
            try:
                oids = json.loads(p.oids_json)
                if_oids = oids.get("__interface_oids__", {})
                for if_name, config in if_oids.items():
                    in_oid = config.get("in_oid", "") if isinstance(config, dict) else config
                    out_oid = config.get("out_oid", "") if isinstance(config, dict) else ""
                    ws_p_if.append([p.host, if_name, in_oid, out_oid])
            except: pass
    _apply_header_style(ws_p_if)

    # 4. 시트: SystemResourceOIDs (공통 자원 OID 및 임계치)
    ws_res = wb.create_sheet("4.SystemResourceOIDs")
    ws_res.append(["MetricName", "OID_or_Command", "Threshold", "Unit", "Description"])
    res_cfg = db.query(ResourceConfig).first()
    if res_cfg:
        oids = json.loads(res_cfg.oids_json or "{}")
        th = oids.get("__thresholds__", {})
        metric_map = {
            "cpu": ("CPU사용률", "%"), "mem": ("메모리사용률", "%"), "disk": ("디스크사용률", "%"),
            "cc": ("동시접속수(CC)", "sess"), "cs": ("초당접속수(CS)", "cps"),
            "http": ("HTTP트래픽", "Mbps"), "https": ("HTTPS트래픽", "Mbps"), "ftp": ("FTP트래픽", "Mbps")
        }
        for key, (label, unit) in metric_map.items():
            ws_res.append([label, oids.get(key, ""), th.get(key, ""), unit, f"{key} 관련 설정"])
    _apply_header_style(ws_res)

    # 5. 시트: CommonInterfaces (공통 인터페이스 템플릿)
    ws_c_if = wb.create_sheet("5.CommonInterfaces")
    ws_c_if.append(["Name", "In_OID", "Out_OID", "Threshold_Mbps", "Bandwidth_Mbps"])
    if res_cfg:
        oids = json.loads(res_cfg.oids_json or "{}")
        if_oids = oids.get("__interface_oids__", {})
        if_th = oids.get("__interface_thresholds__", {})
        if_bw = oids.get("__interface_bandwidths__", {})
        for name, config in if_oids.items():
            in_oid = config.get("in_oid", "") if isinstance(config, dict) else config
            out_oid = config.get("out_oid", "") if isinstance(config, dict) else ""
            ws_c_if.append([name, in_oid, out_oid, if_th.get(name, ""), if_bw.get(name, "")])
    _apply_header_style(ws_c_if)

    # 6. 시트: GlobalSettings (기타 시스템 설정)
    ws_glob = wb.create_sheet("6.GlobalSettings")
    ws_glob.append(["Category", "SettingName", "Value", "Description"])
    if res_cfg:
        ws_glob.append(["SNMP", "CommunityString", res_cfg.community, "SNMP 커뮤니티"])
    sb_cfg = db.query(SessionBrowserConfig).first()
    if sb_cfg:
        ws_glob.append(["SSH", "Port", sb_cfg.ssh_port, "세션브라우저 포트"])
        ws_glob.append(["SSH", "Timeout", sb_cfg.timeout_sec, "응답 대기시간(초)"])
        ws_glob.append(["SSH", "HostKeyPolicy", sb_cfg.host_key_policy, "auto_add 또는 reject"])
    _apply_header_style(ws_glob)

    output = io.BytesIO()
    wb.save(output)
    output.seek(0)
    filename = f"PMT_Easy_Config_{datetime.now().strftime('%Y%m%d_%H%M')}.xlsx"
    return StreamingResponse(
        output,
        media_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        headers={"Content-Disposition": f"attachment; filename={filename}"}
    )

@router.post("/config/import")
async def import_full_config_excel(file: UploadFile = File(...), db: Session = Depends(get_db)):
    """펼쳐진 Excel 구조를 다시 복잡한 시스템 JSON 구조로 조립하여 저장합니다."""
    try:
        content = await file.read()
        wb = load_workbook(io.BytesIO(content), data_only=True)
        
        # 1. Import Groups
        group_map = {}
        if "1.Groups" in wb.sheetnames:
            ws = wb["1.Groups"]
            for row in ws.iter_rows(min_row=2, values_only=True):
                name = str(row[0]) if row[0] else None
                if not name: continue
                desc = str(row[1]) if row[1] else None
                existing = db.query(ProxyGroup).filter(ProxyGroup.name == name).first()
                if not existing:
                    existing = ProxyGroup(name=name, description=desc)
                    db.add(existing); db.commit(); db.refresh(existing)
                group_map[name] = existing.id

        # 2. Interface Data Preparation (ProxyInterfaces)
        proxy_if_map = {}
        if "3.ProxyInterfaces" in wb.sheetnames:
            ws = wb["3.ProxyInterfaces"]
            for row in ws.iter_rows(min_row=2, values_only=True):
                host, if_name, in_oid, out_oid = row[0], row[1], row[2], row[3]
                if not host or not if_name: continue
                if host not in proxy_if_map: proxy_if_map[host] = {}
                proxy_if_map[host][if_name] = {"in_oid": str(in_oid or ""), "out_oid": str(out_oid or "")}

        # 3. Import Proxies
        if "2.Proxies" in wb.sheetnames:
            ws = wb["2.Proxies"]
            for row in ws.iter_rows(min_row=2, values_only=True):
                host = str(row[0]) if row[0] else None
                if not host: continue
                
                # OIDs JSON 조립
                p_oids = None
                if host in proxy_if_map:
                    p_oids = json.dumps({"__interface_oids__": proxy_if_map[host]})

                fields = {
                    "host": host, "username": str(row[1] or ""), 
                    "password": encrypt_string(str(row[2])) if row[2] else None,
                    "group_id": group_map.get(str(row[3])), "traffic_log_path": str(row[4] or ""),
                    "is_active": str(row[5]).upper() == "TRUE", "description": str(row[6] or ""),
                    "oids_json": p_oids
                }
                
                existing = db.query(Proxy).filter(Proxy.host == host).first()
                if existing:
                    for k, v in fields.items():
                        if k == "password" and v is None: continue
                        setattr(existing, k, v)
                else:
                    db.add(Proxy(**fields))
            db.commit()

        # 4. System Config Assembly
        res_oids = {}
        res_th = {}
        if "4.SystemResourceOIDs" in wb.sheetnames:
            ws = wb["4.SystemResourceOIDs"]
            metric_rev_map = {
                "CPU사용률": "cpu", "메모리사용률": "mem", "디스크사용률": "disk",
                "동시접속수(CC)": "cc", "초당접속수(CS)": "cs",
                "HTTP트래픽": "http", "HTTPS트래픽": "https", "FTP트래픽": "ftp"
            }
            for row in ws.iter_rows(min_row=2, values_only=True):
                m_key = metric_rev_map.get(str(row[0]))
                if m_key:
                    res_oids[m_key] = str(row[1] or "")
                    if row[2] is not None:
                        try: res_th[m_key] = float(row[2])
                        except: pass

        common_if_oids = {}
        common_if_th = {}
        common_if_bw = {}
        if "5.CommonInterfaces" in wb.sheetnames:
            ws = wb["5.CommonInterfaces"]
            for row in ws.iter_rows(min_row=2, values_only=True):
                name = str(row[0]) if row[0] else None
                if not name: continue
                common_if_oids[name] = {"in_oid": str(row[1] or ""), "out_oid": str(row[2] or "")}
                if row[3] is not None:
                    try: common_if_th[name] = float(row[3])
                    except: pass
                if row[4] is not None:
                    try: common_if_bw[name] = float(row[4])
                    except: pass

        # Finalize Resource Config
        res_oids["__thresholds__"] = res_th
        res_oids["__interface_oids__"] = common_if_oids
        res_oids["__interface_thresholds__"] = common_if_th
        res_oids["__interface_bandwidths__"] = common_if_bw
        
        existing_rc = db.query(ResourceConfig).first()
        if not existing_rc: existing_rc = ResourceConfig(); db.add(existing_rc)
        
        # Global Settings
        if "6.GlobalSettings" in wb.sheetnames:
            ws = wb["6.GlobalSettings"]
            sb_data = {}
            for row in ws.iter_rows(min_row=2, values_only=True):
                name, val = row[1], row[2]
                if name == "CommunityString": existing_rc.community = str(val or "public")
                elif name in ["Port", "Timeout", "HostKeyPolicy"]: sb_data[name] = val
            
            if sb_data:
                existing_sb = db.query(SessionBrowserConfig).first()
                if not existing_sb: existing_sb = SessionBrowserConfig(); db.add(existing_sb)
                if "Port" in sb_data: existing_sb.ssh_port = int(sb_data["Port"])
                if "Timeout" in sb_data: existing_sb.timeout_sec = int(sb_data["Timeout"])
                if "HostKeyPolicy" in sb_data: existing_sb.host_key_policy = str(sb_data["HostKeyPolicy"])

        existing_rc.oids_json = json.dumps(res_oids)
        db.commit()

        return {"status": "success", "message": "Excel configuration imported and assembled successfully"}
        
    except Exception as e:
        db.rollback()
        raise HTTPException(status_code=400, detail=f"Import failed: {str(e)}")
