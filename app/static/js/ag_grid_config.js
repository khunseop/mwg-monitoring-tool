(function(window){
	'use strict';

	// ag-grid 공통 설정 모듈
	var AgGridConfig = {
		// 기본 컬럼 정의 (세션브라우저용)
		getSessionBrowserColumns: function() {
			return [
				{ field: 'host', headerName: '프록시', sortable: true, filter: 'agTextColumnFilter', filterParams: { applyButton: true, clearButton: true }, minWidth: 120, width: 150 },
				{ field: 'creation_time', headerName: '생성시각', sortable: true, filter: 'agTextColumnFilter', filterParams: { applyButton: true, clearButton: true }, minWidth: 160, width: 180,
					valueFormatter: function(params) {
						return (window.AppUtils && AppUtils.formatDateTime) ? AppUtils.formatDateTime(params.value) : params.value;
					}
				},
				{ field: 'protocol', headerName: '프로토콜', sortable: true, filter: 'agTextColumnFilter', filterParams: { applyButton: true, clearButton: true }, minWidth: 90, width: 100 },
				{ field: 'user_name', headerName: '사용자', sortable: true, filter: 'agTextColumnFilter', filterParams: { applyButton: true, clearButton: true }, minWidth: 100, width: 120 },
				{ field: 'client_ip', headerName: '클라이언트 IP', sortable: true, filter: 'agTextColumnFilter', filterParams: { applyButton: true, clearButton: true }, minWidth: 130, width: 140, cellClass: 'mono' },
				{ field: 'server_ip', headerName: '서버 IP', sortable: true, filter: 'agTextColumnFilter', filterParams: { applyButton: true, clearButton: true }, minWidth: 130, width: 140, cellClass: 'mono' },
				{ field: 'cl_bytes_received', headerName: 'CL 수신', sortable: true, filter: 'agNumberColumnFilter', filterParams: { applyButton: true, clearButton: true }, minWidth: 100, width: 120, cellClass: 'num',
					valueFormatter: function(params) {
						return (window.AppUtils && AppUtils.formatBytes) ? AppUtils.formatBytes(params.value) : params.value;
					}
				},
				{ field: 'cl_bytes_sent', headerName: 'CL 송신', sortable: true, filter: 'agNumberColumnFilter', filterParams: { applyButton: true, clearButton: true }, minWidth: 100, width: 120, cellClass: 'num',
					valueFormatter: function(params) {
						return (window.AppUtils && AppUtils.formatBytes) ? AppUtils.formatBytes(params.value) : params.value;
					}
				},
				{ field: 'age_seconds', headerName: 'Age(s)', sortable: true, filter: 'agNumberColumnFilter', filterParams: { applyButton: true, clearButton: true }, minWidth: 80, width: 100,
					valueFormatter: function(params) {
						return (window.AppUtils && AppUtils.formatSeconds) ? AppUtils.formatSeconds(params.value) : params.value;
					}
				},
				{ field: 'url', headerName: 'URL', sortable: true, filter: 'agTextColumnFilter', filterParams: { applyButton: true, clearButton: true }, minWidth: 200, flex: 1, 
					cellRenderer: function(params) {
						if (!params.value) return '';
						var url = String(params.value);
						var short = url.length > 100 ? url.substring(0, 100) + '…' : url;
						return '<div style="overflow: hidden; text-overflow: ellipsis; white-space: nowrap;" title="' + url.replace(/"/g, '&quot;') + '">' + short + '</div>';
					}
				},
				{ field: 'id', headerName: 'id', hide: true }
			];
		},

		// 트래픽로그용 컬럼 정의
		getTrafficLogColumns: function() {
			var COLS = [
				"datetime","username","client_ip","url_destination_ip","timeintransaction",
				"response_statuscode","cache_status","comm_name","url_protocol","url_host",
				"url_path","url_parametersstring","url_port","url_categories","url_reputationstring",
				"url_reputation","mediatype_header","recv_byte","sent_byte","user_agent","referer",
				"url_geolocation","application_name","currentruleset","currentrule","action_names",
				"block_id","proxy_id","ssl_certificate_cn","ssl_certificate_sigmethod",
				"web_socket","content_lenght"
			];
			
			return COLS.map(function(col) {
				var colDef = {
					field: col,
					headerName: col,
					sortable: true,
					filter: 'agTextColumnFilter',
					filterParams: { applyButton: true, clearButton: true },
					minWidth: 120,
					width: 150
				};
				
				// 특정 컬럼에 대한 포맷터 설정
				if (col === 'datetime' || col === 'collected_at') {
					colDef.valueFormatter = function(params) {
						return (window.AppUtils && AppUtils.formatDateTime) ? AppUtils.formatDateTime(params.value) : params.value;
					};
				} else if (col === 'response_statuscode') {
					colDef.cellRenderer = function(params) {
						return (window.AppUtils && AppUtils.renderStatusTag) ? AppUtils.renderStatusTag(params.value) : String(params.value || '');
					};
					colDef.cellClass = 'mono';
				} else if (col === 'recv_byte' || col === 'sent_byte' || col === 'content_lenght') {
					colDef.valueFormatter = function(params) {
						return (window.AppUtils && AppUtils.formatBytes) ? AppUtils.formatBytes(params.value) : params.value;
					};
					colDef.cellClass = 'num';
				} else if (col === 'timeintransaction') {
					colDef.valueFormatter = function(params) {
						var num = Number(params.value);
						if (Number.isFinite(num)) {
							var msVal = num < 1000 ? num * 1000 : num;
							return (window.AppUtils && AppUtils.formatDurationMs) ? AppUtils.formatDurationMs(msVal) : params.value;
						}
						return params.value;
					};
				}
				
				// URL 관련 컬럼은 긴 텍스트 처리
				if (col === 'url_path' || col === 'url_parametersstring' || col === 'referer' || col === 'url_host' || col === 'user_agent') {
					colDef.minWidth = 200;
					colDef.flex = 1;
					colDef.cellRenderer = function(params) {
						if (!params.value) return '';
						var val = String(params.value);
						return '<div style="overflow: hidden; text-overflow: ellipsis; white-space: nowrap;" title="' + val.replace(/"/g, '&quot;') + '">' + val + '</div>';
					};
				}
				
				// 숫자 컬럼은 숫자 필터 사용
				if (col === 'recv_byte' || col === 'sent_byte' || col === 'content_lenght' || col === 'timeintransaction' || col === 'response_statuscode') {
					colDef.filter = 'agNumberColumnFilter';
				}
				
				return colDef;
			});
		},

		// 서버사이드 기본 설정
		getServerSideDefaultOptions: function() {
			return {
				rowModelType: 'serverSide',
				serverSideInfiniteScroll: true,
				cacheBlockSize: 25,
				pagination: true,
				paginationPageSize: 25,
				enableFilter: true,
				enableSorting: true,
				animateRows: false,
				suppressRowClickSelection: false,
				domLayout: 'normal',
				defaultColDef: {
					sortable: true,
					filter: true,
					resizable: true,
				}
			};
		},

		// 클라이언트사이드 기본 설정
		getClientSideDefaultOptions: function() {
			return {
				rowModelType: 'clientSide',
				pagination: true,
				paginationPageSize: 25,
				enableFilter: true,
				enableSorting: true,
				animateRows: false,
				suppressRowClickSelection: false,
				domLayout: 'normal',
				defaultColDef: {
					sortable: true,
					filter: 'agTextColumnFilter',
					filterParams: { applyButton: true, clearButton: true },
					resizable: true,
					minWidth: 100
				}
			};
		}
	};

	window.AgGridConfig = AgGridConfig;

})(window);
