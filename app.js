let isOpenCvReady = false;
let isStreaming = false;

const startBtn = document.getElementById('startBtn');
const resetBtn = document.getElementById('resetBtn');
const statusText = document.getElementById('status');
const video = document.getElementById('webcamVideo');
const canvas = document.getElementById('outputCanvas');
const ctx = canvas.getContext('2d');

let roi = null;
let isDragging = false;
let startX = 0, startY = 0;
let currentX = 0, currentY = 0;

let baseGrayMat = null;
let isBaseCaptured = false;

// 🔄 상태 제어: 'IDLE' -> 'WAIT_CLOSE' -> 'WAIT_OPEN' -> 'DETECTING'
let currentState = 'IDLE'; 

let registeredCells = new Set();
let cellPersistence = {};
let pinSequence = [];
let lastPinTimestamp = null;
let isLocked = false;

const TOTAL_PINS = 6;
const PERSISTENCE_FRAMES = 2;

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
        statusText.innerText = "🖱️ [드래그] 빈 모루 28개 칸 전체를 네모 상자로 감싸주세요!";

        video.addEventListener('loadedmetadata', () => {
            canvas.width = video.videoWidth;
            canvas.height = video.videoHeight;
            requestAnimationFrame(processFrame);
        });

    } catch (err) {
        statusText.innerText = "❌ 화면 공유가 취소되었거나 오류가 발생했습니다.";
    }
});

canvas.addEventListener('mousedown', (e) => {
    if (!isStreaming) return;
    const rect = canvas.getBoundingClientRect();
    const scaleX = canvas.width / rect.width;
    const scaleY = canvas.height / rect.height;

    startX = (e.clientX - rect.left) * scaleX;
    startY = (e.clientY - rect.top) * scaleY;
    isDragging = true;
    roi = null;
    isBaseCaptured = false;
    currentState = 'IDLE';
    resetStateData();
});

canvas.addEventListener('mousemove', (e) => {
    if (!isDragging) return;
    const rect = canvas.getBoundingClientRect();
    const scaleX = canvas.width / rect.width;
    const scaleY = canvas.height / rect.height;

    currentX = (e.clientX - rect.left) * scaleX;
    currentY = (e.clientY - rect.top) * scaleY;

    roi = {
        x: Math.round(Math.min(startX, currentX)),
        y: Math.round(Math.min(startY, currentY)),
        w: Math.round(Math.abs(currentX - startX)),
        h: Math.round(Math.abs(currentY - startY))
    };
});

canvas.addEventListener('mouseup', () => {
    if (isDragging) {
        isDragging = false;
        if (roi && roi.w > 40 && roi.h > 40) {
            captureBase();
        } else {
            roi = null;
            statusText.innerText = "⚠️ 드래그 영역이 너무 작습니다.";
        }
    }
});

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
                x: Math.round(colIdx * cellW + cellW * 0.10),
                y: Math.round(cfg.row * cellH + cellH * 0.10),
                w: Math.round(cellW * 0.80),
                h: Math.round(cellH * 0.80),
                cx: Math.round((colIdx + 0.5) * cellW),
                cy: Math.round((cfg.row + 0.5) * cellH)
            });
        }
    });
    return cells;
}

function captureBase() {
    if (!roi) return;

    let src = cv.imread(canvas);
    let srcGray = new cv.Mat();
    cv.cvtColor(src, srcGray, cv.COLOR_RGBA2GRAY);

    let rect = new cv.Rect(roi.x, roi.y, roi.w, roi.h);
    let roiGray = srcGray.roi(rect);

    if (baseGrayMat) baseGrayMat.delete();
    baseGrayMat = roiGray.clone();
    isBaseCaptured = true;

    // 🎯 영역 지정 직후 모루가 '닫힐 때까지' 대기하는 상태로 변경
    currentState = 'WAIT_CLOSE';
    resetStateData();
    statusText.innerText = "📸 기준 이미지 저장 완료! 🛑 모루 창을 한번 닫아주세요.";

    roiGray.delete();
    srcGray.delete();
    src.delete();
}

