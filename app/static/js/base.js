$(document).ready(function() {
    // Navbar burger toggle
    $(document).on('click', '.navbar-burger', function() {
        const $this = $(this);
        const targetId = $this.attr('data-target');
        const willBeActive = !$this.hasClass('is-active');
        $this.toggleClass('is-active', willBeActive).attr('aria-expanded', willBeActive);
        $('#' + targetId).toggleClass('is-active', willBeActive);
    });

    // Bulma dropdown: enable click toggle for mobile-only settings dropdown
    $(document).on('click', '#settingsDropdownMobile > .navbar-link', function(e) {
        e.preventDefault();
        e.stopPropagation();
        const $parent = $(this).closest('.navbar-item.has-dropdown');
        $parent.toggleClass('is-active');
    });

    // Auto-collapse burger menu after clicking any navbar-item (mobile)
    $(document).on('click', '.navbar-item', function() {
        const desktopQuery = window.matchMedia('(min-width: 1024px)');
        if (desktopQuery.matches) return;
        const $burger = $('.navbar-burger');
        const targetId = $burger.attr('data-target');
        if (!$burger.hasClass('is-active')) return;
        $burger.removeClass('is-active').attr('aria-expanded', false);
        $('#' + targetId).removeClass('is-active');
    });

    // Simple accordion toggle (avoid mixing inline display with CSS class)
    // Initialize: clear any inline display so CSS controls initial visibility
    $('.accordion').each(function(){
        $(this).find('.accordion-body').css('display', '');
    });
    $(document).on('click', '.accordion .accordion-header', function(){
        const $acc = $(this).closest('.accordion');
        const $body = $acc.find('.accordion-body').first();
        // Stop current animations and jump to end, then sync class with actual visibility
        $body.stop(true, true);
        const isVisible = $body.is(':visible');
        $acc.toggleClass('is-open', isVisible);
        const willOpen = !isVisible;
        if (willOpen) {
            $body.slideDown(150, function(){
                $acc.addClass('is-open');
                $body.css('display', '');
            });
        } else {
            $body.slideUp(150, function(){
                $acc.removeClass('is-open');
                $body.css('display', '');
            });
        }
    });
});

document.addEventListener("DOMContentLoaded", () => {
    // 모든 모달 열기 버튼
    const openModalButtons = document.querySelectorAll(".modal-open");
    // 모든 모달 닫기 트리거 (.delete, .modal-background, .modal-close)
    const closeModalTriggers = document.querySelectorAll(".modal .delete, .modal .modal-background, .modal .modal-close");
  
    function openModal(modal) {
      modal.classList.add("is-active");
    }
  
    function closeModal(modal) {
      modal.classList.remove("is-active");
    }
  
    function closeAllModals() {
      document.querySelectorAll(".modal.is-active")
        .forEach(m => m.classList.remove("is-active"));
    }
  
    // 열기 버튼 클릭 → 해당 모달 열기
    openModalButtons.forEach(btn => {
      btn.addEventListener("click", () => {
        const target = btn.dataset.target;
        const modal = document.getElementById(target);
        if (modal) openModal(modal);
      });
    });
  
    // 닫기 트리거 클릭 → 모달 닫기
    closeModalTriggers.forEach(trigger => {
      trigger.addEventListener("click", () => {
        const modal = trigger.closest(".modal");
        closeModal(modal);
      });
    });
  
    // ESC 키 → 모든 모달 닫기
    document.addEventListener("keydown", event => {
      if (event.key === "Escape") {
        closeAllModals();
      }
    });
  });

