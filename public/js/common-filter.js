// public/js/common.js

// 모든 페이지에서 사용할 공통 필터 관리 객체
const filterStorage = {
    KEY: 'userFilters', // 공통으로 사용할 localStorage 키
    save(filters) {
        localStorage.setItem(this.KEY, JSON.stringify(filters));
    },
    load() {
        const f = localStorage.getItem(this.KEY);
        // 기본 필터 값 설정
        return f ? JSON.parse(f) : {
            period: '6m',
            types: ['남단', '여단', '남복', '여복', '혼복'],
            courts: [],
            player: null
        };
    }
};

// 체크박스 드롭다운의 텍스트를 업데이트하는 공통 함수
function updateCheckboxDropdownText(btnId, filterId, prefix) {
    const btn = document.getElementById(btnId);
    if (!btn) return;
    const count = document.querySelectorAll(`#${filterId} input:checked`).length;
    btn.textContent = count === 0 ? prefix : `${prefix}: ${count}개`;
}

// 체크박스 전체 선택/해제 공통 함수
function selectAll(id) { document.querySelectorAll(`#${id} input`).forEach(c => c.checked = true); }
function deselectAll(id) { document.querySelectorAll(`#${id} input`).forEach(c => c.checked = false); }

// 페이지 로드 시 공통으로 실행될 초기화 함수
function initializePage() {
    // 햄버거 메뉴 이벤트 리스너 설정
    const hamburger = document.querySelector('.hamburger-icon');
    const sideMenu = document.querySelector('.side-menu');
    const overlay = document.querySelector('.overlay');
    if (hamburger && sideMenu && overlay) {
        hamburger.addEventListener('click', () => {
            sideMenu.classList.toggle('active');
            overlay.classList.toggle('active');
        });
        overlay.addEventListener('click', () => {
            sideMenu.classList.remove('active');
            overlay.classList.remove('active');
        });
    }
}

// 페이지 로드 완료 시 공통 초기화 함수 실행
document.addEventListener('DOMContentLoaded', initializePage);