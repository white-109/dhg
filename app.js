// 📌 최적 임계값: 기본 80% (0.80)
const MATCH_THRESHOLD = 0.79;

// 🎯 연산 속도를 보장하는 핵심 GUI 스케일 비율 (5단계)
const SCALES = [0.7, 0.85, 1.0, 1.15, 1.3];

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

let accumulatedPins = {};          // 감지된 핀 누적 저장
let lastPinDetectedTimestamp = null; // 마지막 감지 시각
let isLocked = false;                // 1.5초 타임아웃 감지 고정 여부

function onOpenCvReady() {
    isOpenCvReady = true;
    statusText.innerText = "엔진 준비 완료! 다중 GUI 대응 핀을 로딩 중입니다...";
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

                SCALES.forEach(scale => {
                    let targetW = Math.round(img.width * scale);
                    let targetH = Math.round(img.height * scale);

                    if (targetW > 5 && targetH > 5) {
                        let resizedMat = new cv.Mat();
                        let dsize = new cv.Size(targetW, targetH);
                        cv.resize(grayMat, resizedMat, dsize, 0, 0, cv.INTER_LINEAR);

                        pinTemplates[`pin${i}`].push({
                            mat: resizedMat,
                            scale: scale,
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
            video: { frameRate: { ideal: 30, max: 60 } },
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

    // 감지 완료 시 결과 고정 시각화
    if (isLocked) {
        drawDetections(Object.values(accumulatedPins));
        requestAnimationFrame(processFrame);
        return;
    }

    let src = cv.imread(canvas);
    let srcGray = new cv.Mat();
    cv.cvtColor(src, srcGray, cv.COLOR_RGBA2GRAY);

    // ⚡ 연산 최적화: 아직 못 찾은 '다음 번호 핀'을 우선적으로 집중 탐색
    for (let i = 1; i <= TOTAL_PINS; i++) {
        if (accumulatedPins[i]) continue;

        const scaledTemplates = pinTemplates[`pin${i}`];
        if (!scaledTemplates) continue;

        let bestMatchForThisPin = null;

        for (let templateInfo of scaledTemplates) {
            if (srcGray.cols < templateInfo.width || srcGray.rows < templateInfo.height) continue;

            let result = new cv.Mat();
            cv.matchTemplate(srcGray, templateInfo.mat, result, cv.TM_CCOEFF_NORMED);

            let minMax = cv.minMaxLoc(result);
            let maxVal = minMax.maxVal;
            let maxLoc = minMax.maxLoc;

            // 💡 리사이즈 오차 감안하여 78% 이상부터 정밀 채택
            if (maxVal >= 0.78) {
                if (!bestMatchForThisPin || maxVal > bestMatchForThisPin.scoreVal) {
                    bestMatchForThisPin = {
                        num: i,
                        x: maxLoc.x + templateInfo.width / 2,
                        y: maxLoc.y + templateInfo.height / 2,
                        score: (maxVal * 100).toFixed(0),
                        scoreVal: maxVal
                    };
                }
            }
            result.delete();
        }

        if (bestMatchForThisPin) {
            accumulatedPins[i] = bestMatchForThisPin;
            lastPinDetectedTimestamp = Date.now();
        }

        // 연속 탐지 시 한 프레임당 1~2개 단위로 효율적 탐색 (렉 방지)
        if (bestMatchForThisPin && i < TOTAL_PINS) {
            break;
        }
    }

    // ⏱️ 1.5초 동안 새 핀 감지 없으면 고정
    if (Object.keys(accumulatedPins).length > 0 && lastPinDetectedTimestamp) {
        if (Date.now() - lastPinDetectedTimestamp >= 2000) {
            isLocked = true;
            statusText.innerText = `🔒 연결 완료 (${Object.keys(accumulatedPins).length}개). 완료 후 초기화(Space/R)를 누르세요.`;
        }
    }

    drawDetections(Object.values(accumulatedPins));

    src.delete();
    srcGray.delete();

    requestAnimationFrame(processFrame);
}

// 🎨 깔끔한 원형 배지 및 연결선 시각화 (네모 박스 완전 제거)
function drawDetections(pins) {
    if (pins.length === 0) return;

    pins.sort((a, b) => a.num - b.num);

    // 1. 선명한 가이드 선 그리기
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

    // 2. 각 핀 중앙에 동그란 숫자 배지 그리기
    pins.forEach((pin) => {
        const radius = 16;

        // 원형 테두리 및 배경
        ctx.beginPath();
        ctx.arc(pin.x, pin.y, radius, 0, Math.PI * 2);
        ctx.fillStyle = "#00E676"; // 시독성 높은 네온 그린
        ctx.fill();
        ctx.lineWidth = 3;
        ctx.strokeStyle = "#000000"; // 검은색 겉 테두리
        ctx.stroke();

        // 번호 텍스트 (원 중앙 정렬)
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
