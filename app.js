// 📌 최적 임계값: 78% (0.78)
const MATCH_THRESHOLD = 0.78;

// 🎯 가장 많이 쓰이는 1.0배율을 최우선 배치
const SCALES = [1.0, 0.85, 1.15, 0.7, 1.3];

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

let accumulatedPins = {};            // 누적 감지된 핀 저장
let lastPinDetectedTimestamp = null;   // 마지막 감지 시각
let isLocked = false;                  // 1.5초 타임아웃 고정 여부
let lockedScaleIndex = null;           // ⚡ 60 FPS 유지를 위한 스케일 고정 변수

function onOpenCvReady() {
    isOpenCvReady = true;
    statusText.innerText = "엔진 준비 완료! 핀 이미지를 구성 중입니다...";
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

                SCALES.forEach((scale, scaleIdx) => {
                    let targetW = Math.round(img.width * scale);
                    let targetH = Math.round(img.height * scale);

                    if (targetW > 5 && targetH > 5) {
                        let resizedMat = new cv.Mat();
                        let dsize = new cv.Size(targetW, targetH);
                        cv.resize(grayMat, resizedMat, dsize, 0, 0, cv.INTER_LINEAR);

                        pinTemplates[`pin${i}`].push({
                            mat: resizedMat,
                            scale: scale,
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

    if (isLocked) {
        drawDetections(Object.values(accumulatedPins));
        requestAnimationFrame(processFrame);
        return;
    }

    let src = cv.imread(canvas);
    let srcGray = new cv.Mat();
    cv.cvtColor(src, srcGray, cv.COLOR_RGBA2GRAY);

    // ⚡ [최적화] 실제 마크 제련창 영역에 맞춘 중앙 정밀 크롭 (가로 50%, 세로 55%)
    const cropW = Math.min(srcGray.cols, Math.round(srcGray.cols * 0.50));
    const cropH = Math.min(srcGray.rows, Math.round(srcGray.rows * 0.55));
    const cropX = Math.max(0, Math.round((srcGray.cols - cropW) / 2));
    const cropY = Math.max(0, Math.round((srcGray.rows - cropH) / 2));

    let rect = new cv.Rect(cropX, cropY, cropW, cropH);
    let roiGray = srcGray.roi(rect);

    for (let i = 1; i <= TOTAL_PINS; i++) {
        if (accumulatedPins[i]) continue;

        const scaledTemplates = pinTemplates[`pin${i}`];
        if (!scaledTemplates) continue;

        // ⚡ [핵심 60 FPS 로직] 배율이 이미 측정되었으면 해당 배율만 0.001초 탐색
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

            // 첫 핀 감지 시 유저의 GUI 배율 고정 (이후 프레임 속도 폭발적 증가)
            if (lockedScaleIndex === null) {
                lockedScaleIndex = bestMatchForThisPin.scaleIdx;
            }
        }
    }

    // ⏱️ 1.5초간 새 핀 미감지 시 잠금
    if (Object.keys(accumulatedPins).length > 0 && lastPinDetectedTimestamp) {
        if (Date.now() - lastPinDetectedTimestamp >= 1500) {
            isLocked = true;
            statusText.innerText = `🔒 연결 완료 (${Object.keys(accumulatedPins).length}개). 제련 후 초기화(Space/R)를 누르세요.`;
        }
    }

    drawDetections(Object.values(accumulatedPins));

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
        ctx.lineJoin = "round";
        ctx.stroke();
    }

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
    lockedScaleIndex = null; // 초기화 시 배율 재측정 준비
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
