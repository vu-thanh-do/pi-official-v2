const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const cluster = require('cluster');
const express = require('express');
const bodyParser = require('body-parser');
const { handleComment } = require('./src/controllers/comments');
const { handleLike } = require('./src/controllers/like');
const { handlePostArticles } = require('./src/controllers/posts');
const handleDelete = require('./src/controllers/delete');
const { handlePiKnow } = require('./src/controllers/piKnow');
const handleLikeEachOther = require('./src/controllers/likeEachOther');
const handleLogin = require('./src/controllers/login');
const { startRotation, stopRotation, rotationProgress } = require('./src/controllers/rotation');
const getPort = require('get-port');

let mainWindow;
let logWindow;
let expressServer;
let serverPort;
let isSequentialRunning = false;
let shouldStopSequential = false;

// Thiết lập đường dẫn cluster worker
cluster.setupMaster({
    exec: path.join(__dirname, 'src/controllers/worker-processor.js')
});

// Ghi đè console.log để gửi log tới cửa sổ log
const originalConsoleLog = console.log;
const originalConsoleError = console.error;

console.log = function() {
    const args = Array.from(arguments);
    const message = args.map(arg => typeof arg === 'object' ? JSON.stringify(arg) : arg).join(' ');
    if (logWindow && logWindow.webContents) {
        logWindow.webContents.send('new-log', { type: 'info', message });
    }
    originalConsoleLog.apply(console, arguments);
};

console.error = function() {
    const args = Array.from(arguments);
    const message = args.map(arg => typeof arg === 'object' ? JSON.stringify(arg) : arg).join(' ');
    if (logWindow && logWindow.webContents) {
        logWindow.webContents.send('new-log', { type: 'error', message });
    }
    originalConsoleError.apply(console, arguments);
};

// Xử lý khi worker gửi message về master
cluster.on('message', (worker, message) => {
    if (message.type === 'log') {
        console.log(`[Worker ${worker.id}] ${message.data}`);
    }
});

// Xử lý khi worker thoát
cluster.on('exit', (worker, code, signal) => {
    console.log(`Worker ${worker.process.pid} đã thoát với code: ${code} và signal: ${signal}`);
    // Khởi động lại worker nếu exit không phải do kill chủ động
    if (code !== 0 && !worker.exitedAfterDisconnect) {
        console.log(`Khởi động lại worker ${worker.id}...`);
        cluster.fork();
    }
});

function createLogWindow() {
    logWindow = new BrowserWindow({
        width: 800,
        height: 600,
        title: 'Log Viewer',
        webPreferences: {
            nodeIntegration: true,
            contextIsolation: false
        }
    });

    logWindow.loadFile('src/views/log.html');
    
    logWindow.on('closed', () => {
        logWindow = null;
    });
}

function createMainWindow() {
    mainWindow = new BrowserWindow({
        width: 1000,
        height: 800,
        webPreferences: {
            nodeIntegration: true,
            contextIsolation: false
        }
    });

    mainWindow.loadFile('src/views/mode-select.html');
    
    // Đợi cho đến khi trang load xong mới inject biến SERVER_PORT
    mainWindow.webContents.on('did-finish-load', () => {
        mainWindow.webContents.executeJavaScript(`
            window.SERVER_PORT = ${serverPort};
            localStorage.setItem('SERVER_PORT', ${serverPort});
        `);
    });

    mainWindow.on('closed', () => {
        mainWindow = null;
        if (logWindow) logWindow.close();
        app.quit();
    });
}

// Khởi động server Express
async function startExpressServer() {
    // Tìm port trống
    const port = await getPort();
    serverPort = port;
    
    // Khởi tạo Express server
    const server = express();
    server.use(bodyParser.json());

    // Xử lý API
    server.post('/execute-tasks', async (req, res) => {
        try {
            console.log('Bắt đầu thực hiện các tác vụ...');
            const { commentCount, likeCount, deleteCount, postCount, piKnow, likeEachOther, login } = req.body;
            let tasks = [];

            if (login > 0) {
                console.log(`Thực hiện đăng nhập ${login} tài khoản...`);
                tasks.push(handleLogin(login));
            }
            if (commentCount > 0) {
                console.log(`Thực hiện comment ${commentCount} lần...`);
                tasks.push(handleComment(commentCount));
            }
            if (likeCount > 0) {
                console.log(`Thực hiện like ${likeCount} lần...`);
                tasks.push(handleLike(likeCount));
            }
            if (deleteCount > 0) {
                console.log(`Thực hiện xóa ${deleteCount} bài...`);
                tasks.push(handleDelete(deleteCount));
            }
            if (postCount > 0) {
                console.log(`Thực hiện đăng ${postCount} bài...`);
                tasks.push(handlePostArticles(postCount));
            }
            if (piKnow > 0) {
                console.log(`Thực hiện comment PiKnow ${piKnow} lần...`);
                tasks.push(handlePiKnow(piKnow));
            }
            if (likeEachOther > 0) {
                console.log(`Thực hiện like chéo ${likeEachOther} lần...`);
                tasks.push(handleLikeEachOther(likeEachOther));
            }

            const results = await Promise.allSettled(tasks);
            const successCount = results.filter(r => r.status === "fulfilled").length;
            const failCount = results.filter(r => r.status === "rejected").length;

            res.json({
                success: true,
                message: `Hoàn thành ${successCount} tác vụ, ${failCount} thất bại.`,
                details: results
            });
        } catch (error) {
            console.error('Lỗi:', error.message);
            res.json({ success: false, message: "Lỗi khi chạy tác vụ.", error: error.message });
        }
    });

    // Endpoint để dừng tiến trình tuần tự
    server.post('/stop-sequential', (req, res) => {
        if (!isSequentialRunning) {
            return res.json({
                success: false,
                message: "Không có tiến trình nào đang chạy"
            });
        }

        shouldStopSequential = true;
        res.json({
            success: true,
            message: "Đã gửi yêu cầu dừng tiến trình"
        });
    });

    // Routes cho chế độ luân phiên
    server.post('/start-rotation', startRotation);
    server.post('/stop-rotation', stopRotation);
    server.get('/rotation-progress', rotationProgress);

    // Thêm route kiểm tra trạng thái cluster
    server.get('/cluster-status', (req, res) => {
        const workers = Object.values(cluster.workers || {}).map(worker => ({
            id: worker.id,
            pid: worker.process.pid,
            state: worker.state
        }));

        res.json({
            success: true,
            isMaster: true,
            workers: workers,
            totalWorkers: workers.length,
            pid: process.pid
        });
    });

    expressServer = server.listen(port, () => {
        console.log(`Server đang chạy tại port ${port} (PID: ${process.pid})`);
    });
    
    return port;
}

// Chỉ khởi động Electron trong master process
if (cluster.isPrimary) {
    console.log(`Master process ${process.pid} đang chạy`);
    
    app.whenReady().then(async () => {
        // Khởi động Express server trước
        await startExpressServer();
        
        // Sau đó khởi động các cửa sổ Electron
        createMainWindow();
        createLogWindow();
    });

    app.on('window-all-closed', () => {
        if (process.platform !== 'darwin') {
            app.quit();
        }
    });

    app.on('activate', () => {
        if (mainWindow === null) createMainWindow();
        if (logWindow === null) createLogWindow();
    });

    app.on('quit', () => {
        // Đảm bảo tất cả worker processes đều được tắt
        console.log('Đang dừng tất cả worker processes...');
        for (const id in cluster.workers) {
            console.log(`Kết thúc worker ${id}...`);
            cluster.workers[id].kill();
        }
    });
} 