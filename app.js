let isOpenCvReady = false;
let isStreaming = false;

const startBtn = document.getElementById('startBtn');
const resetBtn = document.getElementById('resetBtn');
const statusText = document.getElementById('status');
const video = document.getElementById('webcamVideo');
const canvas = document.getElementById('outputCanvas');
const ctx = canvas.getContext('2d');

// 🎯 영역 지정 및 캡처 관련 변수
let roi = null;              // 유저가 드래그로 지정한 영역 { x, y, w, h }
let isDragging = false;
let startX = 0, startY = 0;
let currentX = 0, currentY = 0;

let baseGrayMat = null;
let isBaseCaptured = false;
let registeredCells = new Set();
let cellPersistence = {};
let pinSequence = [];
let lastPinTimestamp = null;
let isLocked = false;

const TOTAL_PINS = 6;
const PERSISTENCE_FRAMES = 2; // 2프레임 유지 시 즉시 감지

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
        statusText.innerText = "🖱️ [마우스 드래그] 모루 28개 칸 전체를 드래그해서 네모 상자로 감싸주세요!";

        video.addEventListener('loadedmetadata', () => {
            canvas.width = video.videoWidth;
            canvas.height = video.videoHeight;
            requestAnimationFrame(processFrame);
        });

    } catch (err) {
        statusText.innerText = "❌ 화면 공유가 취소되었거나 오류가 발생했습니다.";
    }
});

// 🖱️ 캔버스 마우스 드래그 이벤트 (캔버스 배율 오차 정밀 보정 포함)
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
            captureBase(); // 영역 지정 직후 해당 위치를 '깨끗한 모루 베이스'로 저장
        } else {
            roi = null;
            statusText.innerText = "⚠️ 영역이 너무 작습니다. 모루 격자를 크게 드래그해 주세요.";
        }
    }
});

// 🎯 지정된 ROI 상자 내부에 28개 모루 칸 격자 동적 생성 (6-8-8-6)
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

// 📸 지정된 영역 기반 깨끗한 모루 이미지 캡처
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

    resetStateData();
    statusText.innerText = "📸 기준 모루 저장 완료! 핀이 나오는 순서를 감지합니다.";

    roiGray.delete();
    srcGray.delete();
    src.delete();
}

function processFrame() {
    if (!isStreaming) return;

    ctx.drawImage(video, 0, 0, canvas.width, canvas.height);

    // 1. 드래그 중인 가이드 박스 그리기
    if (isDragging && roi) {
        ctx.strokeStyle = "#FF3366";
        ctx.lineWidth = 3;
        ctx.setLineDash([6, 6]);
        ctx.strokeRect(roi.x, roi.y, roi.w, roi.h);
        ctx.setLineDash([]);
    }

    // 2. 영역 설정 완료 후 감지 로직 동작
    if (roi && isBaseCaptured) {
        // 유저 지정 영역 가이드 박스 표시
        ctx.strokeStyle = "#00E676";
        ctx.lineWidth = 2;
        ctx.strokeRect(roi.x, roi.y, roi.w, roi.h);

        let src = cv.imread(canvas);
        let srcGray = new cv.Mat();
        cv.cvtColor(src, srcGray, cv.COLOR_RGBA2GRAY);

        let rect = new cv.Rect(roi.x, roi.y, roi.w, roi.h);
        let roiGray = srcGray.roi(rect);

        if (!isLocked) {
            let diffMat = new cv.Mat();
            let threshMat = new cv.Mat();

            cv.absdiff(roiGray, baseGrayMat, diffMat);
            cv.threshold(diffMat, threshMat, 20, 255, cv.THRESH_BINARY); // 미세 핀 민감도 유지

            const gridCells = getGridCells(roi.w, roi.h);

            gridCells.forEach((cell, idx) => {
                if (registeredCells.has(idx) || pinSequence.length >= TOTAL_PINS) return;

                let cellRect = new cv.Rect(cell.x, cell.y, cell.w, cell.h);
                let cellROI = threshMat.roi(cellRect);
                let changedPixels = cv.countNonZero(cellROI);
                cellROI.delete();

                // 핀 픽셀 변화 감지
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

            diffMat.delete();
            threshMat.delete();

            // 1.2초 후 감지 고정
            if (pinSequence.length > 0 && lastPinTimestamp) {
                if (pinSequence.length === TOTAL_PINS || (Date.now() - lastPinTimestamp >= 1200)) {
                    isLocked = true;
                    statusText.innerText = `🔒 ${pinSequence.length}개 핀 연결 완료! (재설정: 스페이스바/R)`;
                }
            }
        }

        roiGray.delete();
        srcGray.delete();
        src.delete();
    }

    drawDetections(pinSequence);
    requestAnimationFrame(processFrame);
}

// 🎨 번호 및 연결선 시각화
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
    resetStateData();
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    statusText.innerText = "🖱️ [마우스 드래그] 모루 28개 칸 전체를 드래그해서 네모 상자로 감싸주세요!";
}

resetBtn.addEventListener('click', fullReset);

window.addEventListener('keydown', (e) => {
    if (e.code === 'Space' || e.key === 'r' || e.key === 'R') {
        if (roi) {
            captureBase(); // 기존 위치 유지한 채 깨끗한 베이스만 다시 포착
        } else {
            fullReset();
        }
    }
});
