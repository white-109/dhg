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

const TOTAL_PINS = 6;
const PERSISTENCE_FRAMES = 4; // 4프레임 이상 고정 유지 시 인식

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
        statusText.innerText = "🟢 제련창을 열고 [스페이스바]를 눌러 베이스 이미지를 캡처하세요!";

        video.addEventListener('loadedmetadata', () => {
            canvas.width = video.videoWidth;
            canvas.height = video.videoHeight;
            requestAnimationFrame(processFrame);
        });

    } catch (err) {
        statusText.innerText = "❌ 화면 공유 실패";
    }
});

// 28개 격자 칸 좌표 생성
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
                x: Math.round(colIdx * cellW + cellW * 0.25),
                y: Math.round(cfg.row * cellH + cellH * 0.25),
                w: Math.round(cellW * 0.50),
                h: Math.round(cellH * 0.50),
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

    let src = cv.imread(canvas);
    let srcGray = new cv.Mat();
    cv.cvtColor(src, srcGray, cv.COLOR_RGBA2GRAY);

    // 모루 회색 영역 중앙 매핑 (가로 52%, 세로 40%로 범위 축소하여 외각/망치 간섭 차단)
    const cropW = Math.round(srcGray.cols * 0.52);
    const cropH = Math.round(srcGray.rows * 0.40);
    const cropX = Math.round((srcGray.cols - cropW) / 2);
    const cropY = Math.round((srcGray.rows - cropH) / 2 - srcGray.rows * 0.02);

    let rect = new cv.Rect(cropX, cropY, cropW, cropH);
    let roiGray = srcGray.roi(rect);

    const gridCells = getGridCells(cropW, cropH);

    // 🎯 화면에 현재 감시 영역(노란색 박스) 및 28개 칸(파란색 박스) 표시 (디버그용)
    ctx.strokeStyle = "yellow";
    ctx.lineWidth = 2;
    ctx.strokeRect(cropX, cropY, cropW, cropH);

    gridCells.forEach((cell, i) => {
        ctx.strokeStyle = registeredCells.has(i) ? "#00FF00" : "rgba(0, 150, 255, 0.5)";
        ctx.lineWidth = 1;
        ctx.strokeRect(cropX + cell.x, cropY + cell.y, cell.w, cell.h);
    });

    if (isBaseCaptured && !isLocked) {
        let diffMat = new cv.Mat();
        let threshMat = new cv.Mat();

        cv.absdiff(roiGray, baseGrayMat, diffMat);
        cv.threshold(diffMat, threshMat, 45, 255, cv.THRESH_BINARY); // 문턱값 높여 민감도 조절

        gridCells.forEach((cell, idx) => {
            if (registeredCells.has(idx) || pinSequence.length >= TOTAL_PINS) return;

            let cellRect = new cv.Rect(cell.x, cell.y, cell.w, cell.h);
            let cellROI = threshMat.roi(cellRect);
            let changedPixels = cv.countNonZero(cellROI);
            cellROI.delete();

            // 칸 면적 대비 변화율 검사
            if (changedPixels > (cell.w * cell.h * 0.20)) {
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

        if (pinSequence.length > 0 && lastPinTimestamp) {
            if (pinSequence.length === TOTAL_PINS || (Date.now() - lastPinTimestamp >= 2000)) {
                isLocked = true;
                statusText.innerText = `🔒 ${pinSequence.length}개 감지 완료! [Space / R]로 초기화`;
            }
        }
    }

    drawDetections(pinSequence);

    roiGray.delete();
    src.delete();
    srcGray.delete();

    requestAnimationFrame(processFrame);
}

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

function captureBase() {
    if (!isStreaming) return;
    let src = cv.imread(canvas);
    let srcGray = new cv.Mat();
    cv.cvtColor(src, srcGray, cv.COLOR_RGBA2GRAY);

    const cropW = Math.round(srcGray.cols * 0.52);
    const cropH = Math.round(srcGray.rows * 0.40);
    const cropX = Math.round((srcGray.cols - cropW) / 2);
    const cropY = Math.round((srcGray.rows - cropH) / 2 - srcGray.rows * 0.02);

    let rect = new cv.Rect(cropX, cropY, cropW, cropH);
    let roiGray = srcGray.roi(rect);

    if (baseGrayMat) baseGrayMat.delete();
    baseGrayMat = roiGray.clone();
    isBaseCaptured = true;

    registeredCells.clear();
    cellPersistence = {};
    pinSequence = [];
    isLocked = false;

    statusText.innerText = "📸 기준 모루 이미지 저장 완료! 이제 제련을 시작하세요.";

    roiGray.delete();
    src.delete();
    srcGray.delete();
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
    statusText.innerText = "🟢 제련창을 열고 [스페이스바]를 눌러 베이스 이미지를 캡처하세요!";
}

resetBtn.addEventListener('click', resetState);

window.addEventListener('keydown', (e) => {
    if (e.code === 'Space') {
        e.preventDefault();
        captureBase();
    } else if (e.key === 'r' || e.key === 'R') {
        resetState();
    }
});
