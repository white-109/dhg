let isOpenCvReady = false;
let isStreaming = false;

const startBtn = document.getElementById('startBtn');
const statusText = document.getElementById('status');
const video = document.getElementById('webcamVideo');
const canvas = document.getElementById('outputCanvas');
const ctx = canvas.getContext('2d');
const pipToggle = document.getElementById('pipToggle');
const pipVideo = document.getElementById('pipVideo');

// PIP 전용 가상 캔버스
const pipCanvas = document.createElement('canvas');
const pipCtx = pipCanvas.getContext('2d');

const cropCanvas = document.createElement('canvas');
const cropCtx = cropCanvas.getContext('2d');

let roi = null;
let isDragging = false;
let startX = 0, startY = 0;
let currentX = 0, currentY = 0;

let baseColorMat = null;
let isBaseCaptured = false;

let currentState = 'IDLE';

let pinSequence = [];
let lastPinTimestamp = null;
let detectingStartTime = null;
let isLocked = false;

const TOTAL_PINS = 6;
const MIN_PIN_INTERVAL_MS = 280; // 잔상 중복 감지 방지를 위한 쿨다운 (280ms)

function onOpenCvReady() {
    isOpenCvReady = true;
    statusText.innerText = " 화면 공유를 해주세요.";
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
        statusText.innerText = "제련하기 후 순서가 모두 지나간 빈 모루를 드래그해주세요.";

        video.addEventListener('loadedmetadata', () => {
            canvas.width = video.videoWidth;
            canvas.height = video.videoHeight;
            requestAnimationFrame(processFrame);
        });

    } catch (err) {
        statusText.innerText = "화면 공유 취소";
    }
});

pipToggle.addEventListener('change', async () => {
    if (pipToggle.checked) {
        try {
            const stream = pipCanvas.captureStream(60);
            pipVideo.srcObject = stream;
            await pipVideo.play();
            await pipVideo.requestPictureInPicture();
        } catch (err) {
            pipToggle.checked = false;
        }
    } else {
        if (document.pictureInPictureElement) {
            await document.exitPictureInPicture();
        }
    }
});

pipVideo.addEventListener('leavepictureinpicture', () => {
    pipToggle.checked = false;
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
            statusText.innerText = "드래그 영역이 너무 작습니다.";
        }
    }
});

