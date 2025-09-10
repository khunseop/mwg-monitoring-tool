from typing import Dict, Any, List, Optional


DELIMITER = " :| "
FIELDS = [
	"datetime","username","client_ip","url_destination_ip","timeintransaction",
	"response_statuscode","cache_status","comm_name","url_protocol","url_host",
	"url_path","url_parametersstring","url_port","url_categories","url_reputationstring",
	"url_reputation","mediatype_header","recv_byte","sent_byte","user_agent","referer",
	"url_geolocation","application_name","currentruleset","currentrule","action_names",
	"block_id","proxy_id","ssl_certificate_cn","ssl_certificate_sigmethod",
	"web_socket","content_lenght"
]

NUMERIC_INT = {"response_statuscode","url_port","url_reputation","recv_byte","sent_byte","content_lenght"}
NUMERIC_FLOAT = {"timeintransaction"}
BOOL_FIELDS = {"web_socket"}


def _parse_bool(value: str) -> bool:
	v = value.strip().lower()
	return v in {"1","true","yes","y"}


def _coerce(field_name: str, raw_value: str):
	if field_name in NUMERIC_INT:
		try:
			return int(raw_value)
		except Exception:
			return None
	if field_name in NUMERIC_FLOAT:
		try:
			return float(raw_value)
		except Exception:
			return None
	if field_name in BOOL_FIELDS:
		return _parse_bool(raw_value)
	return raw_value


def parse_log_line(line: str) -> Dict[str, Any]:
	parts: List[str] = line.rstrip("\n").split(DELIMITER)
	if len(parts) != len(FIELDS):
		if len(parts) < len(FIELDS):
			parts += [""] * (len(FIELDS) - len(parts))
		else:
			parts = parts[:len(FIELDS)]
	record: Dict[str, Any] = {}
	for field_name, raw in zip(FIELDS, parts):
		record[field_name] = _coerce(field_name, raw)
	return record

