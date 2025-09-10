(function(){
	const API_BASE = '/api';
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

	async function fetchProxies(){
		const res = await fetch(`${API_BASE}/proxies?limit=500&offset=0`);
		if(!res.ok){ throw new Error('프록시 목록을 불러오지 못했습니다'); }
		return await res.json();
	}

	function populateProxySelect(proxies){
		const $sel = $('#tlProxySelect');
		$sel.find('option:not([value=""])').remove();
		proxies
			.filter(p => p.is_active && p.traffic_log_path)
			.forEach(p => {
				const label = p.group_name ? `${p.host} (${p.group_name})` : p.host;
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
		records.forEach(r => {
			const tds = COLS.map(c => {
				let v = r[c];
				if (v === null || v === undefined) v = '';
				return `<td>${String(v)}</td>`;
			}).join('');
			$body.append(`<tr>${tds}</tr>`);
		});
		if($.fn.DataTable){
			$('#tlTable').DataTable({
				scrollX: true,
				pageLength: 25,
				lengthMenu: [ [25, 50, 100], [25, 50, 100] ],
				order: []
			});
		}
		$('#tlResultParsed').show();
		$('#tlResultRaw').hide();
	}

	function renderRaw(lines){
		$('#tlRawPre').text(lines.join('\n'));
		$('#tlResultRaw').show();
		$('#tlResultParsed').hide();
	}

	async function loadLogs(){
		clearError();
		const proxyId = $('#tlProxySelect').val();
		if(!proxyId){ showError('프록시를 선택하세요'); return; }
		const q = ($('#tlQuery').val() || '').trim();
		const limit = Math.max(1, Math.min(1000, parseInt($('#tlLimit').val() || '200', 10)));
		const direction = $('#tlDirection').val();
		const parsed = $('#tlParsed').is(':checked');

		setStatus('조회 중...', 'is-info');
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
			if(parsed){
				renderParsed(data.records || []);
			}else{
				renderRaw(data.lines || []);
			}
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
			populateProxySelect(proxies);
			setStatus('대기', 'is-light');
		}catch(e){
			showError('프록시 목록 로딩 실패');
			setStatus('실패', 'is-danger');
		}
		$('#tlLoadBtn').on('click', loadLogs);
	});
})();

