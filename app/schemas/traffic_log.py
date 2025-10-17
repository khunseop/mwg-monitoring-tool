from pydantic import BaseModel, Field
from typing import Optional, List
from datetime import datetime


class TrafficLogRecord(BaseModel):
	datetime: Optional[str] = None
	username: Optional[str] = None
	client_ip: Optional[str] = None
	url_destination_ip: Optional[str] = None
	timeintransaction: Optional[float] = None
	response_statuscode: Optional[int] = None
	cache_status: Optional[str] = None
	comm_name: Optional[str] = None
	url_protocol: Optional[str] = None
	url_host: Optional[str] = None
	url_path: Optional[str] = None
	url_parametersstring: Optional[str] = None
	url_port: Optional[int] = None
	url_categories: Optional[str] = None
	url_reputationstring: Optional[str] = None
	url_reputation: Optional[int] = None
	mediatype_header: Optional[str] = None
	recv_byte: Optional[int] = None
	sent_byte: Optional[int] = None
	user_agent: Optional[str] = None
	referer: Optional[str] = None
	url_geolocation: Optional[str] = None
	application_name: Optional[str] = None
	currentruleset: Optional[str] = None
	currentrule: Optional[str] = None
	action_names: Optional[str] = None
	block_id: Optional[str] = None
	proxy_id: Optional[str] = None
	ssl_certificate_cn: Optional[str] = None
	ssl_certificate_sigmethod: Optional[str] = None
	web_socket: Optional[bool] = None
	content_lenght: Optional[int] = None


class TrafficLogResponse(BaseModel):
	proxy_id: int
	lines: Optional[List[str]] = None
	raw_lines: Optional[List[str]] = None # For detail view
	records: Optional[List[dict]] = None # Use dict for dynamic keys
	headers: List[str] = []
	truncated: bool = False
	count: int


class TrafficLogDB(BaseModel):
	id: int
	proxy_id: int
	collected_at: datetime
	# Flattened fields for detail
	datetime: Optional[str] = None
	username: Optional[str] = None
	client_ip: Optional[str] = None
	url_destination_ip: Optional[str] = None
	timeintransaction: Optional[float] = None
	response_statuscode: Optional[int] = None
	cache_status: Optional[str] = None
	comm_name: Optional[str] = None
	url_protocol: Optional[str] = None
	url_host: Optional[str] = None
	url_path: Optional[str] = None
	url_parametersstring: Optional[str] = None
	url_port: Optional[int] = None
	url_categories: Optional[str] = None
	url_reputationstring: Optional[str] = None
	url_reputation: Optional[int] = None
	mediatype_header: Optional[str] = None
	recv_byte: Optional[int] = None
	sent_byte: Optional[int] = None
	user_agent: Optional[str] = None
	referer: Optional[str] = None
	url_geolocation: Optional[str] = None
	application_name: Optional[str] = None
	currentruleset: Optional[str] = None
	currentrule: Optional[str] = None
	action_names: Optional[str] = None
	block_id: Optional[str] = None
	ssl_certificate_cn: Optional[str] = None
	ssl_certificate_sigmethod: Optional[str] = None
	web_socket: Optional[bool] = None
	content_lenght: Optional[int] = None

	class Config:
		from_attributes = True


