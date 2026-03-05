(function(){
	const API_BASE = '/api';
	let PROXIES = [];
	const STORAGE_KEY = 'tl_state_v1';
	let LAST_RENDERED_HASH = null;
	let IS_RESTORING = false;
	let CURRENT_VIEW = 'remote';
	let tlGridApi = null;
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
		if (!$tag.length) return;
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
	
	window.showTrafficLogDetail = showDetail;

	function saveState(records){
		const proxyIds = ($('#tlProxySelect').val() || []).map(v => parseInt(v, 10));
		const state = {
			proxyIds: proxyIds,
			query: $('#tlQuery').val(),
			limit: $('#tlLimit').val(),
			direction: $('#tlDirection').val(),
			view: CURRENT_VIEW,
			records: records || []
		};
		try {
			localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
		} catch(e) {}
	}

	function restoreState(){
		try {
			const saved = localStorage.getItem(STORAGE_KEY);
			if (!saved) return;
			const state = JSON.parse(saved);
			IS_RESTORING = true;
			
			if (state.query !== undefined) $('#tlQuery').val(state.query);
			if (state.limit !== undefined) $('#tlLimit').val(state.limit);
			if (state.direction !== undefined) $('#tlDirection').val(state.direction);
			
			setTimeout(() => {
				if (state.proxyIds && state.proxyIds.length > 0) {
					const ts = document.getElementById('tlProxySelect')._tom;
					if (ts) ts.setValue(state.proxyIds.map(String), false);
				}
				if (state.records && state.records.length > 0) {
					renderTable(state.records);
				}
				IS_RESTORING = false;
			}, 300);
		} catch(e) { IS_RESTORING = false; }
	}

	async function loadLogs(){
		const proxyIds = ($('#tlProxySelect').val() || []).map(v => parseInt(v, 10));
		if (proxyIds.length === 0) {
			showError('프록시를 선택하세요.');
			return;
		}
		
		clearError();
		setStatus('조회 중...', 'is-warning');
		
		try {
			// 백엔드가 다중 ID를 지원하지 않는 경우 첫 번째 ID만 사용하도록 호환성 유지
			const proxyId = proxyIds[0];
			const query = $('#tlQuery').val() || '';
			const limit = parseInt($('#tlLimit').val(), 10) || 200;
			const direction = $('#tlDirection').val() || 'tail';
			
			const res = await fetch(`${API_BASE}/traffic-logs/query?proxy_id=${proxyId}&query=${encodeURIComponent(query)}&limit=${limit}&direction=${direction}`);
			if (!res.ok) throw new Error('로그 조회에 실패했습니다.');
			
			const data = await res.json();
			const records = data.records || [];
			renderTable(records);
			setStatus(`${records.length}건 조회됨`, 'is-success');
			saveState(records);
		} catch(err) {
			showError(err.message);
			setStatus('실패', 'is-danger');
		}
	}

	function renderTable(records){
		if (!tlGridApi) {
			const gridOptions = {
				columnDefs: COLS.map(c => ({ field: c, headerName: c.toUpperCase(), width: 150 })),
				rowData: records,
				pagination: true,
				paginationPageSize: 100,
				onRowDoubleClicked: params => showDetail(params.data),
				theme: 'quartz'
			};
			tlGridApi = agGrid.createGrid(document.querySelector('#tlTableGrid'), gridOptions);
		} else {
			tlGridApi.setGridOption('rowData', records);
		}
		$('#tlResultParsed').show();
	}

	$(document).ready(() => {
		// DeviceSelector 초기화 (그룹 선택 없이 전체 프록시 표시)
		window.DeviceSelector.init({
			proxySelect: '#tlProxySelect',
			proxyTrigger: '#tlProxyTrigger',
			selectionCounter: '#tlSelectionCounter',
			onData: (data) => {
				PROXIES = data.proxies;
				if (!IS_RESTORING) restoreState();
			}
		});

		$('#tlLoadBtn').on('click', loadLogs);
		$('#tlQuickFilter').on('input', function() {
			if (tlGridApi) tlGridApi.setGridOption('quickFilterText', $(this).val());
		});
		$('#tlClearFilters').on('click', () => {
			$('#tlQuickFilter').val('');
			if (tlGridApi) {
				tlGridApi.setGridOption('quickFilterText', '');
				tlGridApi.setFilterModel(null);
			}
		});
		
		// URL 경로 처리
		if (window.location.pathname === '/traffic-logs/upload') {
			$('#tlRemoteSection').hide();
			$('#tlaSection').show();
		}
	});
})();
