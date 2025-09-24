(function(){
	const API_BASE = '/api';
	let PROXIES = [];
	const STORAGE_KEY = 'tl_state_v1';
	let LAST_RENDERED_HASH = null;
	let IS_RESTORING = false;
	let CURRENT_VIEW = 'remote';
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

	// localStorage helpers for persistence
	function tryWriteState(state){
		try{
			localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
			return true;
		}catch(e){
			return false;
		}
	}

	function sanitizeRecordsForStorage(records){
		const MAX = 500;
		const arr = Array.isArray(records) ? records.slice(0, MAX) : [];
		return arr.map(function(r){
			if(!r || typeof r !== 'object') return {};
			const out = {};
			COLS.forEach(function(c){
				let v = r[c];
				if(typeof v === 'string' && v.length > 2000){ v = v.slice(0, 2000) + '…'; }
				out[c] = v;
			});
			return out;
		});
	}

	function persistState(state){
		if(tryWriteState(state)) return true;
		if(!state || !Array.isArray(state.records) || state.records.length === 0) return false;
		let reduced = sanitizeRecordsForStorage(state.records);
		let temp = Object.assign({}, state, { records: reduced });
		if(tryWriteState(temp)) return true;
		let count = Math.min(reduced.length, 250);
		while(count > 0){
			let slice = reduced.slice(0, count);
			temp = Object.assign({}, state, { records: slice });
			if(tryWriteState(temp)) return true;
			count = Math.floor(count / 2);
		}
		return false;
	}

	function saveState(recordsForSave){
		let prev;
		try{
			const raw = localStorage.getItem(STORAGE_KEY);
			if(raw){ prev = JSON.parse(raw); }
		}catch(e){ /* ignore */ }
		const state = {
			view: CURRENT_VIEW,
			proxyId: $('#tlProxySelect').val() || '',
			query: ($('#tlQuery').val() || '').trim(),
			limit: $('#tlLimit').val() || '200',
			direction: $('#tlDirection').val() || 'tail',
			parsed: true,
			records: (recordsForSave !== undefined) ? (Array.isArray(recordsForSave) ? recordsForSave : undefined) : (prev ? prev.records : undefined),
			savedAt: Date.now()
		};
		persistState(state);
	}

	function restoreState(){
		try{
			IS_RESTORING = true;
			const raw = localStorage.getItem(STORAGE_KEY);
			if(!raw) return;
			const state = JSON.parse(raw);
			if(state.view){ CURRENT_VIEW = state.view; }
			if(state.proxyId !== undefined){ $('#tlProxySelect').val(String(state.proxyId)); }
			if(state.query !== undefined){ $('#tlQuery').val(state.query); }
			if(state.limit !== undefined){ $('#tlLimit').val(state.limit); }
			if(state.direction !== undefined){ $('#tlDirection').val(state.direction); }
			if(Array.isArray(state.records) && state.records.length > 0){
				var hashNow;
				try { hashNow = JSON.stringify(state.records || []); } catch(e) { hashNow = null; }
				if (hashNow !== LAST_RENDERED_HASH) {
					renderParsed(state.records);
				} else {
					$('#tlResultParsed').show();
					$('#tlResultRaw').hide();
					$('#tlEmptyState').toggle(state.records.length === 0);
				}
				setStatus('저장된 내역', 'is-light');
			}else{
				$('#tlEmptyState').show();
			}
		}catch(e){ /* ignore */ }
		finally { IS_RESTORING = false; }
	}

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
		// Initialize DataTables via shared config
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
		// Clear current UI and cached results to ensure replacement semantics
		destroyTableIfExists();
		$('#tlResultParsed').hide();
		$('#tlResultRaw').hide();
		$('#tlEmptyState').hide();
		saveState([]);
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
			// Persist last results only after successful fetch to avoid storage-event loops
			saveState(Array.isArray(data.records) ? data.records : []);
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
		// Restore previous state and results after proxies are loaded
		restoreState();
		// Tabs behavior
		function setView(view, write){
			CURRENT_VIEW = view;
			if(view === 'upload'){
				$('#tlRemoteSection').hide();
				$('#tlaSection').show();
				$('#tlTabs li').removeClass('is-active');
				$('#tlTabs [data-view="upload"]').parent().addClass('is-active');
			}else{
				$('#tlaSection').hide();
				$('#tlRemoteSection').show();
				$('#tlTabs li').removeClass('is-active');
				$('#tlTabs [data-view="remote"]').parent().addClass('is-active');
			}
			if(write){ saveState(undefined); }
		}
		function applyViewFromQuery(){
			const params = new URLSearchParams(window.location.search);
			const view = (params.get('view') || CURRENT_VIEW || 'remote').toLowerCase();
			setView(view === 'upload' ? 'upload' : 'remote', false);
		}
		applyViewFromQuery();
		$('#tlTabs').on('click', 'a[data-view]', function(e){ e.preventDefault(); var v = $(this).data('view'); setView(String(v || 'remote'), true); });
		// Save selection changes
		$('#tlProxySelect, #tlQuery, #tlLimit, #tlDirection').on('change keyup', function(){ saveState(undefined); });
		$('#tlLoadBtn').on('click', loadLogs);
		// Cross-tab sync: only re-render when records changed
		try{
			window.addEventListener('storage', function(e){
				if(!e) return;
				if(e.key === STORAGE_KEY){
					try{
						const state = JSON.parse(e.newValue || 'null');
						if(state && Array.isArray(state.records)){
							var hashNow = null;
							try { hashNow = JSON.stringify(state.records || []); } catch(err2) { hashNow = null; }
							if (hashNow !== LAST_RENDERED_HASH) {
								restoreState();
							} else {
								// Only sync controls
								if(state.proxyId !== undefined){ $('#tlProxySelect').val(String(state.proxyId)); }
								if(state.query !== undefined){ $('#tlQuery').val(state.query); }
								if(state.limit !== undefined){ $('#tlLimit').val(state.limit); }
								if(state.direction !== undefined){ $('#tlDirection').val(state.direction); }
								if(state.view){ setView(state.view, false); }
							}
						} else {
							restoreState();
						}
					}catch(err3){ /* ignore */ }
				}
			});
		}catch(err){ /* ignore */ }
	});
})();

