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

let currentState = 'IDLE'; // IDLE -> WAIT_CLOSE -> WAIT_OPEN -> DETECTING

let registeredCells = new Set();
let cellPersistence = {};
let pinSequence = [];
let lastPinTimestamp = null;
let isLocked = false;

const TOTAL_PINS = 6;
const PERSISTENCE_FRAMES = 2;
const MIN_PIN_INTERVAL_MS = 180; // 핀 감지 최소 간격 (중복 감지 방지)

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
        statusText.innerText = "❌ 화면 공유 실패";
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

// 🎯 이웃 칸 번짐 방지를 위해 각 셀의 중앙 55% 영역만 정확히 감시
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
                x: Math.round(colIdx * cellW + cellW * 0.225),
                y: Math.round(cfg.row * cellH + cellH * 0.225),
                w: Math.round(cellW * 0.55),
                h: Math.round(cellH * 0.55),
                cellW: cellW,
                cellH: cellH
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

    currentState = 'WAIT_CLOSE';
    resetStateData();
    statusText.innerText = "📸 기준 저장 완료! 🛑 모루 창을 한번 닫아주세요.";

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

        // 1단계: 모루 닫힘 대기
        if (currentState === 'WAIT_CLOSE') {
            ctx.strokeStyle = "#FF9800";
            ctx.lineWidth = 2;
            ctx.strokeRect(roi.x, roi.y, roi.w, roi.h);

            if (changeRatio > 0.45) {
                currentState = 'WAIT_OPEN';
                statusText.innerText = "🟢 대기 중... 모루 창을 다시 열어주세요.";
            }
        } 
        // 2단계: 빈 모루 재개봉 대기
        else if (currentState === 'WAIT_OPEN') {
            ctx.strokeStyle = "#2196F3";
            ctx.lineWidth = 2;
            ctx.strokeRect(roi.x, roi.y, roi.w, roi.h);

            if (changeRatio < 0.08) {
                currentState = 'DETECTING';
                resetStateData();
                statusText.innerText = "🎯 빈 모루 감지 완료! 핀 감시 중...";
            }
        } 
        // 3단계: 정밀 핀 인식
        else if (currentState === 'DETECTING') {
            ctx.strokeStyle = "#00E676";
            ctx.lineWidth = 2;
            ctx.strokeRect(roi.x, roi.y, roi.w, roi.h);

            if (changeRatio > 0.50) {
                currentState = 'WAIT_OPEN';
                statusText.innerText = "🟢 모루 닫힘 감지. 다음 제련 대기 중...";
            } else if (!isLocked) {
                const gridCells = getGridCells(roi.w, roi.h);
                const now = Date.now();

                // 시간차 쿨다운 확인
                const isCooldownReady = !lastPinTimestamp || (now - lastPinTimestamp >= MIN_PIN_INTERVAL_MS);

                let bestCandidate = null;
                let maxChanged = 0;

                gridCells.forEach((cell, idx) => {
                    if (registeredCells.has(idx) || pinSequence.length >= TOTAL_PINS) return;

                    let cellRect = new cv.Rect(cell.x, cell.y, cell.w, cell.h);
                    let cellROI = threshMat.roi(cellRect);
                    let changedPixels = cv.countNonZero(cellROI);

                    if (changedPixels > (cell.w * cell.h * 0.08)) {
                        cellPersistence[idx] = (cellPersistence[idx] || 0) + 1;

                        // 한 프레임에서 가장 변화량이 큰 단 하나의 칸만 후보로 선정
                        if (cellPersistence[idx] >= PERSISTENCE_FRAMES && changedPixels > maxChanged) {
                            // 무게중심(Centroid) 계산으로 핀 중심점 정밀 추적
                            let M = cv.moments(cellROI, true);
                            let centerX = (M.m00 > 0) ? Math.round(M.m10 / M.m00) : Math.round(cell.w / 2);
                            let centerY = (M.m00 > 0) ? Math.round(M.m01 / M.m00) : Math.round(cell.h / 2);

                            maxChanged = changedPixels;
                            bestCandidate = {
                                idx: idx,
                                x: roi.x + cell.x + centerX,
                                y: roi.y + cell.y + centerY
                            };
                        }
                    } else {
                        cellPersistence[idx] = 0;
                    }
                    cellROI.delete();
                });

                // 가장 유력한 1개 핀만 채택 및 등록
                if (bestCandidate && isCooldownReady) {
                    registeredCells.add(bestCandidate.idx);
                    pinSequence.push({
                        num: pinSequence.length + 1,
                        x: bestCandidate.x,
                        y: bestCandidate.y
                    });
                    lastPinTimestamp = now;
                    statusText.innerText = `📍 ${pinSequence.length}번 핀 감지!`;
                }

                if (pinSequence.length > 0 && lastPinTimestamp) {
                    if (pinSequence.length === TOTAL_PINS || (now - lastPinTimestamp >= 1200)) {
                        isLocked = true;
                        statusText.innerText = `🔒 ${pinSequence.length}개 핀 완벽 연결! (모루를 닫으면 자동 리셋)`;
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
