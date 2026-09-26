let isOpenCvReady = false;
let isStreaming = false;

const startBtn = document.getElementById('startBtn');
const resetBtn = document.getElementById('resetBtn');
const statusText = document.getElementById('status');
const video = document.getElementById('webcamVideo');
const canvas = document.getElementById('outputCanvas');
const ctx = canvas.getContext('2d');

// 🎯 상태 제어 변수
let baseGrayMat = null;              // 깨끗한 모루 베이스 이미지
let isBaseCaptured = false;          // 베이스 저장 여부
let registeredCells = new Set();     // 이미 감지 완료된 칸 인덱스
let cellPersistence = {};            // 칸별 연속 감지 프레임 수 카운터 (마우스 걸러내기용)
let pinSequence = [];                // 최종 감지된 순차 핀 정보 [{num, x, y}]
let lastPinTimestamp = null;         // 마지막 핀 감지 시각
let isLocked = false;                // 잠금 상태 여부

const TOTAL_PINS = 6;
const PERSISTENCE_FRAMES = 3;        // ⚡ 핵심: 3프레임(약 0.05초) 이상 유지되어야 진짜 핀으로 인정

function onOpenCvReady() {
    isOpenCvReady = true;
    statusText.innerText = "🟢 엔진 준비 완료! [화면 공유 시작]을 누르세요.";
    startBtn.disabled = false;
    startBtn.innerText = "🖥️ 화면 공유 시작";
}

startBtn.addEventListener('click', async () => {
    try {
        const stream = await navigator.mediaDevices.getDisplayMedia({
            video: { frameRate: { ideal: 60, max: 60 } },
            audio: false
        });

        video.srcObject = stream;
        video.play();
        isStreaming = true;

        startBtn.style.display = 'none';
        statusText.innerText = "🟢 실시간 감지 대기 중... 마인크래프트 제련창을 열어주세요.";

        video.addEventListener('loadedmetadata', () => {
            canvas.width = video.videoWidth;
            canvas.height = video.videoHeight;
            requestAnimationFrame(processFrame);
        });

    } catch (err) {
        statusText.innerText = "❌ 화면 공유가 취소되었거나 오류가 발생했습니다.";
    }
});

// 🎯 28개 모루 격자 칸(6-8-8-6) 좌표 동적 생성 함수
function getGridCells(roiW, roiH) {
    const cells = [];
    const rowConfig = [
        { row: 0, cols: 6, offset: 1 }, // 상단 1열 (중앙 6칸)
        { row: 1, cols: 8, offset: 0 }, // 중단 2열 (8칸)
        { row: 2, cols: 8, offset: 0 }, // 중단 3열 (8칸)
        { row: 3, cols: 6, offset: 1 }  // 하단 4열 (중앙 6칸)
    ];

    const cellW = roiW / 8;
    const cellH = roiH / 4;

    rowConfig.forEach(cfg => {
        for (let c = 0; c < cfg.cols; c++) {
            const colIdx = cfg.offset + c;
            cells.push({
                // 슬롯 내부 중앙 60% 구역만 오차 없이 감시
                x: Math.round(colIdx * cellW + cellW * 0.20),
                y: Math.round(cfg.row * cellH + cellH * 0.20),
                w: Math.round(cellW * 0.60),
                h: Math.round(cellH * 0.60),
                cx: Math.round((colIdx + 0.5) * cellW),
                cy: Math.round((cfg.row + 0.5) * cellH)
            });
        }
    });
    return cells;
}

