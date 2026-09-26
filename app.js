let isOpenCvReady = false;
let isStreaming = false;

const startBtn = document.getElementById('startBtn');
const resetBtn = document.getElementById('resetBtn');
const statusText = document.getElementById('status');
const video = document.getElementById('webcamVideo');
const canvas = document.getElementById('outputCanvas');
const ctx = canvas.getContext('2d');

let baseGrayMat = null;
let isBaseCaptured = false;
let registeredCells = new Set();
let cellPersistence = {};
let pinSequence = [];
let lastPinTimestamp = null;
let isLocked = false;
let anvilStableFrames = 0; // 모루 화면 안정을 위한 카운터

const TOTAL_PINS = 6;
const PERSISTENCE_FRAMES = 2; // ⚡ 2프레임(약 0.03초) 이상 지속 시 즉시 핀 채택

function onOpenCvReady() {
    isOpenCvReady = true;
    statusText.innerText = "🟢 엔진 준비 완료! [화면 공유 시작]을 누르세요.";
    startBtn.disabled = false;
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
        statusText.innerText = "🟢 대기 중... 마인크래프트 제련창을 열어주세요.";

        video.addEventListener('loadedmetadata', () => {
            canvas.width = video.videoWidth;
            canvas.height = video.videoHeight;
            requestAnimationFrame(processFrame);
        });

    } catch (err) {
        statusText.innerText = "❌ 화면 공유가 취소되었거나 오류가 발생했습니다.";
    }
});

// ⚡ 1. 화면 중앙 무채색(회색) 단층 실시간 검사 (오인식 0% 방어막)
function isAnvilCenterPresent(srcMat) {
    const centerX = Math.round(srcMat.cols / 2);
    const centerY = Math.round(srcMat.rows / 2);

    let rect = new cv.Rect(centerX - 10, centerY - 10, 20, 20);
    let roi = srcMat.roi(rect);
    let mean = cv.mean(roi);
    roi.delete();

    const r = mean[0];
    const g = mean[1];
    const b = mean[2];
    const avg = (r + g + b) / 3;

    // R, G, B 차이가 적은 순수 회색이며 모루 돌판 명도 범주에 들어오는지 판단
    const isGray = (Math.abs(r - g) < 10) && (Math.abs(g - b) < 10) && (Math.abs(r - b) < 10);
    const isAnvilBrightness = (avg >= 60 && avg <= 140);

    return isGray && isAnvilBrightness;
}

// ⚡ 2. 28개 격자 칸 좌표 산출 (75% 범위로 영역 넓혀 인식률 극대화)
function getGridCells(roiW, roiH) {
    const cells = [];
    const rowConfig = [
        { row: 0, cols: 6, offset: 1 },
        { row: 1, cols: 8, offset: 0 },
        { row: 2, cols: 8, offset: 0 },
        { row: 3, cols: 6, offset: 1 }
    ];

    const cellW = roiW / 8;
    const cellH = roiH / 4;

    rowConfig.forEach(cfg => {
        for (let c = 0; c < cfg.cols; c++) {
            const colIdx = cfg.offset + c;
            cells.push({
                x: Math.round(colIdx * cellW + cellW * 0.125),
                y: Math.round(cfg.row * cellH + cellH * 0.125),
                w: Math.round(cellW * 0.75),
                h: Math.round(cellH * 0.75),
                cx: Math.round((colIdx + 0.5) * cellW),
                cy: Math.round((cfg.row + 0.5) * cellH)
            });
        }
    });
    return cells;
}

