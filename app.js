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

// 🧠 [신규] 핀 위치 누적 기억 및 타임아웃 상태 변수
let accumulatedPins = {};          // 감지된 핀 정보 저장 ({ 1: {...}, 2: {...} })
let lastPinDetectedTimestamp = null; // 마지막 핀 감지 시각
let isLocked = false;                // 1.5초 지남에 따른 감지 잠금 여부

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

// 실시간 프레임 처리 및 누적 감지 로직
function processFrame() {
    if (!isStreaming) return;

    ctx.drawImage(video, 0, 0, canvas.width, canvas.height);

    // 🔒 1.5초 초과로 감지가 잠긴 상태인 경우: 화면에 결과만 고정 표시
    if (isLocked) {
        drawDetections(Object.values(accumulatedPins));
        requestAnimationFrame(processFrame);
        return;
    }

    let src = cv.imread(canvas);
    let srcGray = new cv.Mat();
    cv.cvtColor(src, srcGray, cv.COLOR_RGBA2GRAY);

    // 1번부터 6번 핀 중 아직 기억되지 않은 핀만 탐색
    for (let i = 1; i <= TOTAL_PINS; i++) {
        if (accumulatedPins[i]) continue; // 이미 잡은 핀은 재검사 생략 (기억 유지)

        const templateInfo = pinTemplates[`pin${i}`];
        if (!templateInfo) continue;

        let result = new cv.Mat();
        cv.matchTemplate(srcGray, templateInfo.mat, result, cv.TM_CCOEFF_NORMED);

        let minMax = cv.minMaxLoc(result);
        let maxVal = minMax.maxVal;
        let maxLoc = minMax.maxLoc;

        // 80% 이상 일치 시 핀 정보 메모리에 누적 저장
        if (maxVal >= MATCH_THRESHOLD) {
            accumulatedPins[i] = {
                num: i,
                x: maxLoc.x + templateInfo.width / 2,
                y: maxLoc.y + templateInfo.height / 2,
                boxX: maxLoc.x,
                boxY: maxLoc.y,
                width: templateInfo.width,
                height: templateInfo.height,
                score: (maxVal * 100).toFixed(0)
            };
            // 핀이 추가될 때마다 타이머 갱신
            lastPinDetectedTimestamp = Date.now();
        }
        result.delete();
    }

    // ⏱️ 1.5초 타임아웃 검사: 마지막 핀 감지 후 1.5초 동안 새 핀이 없으면 고정
    if (Object.keys(accumulatedPins).length > 0 && lastPinDetectedTimestamp) {
        if (Date.now() - lastPinDetectedTimestamp >= 1500) {
            isLocked = true;
            statusText.innerText = `🔒 감지 완료 (${Object.keys(accumulatedPins).length}개 핀 연결 고정). 제련 후 초기화(Space/R)를 누르세요.`;
        }
    }

    // 누적된 모든 핀 및 연결선 그리기
    drawDetections(Object.values(accumulatedPins));

    src.delete();
    srcGray.delete();

    requestAnimationFrame(processFrame);
}

// 누적된 핀 화면에 표시 및 순서 선 연결
function drawDetections(pins) {
    if (pins.length === 0) return;

    // 번호 순서대로 정렬 (1 -> 2 -> 3...)
    pins.sort((a, b) => a.num - b.num);

    // 1. 핀 간 연결선 그리기 (밝은 녹색 가이드 라인)
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

    // 2. 각 핀 박스 및 번호 표시
    pins.forEach((pin) => {
        ctx.strokeStyle = "#00FF00";
        ctx.lineWidth = 2;
        ctx.strokeRect(pin.boxX, pin.boxY, pin.width, pin.height);

        ctx.fillStyle = "#00FF00";
        ctx.font = "bold 16px Arial";
        ctx.fillText(`P${pin.num} (${pin.score}%)`, pin.boxX, Math.max(pin.boxY - 6, 20));
    });
}

// 초기화 함수 (새 제련 시작 시)
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