function captureBase() {
    if (!roi) return;

    cropCanvas.width = roi.w;
    cropCanvas.height = roi.h;
    cropCtx.drawImage(canvas, roi.x, roi.y, roi.w, roi.h, 0, 0, roi.w, roi.h);

    let srcRoi = cv.imread(cropCanvas);
    let srcRGB = new cv.Mat();
    cv.cvtColor(srcRoi, srcRGB, cv.COLOR_RGBA2RGB);

    if (baseColorMat) baseColorMat.delete();
    baseColorMat = srcRGB.clone();
    isBaseCaptured = true;

    currentState = 'WAIT_CLOSE';
    resetStateData();
    statusText.innerText = "모루 창을 한번 닫아주세요.";

    srcRGB.delete();
    srcRoi.delete();
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
        cropCanvas.width = roi.w;
        cropCanvas.height = roi.h;
        cropCtx.drawImage(canvas, roi.x, roi.y, roi.w, roi.h, 0, 0, roi.w, roi.h);
        let roiMat = cv.imread(cropCanvas);

        let currentRGB = new cv.Mat();
        cv.cvtColor(roiMat, currentRGB, cv.COLOR_RGBA2RGB);

        let diffRGB = new cv.Mat();
        cv.absdiff(currentRGB, baseColorMat, diffRGB);

        let diffGray = new cv.Mat();
        cv.cvtColor(diffRGB, diffGray, cv.COLOR_RGB2GRAY);

        let threshMat = new cv.Mat();
        cv.threshold(diffGray, threshMat, 20, 255, cv.THRESH_BINARY);

        let currentHSV = new cv.Mat();
        cv.cvtColor(currentRGB, currentHSV, cv.COLOR_RGB2HSV);

        let hsvPlanes = new cv.MatVector();
        cv.split(currentHSV, hsvPlanes);
        let satMat = hsvPlanes.get(1);

        let satThreshMat = new cv.Mat();
        cv.threshold(satMat, satThreshMat, 20, 255, cv.THRESH_BINARY);

        let finalThreshMat = new cv.Mat();
        cv.bitwise_and(threshMat, satThreshMat, finalThreshMat);

        let totalChangedPixels = cv.countNonZero(threshMat);
        let changeRatio = totalChangedPixels / (roi.w * roi.h);

        if (currentState === 'WAIT_CLOSE') {
            ctx.strokeStyle = "#FF9800";
            ctx.lineWidth = 2;
            ctx.strokeRect(roi.x, roi.y, roi.w, roi.h);

            if (changeRatio > 0.40) {
                currentState = 'WAIT_OPEN';
                statusText.innerText = "제련을 시작하세요.";
            }
        } 
        else if (currentState === 'WAIT_OPEN') {
            ctx.strokeStyle = "#2196F3";
            ctx.lineWidth = 2;
            ctx.strokeRect(roi.x, roi.y, roi.w, roi.h);

            if (changeRatio < 0.18) {
                currentState = 'DETECTING';
                detectingStartTime = Date.now();
                resetStateData();
                statusText.innerText = "순서 감지중";
            }
        } 
        else if (currentState === 'DETECTING') {
            ctx.strokeStyle = "#00E676";
            ctx.lineWidth = 2;
            ctx.strokeRect(roi.x, roi.y, roi.w, roi.h);

            const now = Date.now();

            if (changeRatio > 0.45) {
                currentState = 'WAIT_OPEN';
                resetStateData();
                statusText.innerText = "다음 제련 대기 중";
            } else if (!isLocked && (now - detectingStartTime >= 200)) {
                let contours = new cv.MatVector();
                let hierarchy = new cv.Mat();
                cv.findContours(finalThreshMat, contours, hierarchy, cv.RETR_EXTERNAL, cv.CHAIN_APPROX_SIMPLE);

                let bestCandidate = null;
                const isCooldownReady = !lastPinTimestamp || (now - lastPinTimestamp >= MIN_PIN_INTERVAL_MS);

                const cellW = roi.w / 8;
                const cellH = roi.h / 4;

                for (let i = 0; i < contours.size(); ++i) {
                    let cnt = contours.get(i);
                    let area = cv.contourArea(cnt);

                    if (area > 30 && area < 3500) {
                        let M = cv.moments(cnt, true);
                        if (M.m00 > 0) {
                            let rawCx = Math.round(M.m10 / M.m00) + roi.x;
                            let rawCy = Math.round(M.m01 / M.m00) + roi.y;

                            // 1. 감지된 파티클 위치가 몇 번째 칸(행/열)에 속하는지 계산
                            let col = Math.min(7, Math.max(0, Math.floor((rawCx - roi.x) / cellW)));
                            let row = Math.min(3, Math.max(0, Math.floor((rawCy - roi.y) / cellH)));

                            // 2. 해당 칸의 정중앙 좌표로 보정
                            let snappedX = Math.round(roi.x + (col + 0.5) * cellW);
                            let snappedY = Math.round(roi.y + (row + 0.5) * cellH);

                            // 3. 동일한 칸 중복 등록 방지
                            let isDuplicate = pinSequence.some(pin => {
                                return Math.hypot(pin.x - snappedX, pin.y - snappedY) < Math.min(cellW, cellH) * 0.7;
                            });

                            if (!isDuplicate) {
                                bestCandidate = { x: snappedX, y: snappedY };
                                break;
                            }
                        }
                    }
                }

                contours.delete();
                hierarchy.delete();

                if (bestCandidate && isCooldownReady && pinSequence.length < TOTAL_PINS) {
                    pinSequence.push({
                        num: pinSequence.length + 1,
                        x: bestCandidate.x,
                        y: bestCandidate.y
                    });
                    lastPinTimestamp = now;
                    statusText.innerText = `${pinSequence.length}번 순서 확인`;
                }

                if (pinSequence.length > 0 && lastPinTimestamp) {
                    if (pinSequence.length === TOTAL_PINS || (now - lastPinTimestamp >= 2000)) {
                        isLocked = true;
                        statusText.innerText = `${pinSequence.length}개 순서확인.`;
                    }
                }
            }
        }

        finalThreshMat.delete();
        satThreshMat.delete();
        satMat.delete();
        hsvPlanes.delete();
        currentHSV.delete();
        threshMat.delete();
        diffGray.delete();
        diffRGB.delete();
        currentRGB.delete();
        roiMat.delete();
    }

    drawDetections(pinSequence);

    if (roi && roi.w > 0 && roi.h > 0) {
        pipCanvas.width = roi.w;
        pipCanvas.height = roi.h;
        pipCtx.drawImage(canvas, roi.x, roi.y, roi.w, roi.h, 0, 0, roi.w, roi.h);
    } else {
        pipCanvas.width = canvas.width || 640;
        pipCanvas.height = canvas.height || 360;
        pipCtx.drawImage(canvas, 0, 0);
    }

    requestAnimationFrame(processFrame);
}

