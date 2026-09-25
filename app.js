// 📌 최적 임계값: 80% (0.80) 고정 - 3↔4, 5↔6 오탐 완전 차단
const MATCH_THRESHOLD = 0.80;

// 🎯 GUI 스케일: 원본 (GUI 3) 및 GUI 2 (2/3 비율) 딱 2가지만 깔끔하게 지원
const SCALES = [
    { scale: 1.0, name: "GUI 3 (원본)" },
    { scale: 2.0 / 3.0, name: "GUI 2" }
];

let isOpenCvReady = false;
let isStreaming = false;

const startBtn = document.getElementById('startBtn');
const resetBtn = document.getElementById('resetBtn');
const statusText = document.getElementById('status');
const video = document.getElementById('webcamVideo');
const canvas = document.getElementById('outputCanvas');
const ctx = canvas.getContext('2d');

const pinTemplates = {};
const TOTAL_PINS = 6;
let loadedTemplatesCount = 0;

let accumulatedPins = {};            // 누적 감지된 핀 저장 ({ 1: {...}, 2: {...} })
let lastPinDetectedTimestamp = null;   // 마지막 감지 시각
let isLocked = false;                  // 1.5초 타임아웃 고정 여부
let lockedScaleIndex = null;           // GUI 배율 고정 변수

function onOpenCvReady() {
    isOpenCvReady = true;
    statusText.innerText = "엔진 준비 완료! 핀 이미지를 로딩 중입니다...";
    loadPinTemplates();
}

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

                pinTemplates[`pin${i}`] = [];

                SCALES.forEach((scaleObj, scaleIdx) => {
                    let targetW = Math.round(img.width * scaleObj.scale);
                    let targetH = Math.round(img.height * scaleObj.scale);

                    if (targetW > 5 && targetH > 5) {
                        let resizedMat = new cv.Mat();
                        let dsize = new cv.Size(targetW, targetH);
                        // INTER_AREA 알고리즘으로 축소 시 픽셀 선명도 유지
                        cv.resize(grayMat, resizedMat, dsize, 0, 0, cv.INTER_AREA);

                        pinTemplates[`pin${i}`].push({
                            mat: resizedMat,
                            scaleIdx: scaleIdx,
                            width: targetW,
                            height: targetH
                        });
                    }
                });

                mat.delete();
                grayMat.delete();

                loadedTemplatesCount++;
                if (loadedTemplatesCount === TOTAL_PINS) {
                    statusText.innerText = "🟢 준비 완료! (GUI 2 / GUI 3 지원) [화면 공유 시작]을 누르세요.";
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

    // 1.5초 고정 상태일 때는 그려진 결과만 유지
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

    for (let i = 1; i <= TOTAL_PINS; i++) {
        if (accumulatedPins[i]) continue; // 이미 찾아낸 핀은 통과

        const scaledTemplates = pinTemplates[`pin${i}`];
        if (!scaledTemplates) continue;

        // 첫 핀 감지 후 배율이 고정되었으면 해당 배율만 0.001초 검사
        const templatesToSearch = (lockedScaleIndex !== null)
            ? [scaledTemplates.find(t => t.scaleIdx === lockedScaleIndex) || scaledTemplates[0]]
            : scaledTemplates;

        let bestMatchForThisPin = null;

        for (let templateInfo of templatesToSearch) {
            if (!templateInfo) continue;
            if (roiGray.cols < templateInfo.width || roiGray.rows < templateInfo.height) continue;

            let result = new cv.Mat();
            cv.matchTemplate(roiGray, templateInfo.mat, result, cv.TM_CCOEFF_NORMED);

            let minMax = cv.minMaxLoc(result);
            let maxVal = minMax.maxVal;
            let maxLoc = minMax.maxLoc;

            // 🎯 엄격한 80% (0.80) 기준 적용
            if (maxVal >= MATCH_THRESHOLD) {
                if (!bestMatchForThisPin || maxVal > bestMatchForThisPin.scoreVal) {
                    bestMatchForThisPin = {
                        num: i,
                        x: cropX + maxLoc.x + templateInfo.width / 2,
                        y: cropY + maxLoc.y + templateInfo.height / 2,
                        score: (maxVal * 100).toFixed(0),
                        scoreVal: maxVal,
                        scaleIdx: templateInfo.scaleIdx
                    };
                }
            }
            result.delete();
        }

        if (bestMatchForThisPin) {
            accumulatedPins[i] = bestMatchForThisPin;
            lastPinDetectedTimestamp = Date.now();

            if (lockedScaleIndex === null) {
                lockedScaleIndex = bestMatchForThisPin.scaleIdx;
            }
        }
    }

    // ⏱️ 1.5초간 새 핀 감지가 없으면 잠금
    if (Object.keys(accumulatedPins).length > 0 && lastPinDetectedTimestamp) {
        if (Date.now() - lastPinDetectedTimestamp >= 1500) {
            isLocked = true;
            statusText.innerText = `🔒 연결 완료 (${Object.keys(accumulatedPins).length}개). 완료 후 초기화(Space/R)를 누르세요.`;
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

    // 1. 순서 가이드 라인
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

    // 2. 핀 중앙 원형 번호 배지
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
    lockedScaleIndex = null;
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