// 전역 자원사용률 수집 상태 관리
window.ResourceUsageCollector = {
    ws: null,
    isCollecting: false,
    taskId: null,
    reconnectAttempts: 0,
    maxReconnectAttempts: 5,
    reconnectDelay: 3000,
    
    // 웹소켓 연결
    connect: function() {
        const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
        const wsUrl = `${protocol}//${window.location.host}/api/ws/resource-usage/status`;
        
        try {
            this.ws = new WebSocket(wsUrl);
            
            this.ws.onopen = () => {
                console.log('[ResourceUsageCollector] WebSocket connected');
                this.reconnectAttempts = 0;
                // 현재 상태 확인
                if (this.isCollecting && this.taskId) {
                    this.checkStatus();
                }
            };
            
            this.ws.onmessage = (event) => {
                try {
                    const message = JSON.parse(event.data);
                    this.handleMessage(message);
                } catch (e) {
                    console.error('[ResourceUsageCollector] Failed to parse message:', e);
                }
            };
            
            this.ws.onerror = (error) => {
                console.error('[ResourceUsageCollector] WebSocket error:', error);
            };
            
            this.ws.onclose = (event) => {
                console.log('[ResourceUsageCollector] WebSocket closed', event.code, event.reason);
                this.ws = null;
                // 페이지 언로드 중이 아닐 때만 재연결 시도
                // 1000: 정상 종료, 1001: 엔드포인트가 사라짐 (페이지 이동)
                if (event.code !== 1000 && event.code !== 1001) {
                    // 자동 재연결 (수집 중일 때만, 또는 항상 재연결 시도)
                    if (this.reconnectAttempts < this.maxReconnectAttempts) {
                        this.reconnectAttempts++;
                        setTimeout(() => {
                            // 페이지가 여전히 활성화되어 있고, 수집 중이거나 재연결 시도 중일 때만 재연결
                            if (document.visibilityState !== 'hidden' && (this.isCollecting || this.reconnectAttempts <= this.maxReconnectAttempts)) {
                                this.connect();
                            }
                        }, this.reconnectDelay);
                    } else {
                        // 최대 재연결 시도 횟수 초과 시 재설정
                        this.reconnectAttempts = 0;
                    }
                } else {
                    // 정상 종료인 경우 재연결 시도 횟수 리셋
                    this.reconnectAttempts = 0;
                }
            };
        } catch (e) {
            console.error('[ResourceUsageCollector] Failed to create WebSocket:', e);
        }
    },
    
    // 메시지 처리
    handleMessage: function(message) {
        if (message.type === 'collection_status') {
            if (message.status === 'collecting') {
                this.setCollecting(true);
                if (message.task_id) {
                    this.taskId = message.task_id;
                }
            } else if (message.status === 'completed') {
                // 마지막 수집 시간 저장 및 표시
                const now = new Date();
                try {
                    localStorage.setItem('ru_last_collected_at', now.toISOString());
                } catch (e) {
                    // ignore
                }
                this.updateNavbarIndicator();
                
                // 수집 완료 콜백 호출 (자원사용률 페이지가 로드되어 있으면 해당 콜백 호출)
                if (typeof this.onCollectionComplete === 'function') {
                    try {
                        this.onCollectionComplete(message.task_id, message.data);
                    } catch (e) {
                        console.error('[ResourceUsageCollector] Error in onCollectionComplete:', e);
                    }
                }
                
                // 자원사용률 페이지가 로드되어 있으면 해당 페이지의 콜백도 호출
                if (window.ResourceUsagePolling && typeof window.ResourceUsagePolling.onCollectionComplete === 'function') {
                    try {
                        window.ResourceUsagePolling.onCollectionComplete(message.task_id, message.data);
                    } catch (e) {
                        console.error('[ResourceUsageCollector] Error in ResourceUsagePolling.onCollectionComplete:', e);
                    }
                }
                
                // 완료 후에도 계속 실행 중이면 collecting 상태 유지
                if (this.isCollecting) {
                    // 다음 주기까지 대기 중이므로 collecting 상태 유지
                    return;
                }
            } else if (message.status === 'error') {
                console.error('[ResourceUsageCollector] Collection error:', message.data);
                // 에러가 나도 계속 실행 중이면 상태 유지
            } else if (message.status === 'stopped') {
                this.setCollecting(false);
                const stoppedTaskId = this.taskId;
                this.taskId = null;
                // resource_usage.js의 상태도 업데이트
                if (window.ru && window.ru.taskId === stoppedTaskId) {
                    window.ru.taskId = null;
                    window.ru.intervalId = null;
                    if (typeof window.setRunning === 'function') {
                        window.setRunning(false);
                    }
                }
            } else if (message.status === 'started') {
                this.setCollecting(true);
                this.taskId = message.task_id;
                // resource_usage.js의 상태도 업데이트
                if (window.ru) {
                    window.ru.taskId = message.task_id;
                    window.ru.intervalId = 'background';
                    if (typeof window.setRunning === 'function') {
                        window.setRunning(true);
                    }
                }
            }
        } else if (message.type === 'initial_status') {
            // 초기 상태 복원
            const status = message.data;
            if (status.tasks && Object.keys(status.tasks).length > 0) {
                const runningTasks = Object.values(status.tasks).filter(t => t.status === 'running');
                if (runningTasks.length > 0) {
                    this.setCollecting(true);
                    this.taskId = Object.keys(status.tasks)[0];
                    // resource_usage.js의 상태도 업데이트
                    if (window.ru) {
                        window.ru.taskId = this.taskId;
                        window.ru.intervalId = 'background';
                        if (typeof window.setRunning === 'function') {
                            window.setRunning(true);
                        }
                    }
                }
            }
        }
    },
    
    // 수집 완료 콜백 (외부에서 설정 가능)
    onCollectionComplete: null,
    
    // 수집 상태 설정
    setCollecting: function(isCollecting) {
        this.isCollecting = isCollecting;
        // localStorage에 저장 (전역 상태)
        try {
            localStorage.setItem('ru_collecting', isCollecting ? '1' : '0');
            if (this.taskId) {
                localStorage.setItem('ru_task_id', this.taskId);
            } else {
                localStorage.removeItem('ru_task_id');
            }
        } catch (e) {
            console.error('[ResourceUsageCollector] Failed to save state:', e);
        }
        this.updateNavbarIndicator();
    },
    
    // 네비바 인디케이터 업데이트
    updateNavbarIndicator: function() {
        const $indicator = $('#ruNavIndicator');
        if (this.isCollecting) {
            // 마지막 수집 시간 표시
            let lastCollectedText = '';
            try {
                const lastCollectedAt = localStorage.getItem('ru_last_collected_at');
                if (lastCollectedAt) {
                    const lastDate = new Date(lastCollectedAt);
                    const now = new Date();
                    const diffMs = now - lastDate;
                    const diffSec = Math.floor(diffMs / 1000);
                    const diffMin = Math.floor(diffSec / 60);
                    
                    if (diffSec < 60) {
                        lastCollectedText = ` (${diffSec}초 전)`;
                    } else if (diffMin < 60) {
                        lastCollectedText = ` (${diffMin}분 전)`;
                    } else {
                        const diffHour = Math.floor(diffMin / 60);
                        lastCollectedText = ` (${diffHour}시간 전)`;
                    }
                }
            } catch (e) {
                // ignore
            }
            
            const $text = $indicator.find('.ru-nav-text');
            if ($text.length > 0) {
                $text.text('수집 중...' + lastCollectedText);
            } else {
                $indicator.html(
                    '<span class="ru-nav-spinner"></span>' +
                    '<span class="ru-nav-text">수집 중...' + lastCollectedText + '</span>'
                );
            }
            $indicator.show();
        } else {
            $indicator.hide();
        }
    },
    
    // 상태 확인
    checkStatus: function() {
        if (!this.taskId) return;
        fetch(`/api/resource-usage/background/status?task_id=${this.taskId}`)
            .then(res => res.json())
            .then(data => {
                if (data.status === 'running') {
                    this.setCollecting(true);
                } else {
                    this.setCollecting(false);
                }
            })
            .catch(e => console.error('[ResourceUsageCollector] Failed to check status:', e));
    },
    
    // 초기화
    init: function() {
        // localStorage에서 상태 복원
        try {
            const saved = localStorage.getItem('ru_collecting');
            const savedTaskId = localStorage.getItem('ru_task_id');
            if (saved === '1' && savedTaskId) {
                this.isCollecting = true;
                this.taskId = savedTaskId;
            }
        } catch (e) {
            console.error('[ResourceUsageCollector] Failed to restore state:', e);
        }
        
        this.updateNavbarIndicator();
        this.connect();
        
        // 페이지 가시성 변경 시 웹소켓 재연결
        document.addEventListener('visibilitychange', () => {
            if (document.visibilityState === 'visible' && !this.ws && this.isCollecting) {
                // 페이지가 다시 보일 때 웹소켓이 없으면 재연결
                console.log('[ResourceUsageCollector] Page visible, reconnecting WebSocket...');
                this.reconnectAttempts = 0;
                this.connect();
            }
        });
        
        // 페이지 언로드 시 웹소켓 정리 (정상 종료 코드로 닫기)
        window.addEventListener('beforeunload', () => {
            if (this.ws) {
                this.ws.close(1000, 'Page unloading'); // 1000: 정상 종료
            }
        });
    }
};

// 네비바 인디케이터 업데이트 함수 (하위 호환성)
window.updateNavbarIndicator = function(isCollecting) {
    if (window.ResourceUsageCollector) {
        window.ResourceUsageCollector.setCollecting(isCollecting);
    }
};

// 페이지 로드 시 초기화
$(document).ready(function() {
    if (window.ResourceUsageCollector) {
        window.ResourceUsageCollector.init();
    }
});
