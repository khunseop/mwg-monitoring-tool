(function(){
	const API_BASE = '/api';
	let PROXIES = [];
	let LAST_RENDERED_HASH = null;
	const COLS = [
		"datetime","username","client_ip","url_destination_ip","timeintransaction",
		"response_statuscode","cache_status","comm_name","url_protocol","url_host",
		"url_path","url_parametersstring","url_port","url_categories","url_reputationstring",
		"url_reputation","mediatype_header","recv_byte","sent_byte","user_agent","referer",
		"url_geolocation","application_name","currentruleset","currentrule","action_names",
		"block_id","proxy_id","ssl_certificate_cn","ssl_certificate_sigmethod",
		"web_socket","content_lenght"
	];

	function setStatus(text, cls){
		const $tag = $('#tlStatus');
		$tag.text(text);
		$tag.removeClass().addClass('tag').addClass(cls || 'is-light');
	}

	function showError(msg){
		$('#tlError').text(msg).show();
	}

	function clearError(){ $('#tlError').hide().text(''); }

	function showDetail(record){
		const $body = $('#tlDetailBody');
		$body.empty();
		COLS.forEach(c => {
			let v = record[c];
			if(v === null || v === undefined) v = '';
			let formatted = v;
			if(c === 'datetime' || c === 'collected_at'){
				formatted = (window.AppUtils && AppUtils.formatDateTime) ? AppUtils.formatDateTime(v) : v;
			}else if(c === 'response_statuscode'){
				formatted = (window.AppUtils && AppUtils.renderStatusTag) ? AppUtils.renderStatusTag(v) : String(v);
			}else if(c === 'recv_byte' || c === 'sent_byte' || c === 'content_lenght'){
				formatted = (window.AppUtils && AppUtils.formatBytes) ? AppUtils.formatBytes(v) : v;
			}else if(c === 'timeintransaction'){
				// assume seconds if small; or ms when large
				var num = Number(v);
				if(Number.isFinite(num)){
					formatted = (window.AppUtils && AppUtils.formatDurationMs) ? AppUtils.formatDurationMs(num < 1000 ? num * 1000 : num) : v;
				}
			}
			const isUrlish = (c === 'url_path' || c === 'url_parametersstring' || c === 'referer' || c === 'url_host' || c === 'user_agent');
			const cls = isUrlish ? '' : (c === 'recv_byte' || c === 'sent_byte' || c === 'content_lenght' || c === 'response_statuscode' ? 'num' : '');
			$body.append(`<tr><th style="width: 220px;">${c}</th><td class="${cls}">${typeof formatted === 'string' ? formatted : String(formatted)}</td></tr>`);
		});
		$('#tlDetailModal').addClass('is-active');
	}

	function saveState(){ /* no-op */ }
	function restoreState(){ /* no-op */ }

	async function fetchProxies(){
		const res = await fetch(`${API_BASE}/proxies?limit=500&offset=0`);
		if(!res.ok){ throw new Error('프록시 목록을 불러오지 못했습니다'); }
		return await res.json();
	}

	function populateProxySelect(proxies){
		const $sel = $('#tlProxySelect');
		$sel.find('option:not([value=""])').remove();
		const active = proxies.filter(p => p.is_active);
		active.forEach(p => {
			const labelBase = p.group_name ? `${p.host} (${p.group_name})` : p.host;
			const label = p.traffic_log_path ? labelBase : `${labelBase} · 경로 미설정`;
			$sel.append(`<option value="${p.id}">${label}</option>`);
		});
		if($sel.find('option').length === 1){
			$sel.append('<option disabled>활성화된 프록시가 없습니다</option>');
		}
	}

	function destroyTableIfExists(){
		const id = '#tlTable';
		if($.fn.DataTable && $.fn.DataTable.isDataTable(id)){
			$(id).DataTable().clear().destroy();
		}
		$('#tlTableHead').empty();
		$('#tlTableBody').empty();
	}

	function renderParsed(records){
		destroyTableIfExists();
		const $head = $('#tlTableHead');
		COLS.forEach(c => { $head.append(`<th>${c}</th>`); });
		const $body = $('#tlTableBody');
		records.forEach((r, idx) => {
			const tds = COLS.map(c => {
				let v = r[c];
				if (v === null || v === undefined) v = '';
				let formatted = v;
				let orderVal = '';
				if(c === 'datetime' || c === 'collected_at'){
					var msOrder = null;
					if (window.AppUtils && AppUtils.parseTrafficLogDateMs) { msOrder = AppUtils.parseTrafficLogDateMs(String(v)); }
					if (msOrder == null) { var parsed = Date.parse(String(v)); msOrder = Number.isFinite(parsed) ? parsed : null; }
					if (msOrder != null) orderVal = String(msOrder);
					formatted = (window.AppUtils && AppUtils.formatDateTime) ? AppUtils.formatDateTime(v) : v;
				}else if(c === 'response_statuscode'){
					formatted = (window.AppUtils && AppUtils.renderStatusTag) ? AppUtils.renderStatusTag(v) : String(v);
					var code = Number(v); if (Number.isFinite(code)) orderVal = String(code);
				}else if(c === 'recv_byte' || c === 'sent_byte' || c === 'content_lenght'){
					var b = Number(v);
					if (Number.isFinite(b)) orderVal = String(b);
					formatted = (window.AppUtils && AppUtils.formatBytes) ? AppUtils.formatBytes(v) : v;
				}else if(c === 'timeintransaction'){
					var num = Number(v);
					if(Number.isFinite(num)){
						var msVal = num < 1000 ? num * 1000 : num;
						orderVal = String(msVal);
						formatted = (window.AppUtils && AppUtils.formatDurationMs) ? AppUtils.formatDurationMs(msVal) : v;
					}
				}
				const isUrlish = (c === 'url_path' || c === 'url_parametersstring' || c === 'referer' || c === 'url_host' || c === 'user_agent');
				const clsParts = ['dt-nowrap'];
				if(c === 'recv_byte' || c === 'sent_byte' || c === 'content_lenght') clsParts.push('num');
				if(c === 'response_statuscode') clsParts.push('mono');
				const cls = clsParts.join(' ');
				const content = isUrlish ? `<div class="dt-ellipsis">${String(formatted)}</div>` : (typeof formatted === 'string' ? formatted : String(formatted));
				const orderAttr = orderVal !== '' ? ` data-order="${orderVal}"` : '';
				return `<td class="${cls}" data-col="${c}"${orderAttr}>${content}</td>`;
			}).join('');
			$body.append(`<tr data-row="${idx}">${tds}</tr>`);
		});
		// Initialize DataTables via shared config (client-side only)
		const dt = TableConfig.init('#tlTable', { order: [] });
		setTimeout(function(){ TableConfig.adjustColumns(dt); }, 0);
		// Header filters via ColumnControl
		try{
			if (dt && dt['columnControl.bind']){ dt['columnControl.bind']({}); }
		}catch(e){ /* ignore */ }
		// Row click opens detail modal
		$('#tlTable tbody').off('click', 'tr').on('click', 'tr', function(){
			const rowIdx = $(this).data('row');
			if (rowIdx == null) return;
			showDetail(records[rowIdx] || {});
		});
		$('#tlResultParsed').show();
		$('#tlResultRaw').hide();
		$('#tlEmptyState').toggle(records.length === 0);
		// Update last rendered signature to suppress redundant re-renders
		try { LAST_RENDERED_HASH = JSON.stringify(records || []); } catch(e) { LAST_RENDERED_HASH = null; }
	}

	function renderRaw(lines){
		$('#tlRawPre').text(lines.join('\n'));
		$('#tlResultRaw').show();
		$('#tlResultParsed').hide();
		$('#tlEmptyState').toggle(lines.length === 0);
	}

	async function loadLogs(){
		clearError();
		const proxyId = $('#tlProxySelect').val();
		if(!proxyId){ showError('프록시를 선택하세요'); return; }
		const selected = PROXIES.find(p => String(p.id) === String(proxyId));
		if(!selected){ showError('프록시 정보를 찾을 수 없습니다'); return; }
		if(!selected.traffic_log_path){
			showError('선택한 프록시에 트래픽 로그 경로가 설정되어 있지 않습니다. 설정 > 프록시 수정에서 경로를 지정하세요.');
			return;
		}
		const q = ($('#tlQuery').val() || '').trim();
		const limit = Math.max(1, Math.min(1000, parseInt($('#tlLimit').val() || '200', 10)));
		const direction = $('#tlDirection').val();
		const parsed = true;

		setStatus('조회 중...', 'is-info');
		// Clear current UI
		destroyTableIfExists();
		$('#tlResultParsed').hide();
		$('#tlResultRaw').hide();
		$('#tlEmptyState').hide();
		saveState();
		$('#tlLoadBtn').addClass('is-loading').prop('disabled', true);
		try{
			const params = new URLSearchParams();
			params.set('limit', String(limit));
			params.set('direction', direction);
			params.set('parsed', String(parsed));
			if(q.length > 0){ params.set('q', q); }
			const url = `${API_BASE}/traffic-logs/${encodeURIComponent(proxyId)}?${params.toString()}`;
			const res = await fetch(url);
			if(!res.ok){
				const err = await res.json().catch(()=>({detail:'에러'}));
				throw new Error(err.detail || '조회 실패');
			}
			const data = await res.json();
			renderParsed(data.records || []);
			// No persistence
			const suffix = data.truncated ? ' (truncated)' : '';
			setStatus(`완료 - ${data.count} 라인${suffix}`, 'is-success');
		}catch(e){
			showError(e.message || String(e));
			setStatus('실패', 'is-danger');
		}finally{
			$('#tlLoadBtn').removeClass('is-loading').prop('disabled', false);
		}
	}

	$(async function(){
		try{
			setStatus('프록시 목록 로딩...', 'is-light');
			const proxies = await fetchProxies();
			PROXIES = Array.isArray(proxies) ? proxies : [];
			populateProxySelect(PROXIES);
			setStatus('대기', 'is-light');
		}catch(e){
			showError('프록시 목록 로딩 실패');
			setStatus('실패', 'is-danger');
		}
		// No restore or persistence
		$('#tlProxySelect, #tlQuery, #tlLimit, #tlDirection').on('change keyup', function(){ /* no-op */ });
		$('#tlLoadBtn').on('click', loadLogs);
		// No cross-tab storage sync
	});
})();

