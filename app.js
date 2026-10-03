let isOpenCvReady = false;
let isStreaming = false;

const startBtn = document.getElementById('startBtn');
const statusText = document.getElementById('status');
const video = document.getElementById('webcamVideo');
const canvas = document.getElementById('outputCanvas');
const ctx = canvas.getContext('2d');
const pipToggle = document.getElementById('pipToggle');
const pipVideo = document.getElementById('pipVideo');
const pxSlider = document.getElementById('pxSlider');
const pxValueText = document.getElementById('pxValueText');

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
const MIN_PIN_INTERVAL_MS = 250;
const DUPLICATE_DIST_PX = 38; 

let customRadiusPx = parseInt(localStorage.getItem('anvil_radius_px')) || 12;

if (pxSlider) {
    pxSlider.value = customRadiusPx;
    if (pxValueText) pxValueText.innerText = customRadiusPx + 'px';
    pxSlider.addEventListener('input', (e) => {
        customRadiusPx = parseInt(e.target.value);
        if (pxValueText) pxValueText.innerText = customRadiusPx + 'px';
        localStorage.setItem('anvil_radius_px', customRadiusPx);
    });
}

function onOpenCvReady() {
    isOpenCvReady = true;
    statusText.innerText = " 화면 공유를 해주세요.";
    startBtn.disabled = false;
}

startBtn.addEventListener('click', async () => {
    try {
        const stream = await navigator.mediaDevices.getDisplayMedia({
            video: { frameRate: { ideal: 30, max: 30 } },
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

            const savedRoi = localStorage.getItem('anvil_roi_config');
            const savedBaseImg = localStorage.getItem('anvil_base_img');

            if (savedRoi && savedBaseImg) {
                try {
                    const parsed = JSON.parse(savedRoi);
                    if (parsed && parsed.w > 30 && parsed.h > 30) {
                        roi = parsed;
                        const img = new Image();
                        img.onload = () => {
                            cropCanvas.width = roi.w;
                            cropCanvas.height = roi.h;
                            cropCtx.drawImage(img, 0, 0);

                            let srcRoi = cv.imread(cropCanvas);
                            let srcRGB = new cv.Mat();
                            cv.cvtColor(srcRoi, srcRGB, cv.COLOR_RGBA2RGB);

                            if (baseColorMat) baseColorMat.delete();
                            baseColorMat = srcRGB.clone();
                            isBaseCaptured = true;

                            currentState = 'WAIT_CLOSE';
                            resetStateData();
                            statusText.innerText = "저장된 모루 로드 완료. 모루 창을 한번 닫아주세요.";

                            srcRGB.delete();
                            srcRoi.delete();
                        };
                        img.src = savedBaseImg;
                    }
                } catch (e) {}
            }

            requestAnimationFrame(processFrame);
        });

    } catch (err) {
        statusText.innerText = "화면 공유 취소";
    }
});

