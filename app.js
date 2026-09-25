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

// 핀 템플릿 이미지 객체 저장
const pinTemplates = {};
const TOTAL_PINS = 6;
let loadedTemplatesCount = 0;

// OpenCV.js 준비 완료 콜백
function onOpenCvReady() {
    isOpenCvReady = true;
    statusText.innerText = "엔진 준비 완료 샘플 로딩 완료";
    loadPinTemplates();
}

// 핀 이미지 (pin1.png ~ pin6.png) 로드
function loadPinTemplates() {
    for (let i = 1; i <= TOTAL_PINS; i++) {
        const img = new Image();
        img.src = `pin${i}.png`;
        img.onload = () => {
            // HTML Image를 OpenCV Mat 객체(그레이스케일)로 변환하여 저장
            const mat = cv.imread(img);
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
                statusText.innerText = "준비 완료 [화면 공유 시작] 을 누르세요.";
                startBtn.disabled = false;
                startBtn.innerText = "화면 공유 시작";
            }
        };
        img.onerror = () => {
            statusText.innerText = `⚠️ pin${i}.png 이미지를 불러오지 못했습니다. 파일 위치를 확인하세요.`;
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
        statusText.innerText = "감지 중 , 제련을 시작하세요. ";

        video.addEventListener('loadedmetadata', () => {
            canvas.width = video.videoWidth;
            canvas.height = video.videoHeight;
            requestAnimationFrame(processFrame);
        });

    } catch (err) {
        console.error("화면 공유 실패:", err);
        statusText.innerText = "화면 공유가 취소되었거나 오류가 발생했습니다.";
    }
});

// 프레임 처리 (실시간 80% 매칭 검사)
function processFrame() {
    if (!isStreaming) return;

    // Canvas에 현재 비디오 프레임 그리기
    ctx.drawImage(video, 0, 0, canvas.width, canvas.height);

    // Canvas 프레임을 OpenCV Mat으로 가져옴
    let src = cv.imread(canvas);
    let srcGray = new cv.Mat();
    cv.cvtColor(src, srcGray, cv.COLOR_RGBA2GRAY);

    let detectedPins = [];

    // 1번부터 6번 핀 탐색
    for (let i = 1; i <= TOTAL_PINS; i++) {
        const templateInfo = pinTemplates[`pin${i}`];
        if (!templateInfo) continue;

        let result = new cv.Mat();
        // 템플릿 매칭 연산 수행 (TM_CCOEFF_NORMED)
        cv.matchTemplate(srcGray, templateInfo.mat, result, cv.TM_CCOEFF_NORMED);

        // 정밀 측정 결과 최소/최고점 파악
        let minMax = cv.minMaxLoc(result);
        let maxVal = minMax.maxVal; // 최고 일치율 (0.0 ~ 1.0)
        let maxLoc = minMax.maxLoc; // 위치

        // 🎯 결정된 임계값 80% (0.80) 이상일 때만 인식
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

    // 탐지 결과 시각화 (핀 오버레이 및 연결선 그리기)
    drawDetections(detectedPins);

    // 메모리 해제
    src.delete();
    srcGray.delete();

    // 다음 프레임 요청 (실시간 감지)
    requestAnimationFrame(processFrame);
}

// 화면에 핀 위치 및 연결 순서선 표시
function drawDetections(pins) {
    // 번호 순서대로 정렬 (1 -> 2 -> 3...)
    pins.sort((a, b) => a.num - b.num);

    // 1. 핀 간 연결선 그리기 (녹색 가이드 라인)
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

    // 2. 각 핀 위치에 상자 및 번호 표시
    pins.forEach((pin) => {
        // 감지 상자
        ctx.strokeStyle = "#00FF00";
        ctx.lineWidth = 2;
        ctx.strokeRect(pin.boxX, pin.boxY, pin.width, pin.height);

        // 핀 번호 & 확신도 텍스트
        ctx.fillStyle = "#00FF00";
        ctx.font = "bold 16px Arial";
        ctx.fillText(`P${pin.num} (${pin.score}%)`, pin.boxX, Math.max(pin.boxY - 6, 20));
    });
}

// 리셋 및 키보드 단축키 처리
function resetState() {
    ctx.clearRect(0, 0, canvas.width, canvas.height);
}

resetBtn.addEventListener('click', resetState);
window.addEventListener('keydown', (e) => {
    if (e.code === 'Space' || e.key === 'r' || e.key === 'R') {
        resetState();
    }
});