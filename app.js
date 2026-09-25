// 📌 원본 이미지 1:1 매칭 임계값 (0.80)
const MATCH_THRESHOLD = 0.80;
const TOTAL_PINS = 6;

let isOpenCvReady = false;
let isStreaming = false;

const startBtn = document.getElementById('startBtn');
const resetBtn = document.getElementById('resetBtn');
const statusText = document.getElementById('status');
const video = document.getElementById('webcamVideo');
const canvas = document.getElementById('outputCanvas');
const ctx = canvas.getContext('2d');

const pinTemplates = {};
let loadedTemplatesCount = 0;

let accumulatedPins = {};            // 순차적으로 감지된 핀 저장
let lastPinDetectedTimestamp = null;   // 마지막 감지 시각
let isLocked = false;                  // 잠금 상태 여부

function onOpenCvReady() {
    isOpenCvReady = true;
    statusText.innerText = "엔진 준비 완료! 핀 이미지를 로딩 중입니다...";
    loadPinTemplates();
}

// 🎯 GUI 비율 변환 없이 1.0배 원본 이미지 그대로 로드
function loadPinTemplates() {
    for (let i = 1; i <= TOTAL_PINS; i++) {
        const img = new Image();
        img.src = `pin${i}.png`;
        img.onload = () => {
            try {
                const tempCanvas = document.createElement('canvas');
                tempCanvas.width = img.width;
                tempCanvas.height = img.height;
                const tempCtx = tempCanvas.getContext('2d');
                tempCtx.drawImage(img, 0, 0);

                const mat = cv.imread(tempCanvas);
                const grayMat = new cv.Mat();
                cv.cvtColor(mat, grayMat, cv.COLOR_RGBA2GRAY);

                pinTemplates[`pin${i}`] = {
                    mat: grayMat,
                    width: img.width,
                    height: img.height
                };

                mat.delete();

                loadedTemplatesCount++;
                if (loadedTemplatesCount === TOTAL_PINS) {
                    statusText.innerText = "🟢 준비 완료! [화면 공유 시작]을 누르세요.";
                    startBtn.disabled = false;
                    startBtn.innerText = "🖥️ 화면 공유 시작";
                }
            } catch (err) {
                console.error(`pin${i}.png 변환 실패:`, err);
            }
        };
        img.onerror = () => {
            statusText.innerText = `⚠️ pin${i}.png 파일이 없습니다.`;
        };
    }
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
        statusText.innerText = "🟢 실시간 감지 중... 마인크래프트 제련창을 열어주세요.";

        video.addEventListener('loadedmetadata', () => {
            canvas.width = video.videoWidth;
            canvas.height = video.videoHeight;
            requestAnimationFrame(processFrame);
        });

    } catch (err) {
        statusText.innerText = "❌ 화면 공유가 취소되었거나 오류가 발생했습니다.";
    }
});

function processFrame() {
    if (!isStreaming) return;

    ctx.drawImage(video, 0, 0, canvas.width, canvas.height);

    // 고정(Lock) 상태일 경우 결과만 그리기
    if (isLocked) {
        drawDetections(Object.values(accumulatedPins));
        requestAnimationFrame(processFrame);
        return;
    }

    let src = cv.imread(canvas);
    let srcGray = new cv.Mat();
    cv.cvtColor(src, srcGray, cv.COLOR_RGBA2GRAY);

    // 🎯 중앙 넉넉한 영역 크롭 (가로 70%, 세로 75%)
    const cropW = Math.min(srcGray.cols, Math.round(srcGray.cols * 0.70));
    const cropH = Math.min(srcGray.rows, Math.round(srcGray.rows * 0.75));
    const cropX = Math.max(0, Math.round((srcGray.cols - cropW) / 2));
    const cropY = Math.max(0, Math.round((srcGray.rows - cropH) / 2));

    let rect = new cv.Rect(cropX, cropY, cropW, cropH);
    let roiGray = srcGray.roi(rect);

    // ⚡ [순차 감지 핵심 로직] 아직 안 찾은 '가장 첫 번째 핀 번호' 딱 1개만 결정
    let targetPinNum = 1;
    while (targetPinNum <= TOTAL_PINS && accumulatedPins[targetPinNum]) {
        targetPinNum++;
    }

    // 아직 다 찾지 못했다면 현재 찾아야 할 targetPinNum 1개만 탐색
    if (targetPinNum <= TOTAL_PINS) {
        const tmpl = pinTemplates[`pin${targetPinNum}`];

        if (tmpl && roiGray.cols >= tmpl.width && roiGray.rows >= tmpl.height) {
            let result = new cv.Mat();
            cv.matchTemplate(roiGray, tmpl.mat, result, cv.TM_CCOEFF_NORMED);

            let minMax = cv.minMaxLoc(result);
            let maxVal = minMax.maxVal;
            let maxLoc = minMax.maxLoc;

            if (maxVal >= MATCH_THRESHOLD) {
                accumulatedPins[targetPinNum] = {
                    num: targetPinNum,
                    x: cropX + maxLoc.x + tmpl.width / 2,
                    y: cropY + maxLoc.y + tmpl.height / 2,
                    score: (maxVal * 100).toFixed(0)
                };
                lastPinDetectedTimestamp = Date.now();
            }
            result.delete();
        }
    }

    // ⏱️ 6개 핀을 모두 찾았거나, 1개 이상 찾은 후 1.5초간 새 핀이 없으면 완료 잠금
    const foundCount = Object.keys(accumulatedPins).length;
    if (foundCount === TOTAL_PINS) {
        isLocked = true;
        statusText.innerText = `🔒 6개 핀 완벽 연결 완료! 완료 후 초기화(Space/R)를 누르세요.`;
    } else if (foundCount > 0 && lastPinDetectedTimestamp) {
        if (Date.now() - lastPinDetectedTimestamp >= 1500) {
            isLocked = true;
            statusText.innerText = `🔒 연결 완료 (${foundCount}개 감지). 완료 후 초기화(Space/R)를 누르세요.`;
        }
    }

    drawDetections(Object.values(accumulatedPins));

    roiGray.delete();
    src.delete();
    srcGray.delete();

    requestAnimationFrame(processFrame);
}

// 🎨 원형 숫자 배지 + 연두색 연결선 시각화
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

    // 2. 번호 배지
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
    accumulatedPins = {};
    lastPinDetectedTimestamp = null;
    isLocked = false;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    if (isStreaming) {
        statusText.innerText = "🟢 실시간 감지 중... 마인크래프트 제련창을 열어주세요.";
    }
}

resetBtn.addEventListener('click', resetState);
window.addEventListener('keydown', (e) => {
    if (e.code === 'Space' || e.key === 'r' || e.key === 'R') {
        resetState();
    }
});