function processFrame() {
    if (!isStreaming) return;

    ctx.drawImage(video, 0, 0, canvas.width, canvas.height);

    if (isDragging && roi) {
        ctx.strokeStyle = "#FF3366";
        ctx.lineWidth = 3;
        ctx.setLineDash([6, 6]);
        ctx.strokeRect(roi.x, roi.y, roi.w, roi.h);
        ctx.setLineDash([]);
    }

    if (roi && isBaseCaptured) {
        let src = cv.imread(canvas);
        let srcGray = new cv.Mat();
        cv.cvtColor(src, srcGray, cv.COLOR_RGBA2GRAY);

        let rect = new cv.Rect(roi.x, roi.y, roi.w, roi.h);
        let roiGray = srcGray.roi(rect);

        let diffMat = new cv.Mat();
        let threshMat = new cv.Mat();

        cv.absdiff(roiGray, baseGrayMat, diffMat);
        cv.threshold(diffMat, threshMat, 25, 255, cv.THRESH_BINARY);

        let totalChangedPixels = cv.countNonZero(threshMat);
        let changeRatio = totalChangedPixels / (roi.w * roi.h);

        // 🔄 1단계: 드래그 후 모루 창이 닫혀서 이미지가 사라질 때까지 대기
        if (currentState === 'WAIT_CLOSE') {
            ctx.strokeStyle = "#FF9800"; // 주황색 가이드라인
            ctx.lineWidth = 2;
            ctx.strokeRect(roi.x, roi.y, roi.w, roi.h);

            if (changeRatio > 0.45) { // 화면이 45% 이상 달라지면 모루 닫힘으로 판별
                currentState = 'WAIT_OPEN';
                statusText.innerText = "🟢 대기 중... 모루 창을 다시 열면 자동으로 핀 감시가 시작됩니다.";
            }
        } 
        // 🔄 2단계: 모루 창이 다시 열려 기억해둔 '빈 모루'가 완전히 찍힐 때까지 대기
        else if (currentState === 'WAIT_OPEN') {
            ctx.strokeStyle = "#2196F3"; // 파란색 가이드라인
            ctx.lineWidth = 2;
            ctx.strokeRect(roi.x, roi.y, roi.w, roi.h);

            if (changeRatio < 0.08) { // 차이율 8% 미만 (빈 모루 재등장)
                currentState = 'DETECTING';
                resetStateData();
                statusText.innerText = "🎯 빈 모루 감지 완료! 핀 인식 작동 시작...";
            }
        } 
        // 🔄 3단계: 핀 인식 및 기록 수행
        else if (currentState === 'DETECTING') {
            ctx.strokeStyle = "#00E676"; // 초록색 가이드라인
            ctx.lineWidth = 2;
            ctx.strokeRect(roi.x, roi.y, roi.w, roi.h);

            // 제련 진행 중 모루 창이 닫히면 다시 재열림 대기 상태로 전환
            if (changeRatio > 0.50) {
                currentState = 'WAIT_OPEN';
                statusText.innerText = "🟢 모루 닫힘 감지. 다음 제련 대기 중...";
            } else if (!isLocked) {
                const gridCells = getGridCells(roi.w, roi.h);

                gridCells.forEach((cell, idx) => {
                    if (registeredCells.has(idx) || pinSequence.length >= TOTAL_PINS) return;

                    let cellRect = new cv.Rect(cell.x, cell.y, cell.w, cell.h);
                    let cellROI = threshMat.roi(cellRect);
                    let changedPixels = cv.countNonZero(cellROI);
                    cellROI.delete();

                    if (changedPixels > (cell.w * cell.h * 0.06)) {
                        cellPersistence[idx] = (cellPersistence[idx] || 0) + 1;

                        if (cellPersistence[idx] >= PERSISTENCE_FRAMES) {
                            registeredCells.add(idx);
                            pinSequence.push({
                                num: pinSequence.length + 1,
                                x: roi.x + cell.cx,
                                y: roi.y + cell.cy
                            });
                            lastPinTimestamp = Date.now();
                            statusText.innerText = `📍 ${pinSequence.length}번 핀 감지!`;
                        }
                    } else {
                        cellPersistence[idx] = 0;
                    }
                });

                if (pinSequence.length > 0 && lastPinTimestamp) {
                    if (pinSequence.length === TOTAL_PINS || (Date.now() - lastPinTimestamp >= 1200)) {
                        isLocked = true;
                        statusText.innerText = `🔒 ${pinSequence.length}개 핀 순서 완성! (모루를 닫으면 초기화)`;
                    }
                }
            }
        }

        diffMat.delete();
        threshMat.delete();
        roiGray.delete();
        srcGray.delete();
        src.delete();
    }

    drawDetections(pinSequence);
    requestAnimationFrame(processFrame);
}

function drawDetections(pins) {
    if (pins.length === 0 || currentState !== 'DETECTING') return;

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

function resetStateData() {
    registeredCells.clear();
    cellPersistence = {};
    pinSequence = [];
    lastPinTimestamp = null;
    isLocked = false;
}

function fullReset() {
    if (baseGrayMat) {
        baseGrayMat.delete();
        baseGrayMat = null;
    }
    roi = null;
    isBaseCaptured = false;
    currentState = 'IDLE';
    resetStateData();
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    statusText.innerText = "🖱️ [드래그] 빈 모루 28개 칸 전체를 네모 상자로 감싸주세요!";
}

resetBtn.addEventListener('click', fullReset);