function processFrame() {
    if (!isStreaming) return;

    ctx.drawImage(video, 0, 0, canvas.width, canvas.height);

    if (isLocked) {
        drawDetections(pinSequence);
        requestAnimationFrame(processFrame);
        return;
    }

    let src = cv.imread(canvas);
    let srcGray = new cv.Mat();
    cv.cvtColor(src, srcGray, cv.COLOR_RGBA2GRAY);

    // 모루 중앙 구역 지정 (가로 60%, 세로 55%)
    const cropW = Math.round(srcGray.cols * 0.60);
    const cropH = Math.round(srcGray.rows * 0.55);
    const cropX = Math.round((srcGray.cols - cropW) / 2);
    const cropY = Math.round((srcGray.rows - cropH) / 2);

    let rect = new cv.Rect(cropX, cropY, cropW, cropH);
    let roiGray = srcGray.roi(rect);

    // 1단계: 제련창 회색 모루 배경 진입 여부 검사
    let meanVal = cv.mean(roiGray)[0];
    const isAnvilActive = (meanVal >= 40 && meanVal <= 160); // 모루 특유 회색조 범위

    if (!isAnvilActive) {
        // 제련창을 닫으면 베이스 초기화
        if (isBaseCaptured) resetState();
    } else {
        // 2단계: 제련창 최초 열림 시 베이스 이미지 자동 저장
        if (!isBaseCaptured) {
            baseGrayMat = roiGray.clone();
            isBaseCaptured = true;
            statusText.innerText = "📸 깨끗한 모루 베이스 캡처 완료! 핀 감시 중...";
        } else {
            // 3단계: 차분(Diff) 계산으로 변해버린 픽셀 추출
            let diffMat = new cv.Mat();
            let threshMat = new cv.Mat();

            cv.absdiff(roiGray, baseGrayMat, diffMat);
            cv.threshold(diffMat, threshMat, 35, 255, cv.THRESH_BINARY);

            const gridCells = getGridCells(cropW, cropH);

            gridCells.forEach((cell, idx) => {
                if (registeredCells.has(idx) || pinSequence.length >= TOTAL_PINS) return;

                let cellRect = new cv.Rect(cell.x, cell.y, cell.w, cell.h);
                let cellROI = threshMat.roi(cellRect);
                let changedPixels = cv.countNonZero(cellROI);
                cellROI.delete();

                // 칸 내 일정 면적 이상 픽셀 변화 감지
                if (changedPixels > (cell.w * cell.h * 0.15)) {
                    cellPersistence[idx] = (cellPersistence[idx] || 0) + 1;

                    // ⚡ [핵심 필터] 3프레임 연속 유지 시에만 스쳐가는 마우스가 아닌 '진짜 핀'으로 채택!
                    if (cellPersistence[idx] >= PERSISTENCE_FRAMES) {
                        registeredCells.add(idx);
                        pinSequence.push({
                            num: pinSequence.length + 1,
                            x: cropX + cell.cx,
                            y: cropY + cell.cy
                        });
                        lastPinTimestamp = Date.now();
                        statusText.innerText = `📍 ${pinSequence.length}번 핀 감지!`;
                    }
                } else {
                    // 마우스처럼 스쳐 지나가면 연속 프레임 즉시 리셋!
                    cellPersistence[idx] = 0;
                }
            });

            diffMat.delete();
            threshMat.delete();
        }
    }

    // ⏱️ 핀 감지 후 1.5초간 변화가 없거나 6개 모두 찾으면 고정
    if (pinSequence.length > 0 && lastPinTimestamp) {
        if (pinSequence.length === TOTAL_PINS || (Date.now() - lastPinTimestamp >= 1500)) {
            isLocked = true;
            statusText.innerText = `🔒 연결 완료 (${pinSequence.length}개 감지). 제련 후 초기화(Space/R)를 누르세요.`;
        }
    }

    drawDetections(pinSequence);

    roiGray.delete();
    src.delete();
    srcGray.delete();

    requestAnimationFrame(processFrame);
}

// 🎨 원형 번호 배지 + 연결선 그려주기
function drawDetections(pins) {
    if (pins.length === 0) return;

    pins.sort((a, b) => a.num - b.num);

    // 1. 순서 연결 선
    if (pins.length > 1) {
        ctx.beginPath();
        ctx.moveTo(pins[0].x, pins[0].y);
        for (let i = 1; i < pins.length; i++) {
            ctx.lineTo(pins[i].x, pins[i].y);
        }
        ctx.strokeStyle = "#00FF66";
        ctx.lineWidth = 5;
        ctx.lineJoin = "round";
        ctx.stroke();
    }

    // 2. 번호 동그라미 배지
    pins.forEach((pin) => {
        const radius = 16;

        ctx.beginPath();
        ctx.arc(pin.x, pin.y, radius, 0, Math.PI * 2);
        ctx.fillStyle = "#00E676";
        ctx.fill();
        ctx.lineWidth = 3;
        ctx.strokeStyle = "#000000";
        ctx.stroke();

        ctx.fillStyle = "#000000";
        ctx.font = "bold 18px sans-serif";
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        ctx.fillText(pin.num, pin.x, pin.y);
    });
}

function resetState() {
    if (baseGrayMat) {
        baseGrayMat.delete();
        baseGrayMat = null;
    }
    isBaseCaptured = false;
    registeredCells.clear();
    cellPersistence = {};
    pinSequence = [];
    lastPinTimestamp = null;
    isLocked = false;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    if (isStreaming) {
        statusText.innerText = "🟢 실시간 감지 대기 중... 마인크래프트 제련창을 열어주세요.";
    }
}

resetBtn.addEventListener('click', resetState);
window.addEventListener('keydown', (e) => {
    if (e.code === 'Space' || e.key === 'r' || e.key === 'R') {
        resetState();
    }
});