function drawDetections(pins) {
    if (pins.length === 0 || currentState !== 'DETECTING') return;

    pins.sort((a, b) => a.num - b.num);

    const now = Date.now();

    if (pins.length > 1) {
        ctx.beginPath();
        ctx.moveTo(pins[0].x, pins[0].y);
        for (let i = 1; i < pins.length; i++) {
            ctx.lineTo(pins[i].x, pins[i].y);
        }
        ctx.strokeStyle = "rgba(0, 230, 118, 0.8)";
        ctx.lineWidth = 4;
        ctx.lineJoin = "round";
        ctx.stroke();

        const arrowSpacing = 32;
        const arrowSpeed = 0.045; 
        const offset = (now * arrowSpeed) % arrowSpacing;

        for (let i = 0; i < pins.length - 1; i++) {
            const p1 = pins[i];
            const p2 = pins[i + 1];

            const dx = p2.x - p1.x;
            const dy = p2.y - p1.y;
            const dist = Math.hypot(dx, dy);

            if (dist === 0) continue;

            const angle = Math.atan2(dy, dx);
            const ux = dx / dist;
            const uy = dy / dist;

            for (let d = offset; d < dist; d += arrowSpacing) {
                if (d < 22 || d > dist - 18) continue;

                const ax = p1.x + ux * d;
                const ay = p1.y + uy * d;

                ctx.save();
                ctx.translate(ax, ay);
                ctx.rotate(angle);

                ctx.beginPath();
                ctx.moveTo(5, 0);
                ctx.lineTo(-4, -4);
                ctx.lineTo(-2, 0);
                ctx.lineTo(-4, 4);
                ctx.closePath();

                ctx.fillStyle = "#FFFFFF";
                ctx.fill();
                ctx.strokeStyle = "#000000";
                ctx.lineWidth = 1;
                ctx.stroke();

                ctx.restore();
            }
        }
    }

    pins.forEach((pin) => {
        const isStart = (pin.num === 1);
        const radius = isStart ? 24 : 16;
        const fillColor = isStart ? "#FF1744" : "#00E676";
        const textColor = isStart ? "#FFFFFF" : "#000000";

        if (isStart) {
            ctx.beginPath();
            ctx.arc(pin.x, pin.y, radius + 5, 0, Math.PI * 2);
            ctx.fillStyle = "rgba(255, 23, 68, 0.35)";
            ctx.fill();
        }

        ctx.beginPath();
        ctx.arc(pin.x, pin.y, radius, 0, Math.PI * 2);
        ctx.fillStyle = fillColor;
        ctx.fill();
        ctx.lineWidth = 2.5;
        ctx.strokeStyle = "#000000";
        ctx.stroke();

        ctx.fillStyle = textColor;
        ctx.font = isStart ? "bold 22px sans-serif" : "bold 18px sans-serif";
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        ctx.fillText(pin.num, pin.x, pin.y);
    });
}

function resetStateData() {
    pinSequence = [];
    lastPinTimestamp = null;
    isLocked = false;
}