// ⚡ 3. 메인 프레임 처리 연산
function processFrame() {
    if (!isStreaming) return;

    ctx.drawImage(video, 0, 0, canvas.width, canvas.height);

    let src = cv.imread(canvas);

    // 중앙 회색 검사로 모루 창 개방 여부 감지
    const isAnvilOpen = isAnvilCenterPresent(src);

    if (!isAnvilOpen) {
        // 모루 창을 닫으면 자동 상태 초기화
        anvilStableFrames = 0;
        if (isBaseCaptured) resetState();
    } else {
        anvilStableFrames++;

        let srcGray = new cv.Mat();
        cv.cvtColor(src, srcGray, cv.COLOR_RGBA2GRAY);

        // 모루 중앙 격자 구역 매핑
        const cropW = Math.round(srcGray.cols * 0.50);
        const cropH = Math.round(srcGray.rows * 0.38);
        const cropX = Math.round((srcGray.cols - cropW) / 2);
        const cropY = Math.round((srcGray.rows - cropH) / 2 - srcGray.rows * 0.03);

        let rect = new cv.Rect(cropX, cropY, cropW, cropH);
        let roiGray = srcGray.roi(rect);

        // 모루 열림 후 6프레임(약 0.1초) 뒤 베이스 자동 포착
        if (!isBaseCaptured && anvilStableFrames >= 6) {
            baseGrayMat = roiGray.clone();
            isBaseCaptured = true;
            statusText.innerText = "📸 깨끗한 모루 베이스 저장 완료! 핀 감시 중...";
        } 
        // 핀 실시간 추적 진행
        else if (isBaseCaptured && !isLocked) {
            let diffMat = new cv.Mat();
            let threshMat = new cv.Mat();

            cv.absdiff(roiGray, baseGrayMat, diffMat);
            // ⚡ 임계값 22로 대폭 완화하여 미세한 핀 변화도 확실하게 포착
            cv.threshold(diffMat, threshMat, 22, 255, cv.THRESH_BINARY);

            const gridCells = getGridCells(cropW, cropH);

            gridCells.forEach((cell, idx) => {
                if (registeredCells.has(idx) || pinSequence.length >= TOTAL_PINS) return;

                let cellRect = new cv.Rect(cell.x, cell.y, cell.w, cell.h);
                let cellROI = threshMat.roi(cellRect);
                let changedPixels = cv.countNonZero(cellROI);
                cellROI.delete();

                // ⚡ 필요 면적 비율 7%로 민감도 대폭 상승
                if (changedPixels > (cell.w * cell.h * 0.07)) {
                    cellPersistence[idx] = (cellPersistence[idx] || 0) + 1;

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
                    cellPersistence[idx] = 0;
                }
            });

            diffMat.delete();
            threshMat.delete();

            // 1.2초간 핀 추가가 없거나 6개 모두 탐지 시 선 연결 고정
            if (pinSequence.length > 0 && lastPinTimestamp) {
                if (pinSequence.length === TOTAL_PINS || (Date.now() - lastPinTimestamp >= 2500)) {
                    isLocked = true;
                    statusText.innerText = `🔒 ${pinSequence.length}개 핀 연결 완료! (모루를 닫으면 자동 리셋)`;
                }
            }
        }

        roiGray.delete();
        srcGray.delete();
    }

    drawDetections(pinSequence);
    src.delete();

    requestAnimationFrame(processFrame);
}

// 🎨 4. 번호 배지 및 연결 선 시각화
function drawDetections(pins) {
    if (pins.length === 0) return;

    pins.sort((a, b) => a.num - b.num);

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

    pins.forEach((pin) => {
        ctx.beginPath();
        ctx.arc(pin.x, pin.y, 16, 0, Math.PI * 2);
        ctx.fillStyle = "#00E676";
        ctx.fill();
        ctx.lineWidth = 2;
        ctx.strokeStyle = "#000000";
        ctx.stroke();

        ctx.fillStyle = "#000000";
        ctx.font = "bold 18px sans-serif";
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        ctx.fillText(pin.num, pin.x, pin.y);
    });
}

// 🔄 5. 상태 리셋 함수
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
    anvilStableFrames = 0;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    if (isStreaming) {
        statusText.innerText = "🟢 대기 중... 마인크래프트 제련창을 열어주세요.";
    }
}

resetBtn.addEventListener('click', resetState);
window.addEventListener('keydown', (e) => {
    if (e.key === 'r' || e.key === 'R') {
        resetState();
    }
});