pipToggle.addEventListener('change', async () => {
    if (pipToggle.checked) {
        try {
            const stream = pipCanvas.captureStream(30);
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
        if (roi && roi.w > 30 && roi.h > 30) {
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

    const baseDataUrl = cropCanvas.toDataURL('image/png');
    localStorage.setItem('anvil_roi_config', JSON.stringify(roi));
    localStorage.setItem('anvil_base_img', baseDataUrl);

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
    if (video.readyState !== 4 || video.paused || video.ended) {
        requestAnimationFrame(processFrame);
        return;
    }

    ctx.drawImage(video, 0, 0, canvas.width, canvas.height);

    if (isDragging && roi) {
        ctx.strokeStyle = "#FF3366";
        ctx.lineWidth = 3;
        ctx.setLineDash([6, 6]);
        ctx.strokeRect(roi.x, roi.y, roi.w, roi.h);
        ctx.setLineDash([]);
    }

    if (roi && isBaseCaptured) {
        let allocatedMats = [];

        try {
            cropCanvas.width = roi.w;
            cropCanvas.height = roi.h;
            cropCtx.drawImage(canvas, roi.x, roi.y, roi.w, roi.h, 0, 0, roi.w, roi.h);

            let roiMat = cv.imread(cropCanvas);
            allocatedMats.push(roiMat);

            let currentRGB = new cv.Mat();
            allocatedMats.push(currentRGB);
            cv.cvtColor(roiMat, currentRGB, cv.COLOR_RGBA2RGB);

            // 1. 프레임 차분
            let diffRGB = new cv.Mat();
            allocatedMats.push(diffRGB);
            cv.absdiff(currentRGB, baseColorMat, diffRGB);

            let diffGray = new cv.Mat();
            allocatedMats.push(diffGray);
            cv.cvtColor(diffRGB, diffGray, cv.COLOR_RGB2GRAY);

            let threshMat = new cv.Mat();
            allocatedMats.push(threshMat);
            cv.threshold(diffGray, threshMat, 35, 255, cv.THRESH_BINARY);

            // 2. 채도 필터링
            let currentHSV = new cv.Mat();
            allocatedMats.push(currentHSV);
            cv.cvtColor(currentRGB, currentHSV, cv.COLOR_RGB2HSV);

            let hsvPlanes = new cv.MatVector();
            allocatedMats.push(hsvPlanes);
            cv.split(currentHSV, hsvPlanes);

            let satMat = hsvPlanes.get(1);
            allocatedMats.push(satMat);

            let satThreshMat = new cv.Mat();
            allocatedMats.push(satThreshMat);
            cv.threshold(satMat, satThreshMat, 40, 255, cv.THRESH_BINARY);

            let finalThreshMat = new cv.Mat();
            allocatedMats.push(finalThreshMat);
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
                    allocatedMats.push(contours, hierarchy);

                    cv.findContours(finalThreshMat, contours, hierarchy, cv.RETR_EXTERNAL, cv.CHAIN_APPROX_SIMPLE);

                    let bestCandidate = null;
                    let maxArea = 0;
                    const isCooldownReady = !lastPinTimestamp || (now - lastPinTimestamp >= MIN_PIN_INTERVAL_MS);

                    for (let i = 0; i < contours.size(); ++i) {
                        let cnt = contours.get(i);
                        let area = cv.contourArea(cnt);

                        if (area > 50 && area < 5000) {
                            let M = cv.moments(cnt, true);
                            if (M.m00 > 0) {
                                let cx = Math.round(M.m10 / M.m00) + roi.x;
                                let cy = Math.round(M.m01 / M.m00) + roi.y;

                                let isDuplicate = pinSequence.some(pin => {
                                    return Math.hypot(pin.x - cx, pin.y - cy) < DUPLICATE_DIST_PX;
                                });

                                if (!isDuplicate && area > maxArea) {
                                    maxArea = area;
                                    bestCandidate = { x: cx, y: cy };
                                }
                            }
                        }
                    }

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
        } catch (err) {
            console.warn("Frame processing error bypassed:", err);
        } finally {
            allocatedMats.forEach(mat => {
                if (mat && typeof mat.delete === 'function') {
                    try { mat.delete(); } catch(e) {}
                }
            });
        }
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
    if (!roi || !roi.w || !roi.h) return;

    pins.sort((a, b) => a.num - b.num);

    const now = Date.now();
    const baseRadius = customRadiusPx;

    if (pins.length > 1) {
        ctx.beginPath();
        ctx.moveTo(pins[0].x, pins[0].y);
        for (let i = 1; i < pins.length; i++) {
            ctx.lineTo(pins[i].x, pins[i].y);
        }
        ctx.strokeStyle = "rgba(0, 230, 118, 0.8)";
        ctx.lineWidth = Math.max(2, baseRadius * 0.2);
        ctx.lineJoin = "round";
        ctx.stroke();

        const arrowSpacing = Math.max(16, baseRadius * 1.6);
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
                if (d < baseRadius || d > dist - baseRadius) continue;

                const ax = p1.x + ux * d;
                const ay = p1.y + uy * d;

                ctx.save();
                ctx.translate(ax, ay);
                ctx.rotate(angle);

                ctx.beginPath();
                ctx.moveTo(4, 0);
                ctx.lineTo(-3, -3);
                ctx.lineTo(-1, 0);
                ctx.lineTo(-3, 3);
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
        const radius = isStart ? baseRadius * 1.25 : baseRadius;
        const fillColor = isStart ? "#FF1744" : "#00E676";
        const textColor = isStart ? "#FFFFFF" : "#000000";
        const fontSize = Math.max(9, Math.round(radius * 1.05));

        if (isStart) {
            ctx.beginPath();
            ctx.arc(pin.x, pin.y, radius + (baseRadius * 0.25), 0, Math.PI * 2);
            ctx.fillStyle = "rgba(255, 23, 68, 0.35)";
            ctx.fill();
        }

        ctx.beginPath();
        ctx.arc(pin.x, pin.y, radius, 0, Math.PI * 2);
        ctx.fillStyle = fillColor;
        ctx.fill();
        ctx.lineWidth = Math.max(1.5, radius * 0.12);
        ctx.strokeStyle = "#000000";
        ctx.stroke();

        ctx.fillStyle = textColor;
        ctx.font = `bold ${fontSize}px sans-serif`;
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
