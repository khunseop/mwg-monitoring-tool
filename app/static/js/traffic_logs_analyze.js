(function(){
	const API_BASE = '/api';
	let charts = {};

	function setStatus(text, cls){
		const $tag = $('#tlaStatus');
		$tag.text(text);
		$tag.removeClass().addClass('tag').addClass(cls || 'is-light');
	}

	function showError(msg){ $('#tlaError').text(msg).show(); }
	function clearError(){ $('#tlaError').hide().text(''); }

	function humanBytes(v){ return (window.AppUtils && AppUtils.formatBytes) ? AppUtils.formatBytes(v) : String(v); }

	function renderSummary(summary){
		$('#tlaTotalLines').text(summary.total_lines || 0);
		$('#tlaParsed').text(summary.parsed_lines || 0);
		$('#tlaUnparsed').text(summary.unparsed_lines || 0);
		$('#tlaClients').text(summary.unique_clients || 0);
		$('#tlaHosts').text(summary.unique_hosts || 0);
		$('#tlaBlocked').text(summary.blocked_requests || 0);
		$('#tlaRecv').text(humanBytes(summary.total_recv_bytes || 0));
		$('#tlaSent').text(humanBytes(summary.total_sent_bytes || 0));
		var start = summary.time_range_start || null;
		var end = summary.time_range_end || null;
		var fmt = function(x){
			if(!x) return '-';
			try{ return (window.AppUtils && AppUtils.formatDateTime) ? AppUtils.formatDateTime(x) : String(x); }catch(e){ return String(x); }
		};
		$('#tlaTimeStart').text(fmt(start));
		$('#tlaTimeEnd').text(fmt(end));
		$('#tlaSummary').show();
	}

	function ensureChart(id, type, options){
		if(!window.ApexCharts) return null;
		if(charts[id]){ try { charts[id].destroy(); } catch(e){} charts[id] = null; }
		const el = document.querySelector('#' + id);
		if(!el) return null;
		const base = { chart: { type, height: 280, animations: { dynamicAnimation: { speed: 250 } } }, legend: { show: false }, noData: { text: 'No data' } };
		const opts = Object.assign({}, base, options || {});
		charts[id] = new ApexCharts(el, opts);
		charts[id].render();
		return charts[id];
	}

	function toBarSeriesFromPairs(pairs){
		const categories = pairs.map(p => String(p[0]));
		const data = pairs.map(p => Number(p[1] || 0));
		return { categories, data };
	}

	function renderCharts(payload){
		if(!payload) return;
		const top = payload.top || {};
		const sClientReq = toBarSeriesFromPairs(top.clients_by_requests || []);
		ensureChart('tlaChartClientReq', 'bar', { series: [{ name: 'req', data: sClientReq.data }], xaxis: { categories: sClientReq.categories, labels: { rotate: -45 } } });

		const sClientDown = toBarSeriesFromPairs(top.clients_by_download_bytes || []);
		ensureChart('tlaChartClientDown', 'bar', { series: [{ name: 'bytes', data: sClientDown.data }], xaxis: { categories: sClientDown.categories, labels: { rotate: -45 } }, yaxis: { labels: { formatter: v => humanBytes(v) } }, tooltip: { y: { formatter: v => humanBytes(v) } } });

		const sClientUp = toBarSeriesFromPairs(top.clients_by_upload_bytes || []);
		ensureChart('tlaChartClientUp', 'bar', { series: [{ name: 'bytes', data: sClientUp.data }], xaxis: { categories: sClientUp.categories, labels: { rotate: -45 } }, yaxis: { labels: { formatter: v => humanBytes(v) } }, tooltip: { y: { formatter: v => humanBytes(v) } } });

		const sHosts = toBarSeriesFromPairs(top.hosts_by_requests || []);
		ensureChart('tlaChartHosts', 'bar', { series: [{ name: 'req', data: sHosts.data }], xaxis: { categories: sHosts.categories, labels: { rotate: -45 } } });

		const sUrls = toBarSeriesFromPairs(top.urls_by_requests || []);
		ensureChart('tlaChartUrls', 'bar', { series: [{ name: 'req', data: sUrls.data }], xaxis: { categories: sUrls.categories, labels: { rotate: -45, trim: true } }, dataLabels: { enabled: false } });

		const sHostDown = toBarSeriesFromPairs(top.hosts_by_download_bytes || []);
		ensureChart('tlaChartHostDown', 'bar', { series: [{ name: 'bytes', data: sHostDown.data }], xaxis: { categories: sHostDown.categories, labels: { rotate: -45 } }, yaxis: { labels: { formatter: v => humanBytes(v) } }, tooltip: { y: { formatter: v => humanBytes(v) } } });

		const sHostUp = toBarSeriesFromPairs(top.hosts_by_upload_bytes || []);
		ensureChart('tlaChartHostUp', 'bar', { series: [{ name: 'bytes', data: sHostUp.data }], xaxis: { categories: sHostUp.categories, labels: { rotate: -45 } }, yaxis: { labels: { formatter: v => humanBytes(v) } }, tooltip: { y: { formatter: v => humanBytes(v) } } });

		$('#tlaCharts').show();
	}

	async function analyze(){
		clearError();
		const fileInput = document.getElementById('tlaFile');
		if(!fileInput || !fileInput.files || fileInput.files.length === 0){ showError('파일을 선택하세요'); return; }
		const file = fileInput.files[0];
		const topN = Math.max(1, Math.min(100, parseInt($('#tlaTopN').val() || '20', 10)));

		setStatus('업로드 중...', 'is-info');
		$('#tlaAnalyzeBtn').addClass('is-loading').prop('disabled', true);
		try{
			const form = new FormData();
			form.append('logfile', file);
			const url = `${API_BASE}/traffic-logs/analyze-upload?topN=${encodeURIComponent(String(topN))}`;
			const res = await fetch(url, { method: 'POST', body: form });
			if(!res.ok){
				const err = await res.json().catch(()=>({detail:'분석 실패'}));
				throw new Error(err.detail || '분석 실패');
			}
			const data = await res.json();
			renderSummary(data.summary || {});
			renderCharts(data);
			setStatus('완료', 'is-success');
		}catch(e){
			showError(e.message || String(e));
			setStatus('실패', 'is-danger');
		}finally{
			$('#tlaAnalyzeBtn').removeClass('is-loading').prop('disabled', false);
		}
	}

	$(function(){
		$('#tlaFile').on('change', function(){
			const f = this.files && this.files[0];
			$('#tlaFileName').text(f ? (f.name + ' (' + (f.size||0) + ' bytes)') : '선택된 파일 없음');
		});
		$('#tlaAnalyzeBtn').on('click', analyze);
	});
})();

