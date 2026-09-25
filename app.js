// 📌 유저 검증 기반 최적 임계값: 80% (0.80)
const MATCH_THRESHOLD = 0.80;

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

// OpenCV 엔진 로딩 완벽 완료 시 호출
function onOpenCvReady() {
    isOpenCvReady = true;
    statusText.innerText = "엔진 준비 완료! 핀 이미지를 로딩 중입니다...";
    loadPinTemplates();
}

// 핀 이미지(pin1.png ~ pin6.png) 안전 로드
function loadPinTemplates() {
    for (let i = 1; i <= TOTAL_PINS; i++) {
        const img = new Image();
        img.src = `pin${i}.png`;
        img.onload = () => {
            try {
                // 임시 캔버스 제작 후 안전하게 Mat으로 변환 (오류 방지)
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
                    statusText.innerText = "🟢 모든 준비 완료! [화면 공유 시작] 버튼을 누르세요.";
                    startBtn.disabled = false;
                    startBtn.innerText = "🖥️ 화면 공유 시작";
                }
            } catch (err) {
                console.error(`pin${i}.png 변환 실패:`, err);
                statusText.innerText = `⚠️ pin${i}.png 이미지 처리 중 오류 발생`;
            }
        };
        img.onerror = () => {
            statusText.innerText = `⚠️ pin${i}.png 파일이 없습니다. 저장소 디렉토리를 확인하세요.`;
        };
    }
}

// 화면 공유 시작
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
        console.error("화면 공유 실패:", err);
        statusText.innerText = "❌ 화면 공유가 취소되었거나 오류가 발생했습니다.";
    }
});

// 실시간 80% 매칭 프레임 연산
function processFrame() {
    if (!isStreaming) return;

    ctx.drawImage(video, 0, 0, canvas.width, canvas.height);

    let src = cv.imread(canvas);
    let srcGray = new cv.Mat();
    cv.cvtColor(src, srcGray, cv.COLOR_RGBA2GRAY);

    let detectedPins = [];

    for (let i = 1; i <= TOTAL_PINS; i++) {
        const templateInfo = pinTemplates[`pin${i}`];
        if (!templateInfo) continue;

        let result = new cv.Mat();
        cv.matchTemplate(srcGray, templateInfo.mat, result, cv.TM_CCOEFF_NORMED);

        let minMax = cv.minMaxLoc(result);
        let maxVal = minMax.maxVal;
        let maxLoc = minMax.maxLoc;

        if (maxVal >= MATCH_THRESHOLD) {
            detectedPins.push({
                num: i,
                x: maxLoc.x + templateInfo.width / 2,
                y: maxLoc.y + templateInfo.height / 2,
                boxX: maxLoc.x,
                boxY: maxLoc.y,
                width: templateInfo.width,
                height: templateInfo.height,
                score: (maxVal * 100).toFixed(0)
            });
        }
        result.delete();
    }

    drawDetections(detectedPins);

    src.delete();
    srcGray.delete();

    requestAnimationFrame(processFrame);
}

function drawDetections(pins) {
    pins.sort((a, b) => a.num - b.num);

    if (pins.length > 1) {
        ctx.beginPath();
        ctx.moveTo(pins[0].x, pins[0].y);
        for (let i = 1; i < pins.length; i++) {
            ctx.lineTo(pins[i].x, pins[i].y);
        }
        ctx.strokeStyle = "#00FF00";
        ctx.lineWidth = 4;
        ctx.stroke();
    }

    pins.forEach((pin) => {
        ctx.strokeStyle = "#00FF00";
        ctx.lineWidth = 2;
        ctx.strokeRect(pin.boxX, pin.boxY, pin.width, pin.height);

        ctx.fillStyle = "#00FF00";
        ctx.font = "bold 16px Arial";
        ctx.fillText(`P${pin.num} (${pin.score}%)`, pin.boxX, Math.max(pin.boxY - 6, 20));
    });
}

function resetState() {
    ctx.clearRect(0, 0, canvas.width, canvas.height);
}

resetBtn.addEventListener('click', resetState);
window.addEventListener('keydown', (e) => {
    if (e.code === 'Space' || e.key === 'r' || e.key === 'R') {
        resetState();
    }
});
