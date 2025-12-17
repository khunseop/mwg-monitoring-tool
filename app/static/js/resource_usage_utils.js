/**
 * Resource Usage 유틸리티 함수 모듈
 * 데이터 포맷팅 및 계산 관련 유틸리티 함수들
 */
(function(window) {
    'use strict';

    const ResourceUsageUtils = {
        /**
         * 바이트를 읽기 쉬운 형식으로 변환
         * @param {number} bytes - 바이트 수
         * @param {number} decimals - 소수점 자릿수 (기본값: 2)
         * @param {boolean} perSecond - 초당 단위 표시 여부
         * @returns {string} 포맷된 문자열
         */
        formatBytes(bytes, decimals = 2, perSecond = false) {
            // Handle invalid, null, or undefined inputs
            if (bytes === null || bytes === undefined || isNaN(bytes)) return '';
            // Treat negative values as 0, as negative traffic is not meaningful
            if (bytes < 0) bytes = 0;

            if (bytes === 0) {
                let str = '0 Bytes';
                if (perSecond) str += '/s';
                return str;
            }

            const k = 1024;
            const dm = decimals < 0 ? 0 : decimals;
            const sizes = ['Bytes', 'KB', 'MB', 'GB', 'TB', 'PB', 'EB', 'ZB', 'YB'];

            // Calculate the power of 1024 and clamp it to the available sizes
            let i = Math.floor(Math.log(bytes) / Math.log(k));
            if (i < 0) {
                // This handles cases where 0 < bytes < 1
                i = 0;
            }
            if (i >= sizes.length) {
                // Cap at the largest unit (YB) for extremely large numbers
                i = sizes.length - 1;
            }

            let str = parseFloat((bytes / Math.pow(k, i)).toFixed(dm)) + ' ' + sizes[i];
            if (perSecond) str += '/s';
            return str;
        },

        /**
         * 숫자에 천 단위 구분자 추가
         * @param {number} num - 숫자
         * @returns {string} 포맷된 문자열
         */
        formatNumber(num) {
            if (num === null || num === undefined) return '';
            return num.toString().replace(/(\d)(?=(\d{3})+(?!\d))/g, '$1,');
        },

        /**
         * 숫자를 축약 형식으로 변환 (예: 1000 -> 1k, 1000000 -> 1M)
         * @param {number} value - 숫자
         * @returns {string} 축약된 문자열
         */
        abbreviateNumber(value) {
            if (value == null || typeof value !== 'number') return '0';
            if (value < 1000) return value.toString();
            const suffixes = ["", "k", "M", "B", "T"];
            const i = Math.floor(Math.log10(value) / 3);
            let num = (value / Math.pow(1000, i));
            if (num === Math.floor(num)) { return num.toFixed(0) + suffixes[i]; }
            return num.toFixed(1) + suffixes[i];
        },

        /**
         * 32-bit 카운터 래핑을 고려한 델타 계산
         * @param {number} current - 현재 값
         * @param {number} previous - 이전 값
         * @returns {number|null} 델타 값
         */
        calculateDeltaWithWrap(current, previous) {
            const COUNTER32_MAX = 4294967295; // 2^32 - 1
            if (typeof current !== 'number' || typeof previous !== 'number') return null;
            if (current < previous) {
                // Counter wrapped: (MAX + 1 - previous) + current
                return (COUNTER32_MAX + 1 - previous) + current;
            }
            return current - previous;
        },

        /**
         * 프록시 트래픽 델타를 Mbps로 변환
         * @param {number} current - 현재 누적 바이트
         * @param {number} previous - 이전 누적 바이트
         * @param {number} intervalSec - 시간 간격 (초)
         * @returns {number|null} Mbps 값
         */
        calculateTrafficMbps(current, previous, intervalSec) {
            const deltaBytes = this.calculateDeltaWithWrap(current, previous);
            if (deltaBytes === null || deltaBytes < 0 || intervalSec <= 0) return null;
            // Convert bytes to Mbps: (delta_bytes * 8 bits/byte) / (intervalSec * 1,000,000 bits/Mbit)
            return (deltaBytes * 8.0) / (intervalSec * 1_000_000.0);
        },

        /**
         * 긴 인터페이스 이름을 축약
         * @param {string} name - 인터페이스 이름
         * @returns {string} 축약된 이름
         */
        abbreviateInterfaceName(name) {
            if (!name) return name;
            // Common abbreviations
            const abbrevs = {
                'GigabitEthernet': 'Gi',
                'FastEthernet': 'Fa',
                'TenGigabitEthernet': 'Te',
                'Ethernet': 'Eth'
            };
            let abbrev = name;
            for (const [full, short] of Object.entries(abbrevs)) {
                if (name.startsWith(full)) {
                    abbrev = name.replace(full, short);
                    break;
                }
            }
            // Limit length for display (keep first 15 chars)
            if (abbrev.length > 15) {
                abbrev = abbrev.substring(0, 12) + '...';
            }
            return abbrev;
        },

        /**
         * 긴 호스트명을 잘라서 표시
         * @param {string} hostname - 호스트명
         * @param {number} maxLength - 최대 길이 (기본값: 20)
         * @returns {string} 잘린 호스트명
         */
        truncateHostname(hostname, maxLength = 20) {
            if (!hostname || hostname.length <= maxLength) return hostname;
            return hostname.substring(0, maxLength - 3) + '...';
        }
    };

    // 전역으로 노출
    window.ResourceUsageUtils = ResourceUsageUtils;
})(window);
